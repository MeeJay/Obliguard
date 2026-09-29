import crypto from 'crypto';
import { logger } from '../../utils/logger';

/**
 * Client Microsoft Graph, Exchange Online et Management Activity API en app-only.
 *
 * L'authentification se fait par certificat (assertion JWT signée RS256), jamais
 * par secret client ni par mot de passe : Obliguard détient la clé privée, seule
 * la clé publique est déposée dans le tenant du client lors de l'enrôlement.
 *
 * Le client est volontairement sans dépendance : construire l'assertion tient en
 * une signature RSA, et MSAL apporterait surtout du cache et des reprises que ce
 * fichier gère déjà, en restant lisible.
 */

// ── Ressources ───────────────────────────────────────────────────────────────

/** Audiences appelées par le module. Chacune a son propre jeton et son propre cache. */
export const GRAPH_RESOURCE = 'https://graph.microsoft.com';
export const EXO_RESOURCE = 'https://outlook.office365.com';
export const MANAGE_RESOURCE = 'https://manage.office.com';

export type M365Resource = typeof GRAPH_RESOURCE | typeof EXO_RESOURCE | typeof MANAGE_RESOURCE;

// ── Types ────────────────────────────────────────────────────────────────────

export interface M365Credentials {
  /** Identifiant du tenant Entra du client (GUID, ou domaine vérifié). */
  entraTenantId: string;
  /** Identifiant de l'inscription d'application créée dans ce tenant. */
  clientId: string;
  /** Clé privée au format PEM, déjà déchiffrée par l'appelant. */
  privateKeyPem: string;
  /** Empreinte SHA-1 du certificat, en hexadécimal, telle qu'Entra l'expose. */
  certificateThumbprint: string;
}

export interface GraphRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  resource?: M365Resource;
  /** En-têtes additionnels, par exemple ConsistencyLevel pour les requêtes avancées. */
  headers?: Record<string, string>;
  /** Délai maximal d'une tentative, hors attentes entre reprises. */
  timeoutMs?: number;
}

/**
 * Échec d'un appel M365. `status` permet de distinguer les cas que le module
 * traite différemment : 403 signale une permission absente, ce dont F-DATA-01
 * doit rendre compte au lieu de conclure que le tenant est sain.
 */
export class M365ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly resource: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'M365ApiError';
  }

  /** Permission applicative absente ou consentement non accordé. */
  get isPermissionDenied(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** L'objet visé n'existe pas ou n'est pas exposé sur cette licence. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

interface CachedToken {
  token: string;
  /** Instant d'expiration en millisecondes epoch, marge de sécurité déjà retranchée. */
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

interface ODataPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

// ── Réglages ─────────────────────────────────────────────────────────────────

/** Un jeton est renouvelé avant son expiration réelle, pour absorber l'horloge et le trajet. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
/** Durée de validité de l'assertion. Entra refuse au-delà de dix minutes. */
const ASSERTION_LIFETIME_S = 9 * 60;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
/** Plafond d'attente entre deux tentatives, même si le serveur demande plus. */
const MAX_BACKOFF_MS = 60_000;
/** Garde-fou de pagination : au-delà, on soupçonne une boucle de nextLink. */
const MAX_PAGES = 1000;

// ── Client ───────────────────────────────────────────────────────────────────

const base64url = (buf: Buffer): string => buf.toString('base64url');

class GraphClient {
  /** Jetons valides, par tenant, application et ressource. */
  private readonly tokens = new Map<string, CachedToken>();
  /** Acquisitions en cours, pour qu'un pic de requêtes ne déclenche qu'un seul aller-retour. */
  private readonly inFlight = new Map<string, Promise<string>>();

  // ── Jetons ─────────────────────────────────────────────────────────────────

  /**
   * Construit l'assertion JWT qui prouve la possession de la clé privée.
   * L'en-tête porte `x5t`, l'empreinte du certificat, qui dit à Entra laquelle
   * des clés publiques déposées sur l'application il doit utiliser pour vérifier.
   */
  private buildAssertion(creds: M365Credentials): string {
    const now = Math.floor(Date.now() / 1000);
    const thumbprint = creds.certificateThumbprint.replace(/[^0-9a-fA-F]/g, '');
    if (thumbprint.length !== 40) {
      throw new Error(`Empreinte de certificat invalide pour le client ${creds.clientId}`);
    }

    const header = {
      alg: 'RS256',
      typ: 'JWT',
      x5t: base64url(Buffer.from(thumbprint, 'hex')),
    };
    const payload = {
      aud: `https://login.microsoftonline.com/${creds.entraTenantId}/oauth2/v2.0/token`,
      iss: creds.clientId,
      sub: creds.clientId,
      jti: crypto.randomUUID(),
      nbf: now - 60,
      exp: now + ASSERTION_LIFETIME_S,
    };

    const signingInput =
      `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`;
    const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(creds.privateKeyPem);
    return `${signingInput}.${base64url(signature)}`;
  }

  private cacheKey(creds: M365Credentials, resource: M365Resource): string {
    return `${creds.entraTenantId}:${creds.clientId}:${resource}`;
  }

  /** Renvoie un jeton valide, depuis le cache quand c'est possible. */
  async getAccessToken(creds: M365Credentials, resource: M365Resource = GRAPH_RESOURCE): Promise<string> {
    const key = this.cacheKey(creds, resource);

    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    // Une acquisition est déjà partie pour cette clé : s'y raccrocher plutôt que
    // d'en lancer une seconde. Sans cela, un scan qui démarre déclenche autant
    // d'appels au point de terminaison que de contrôles lancés en parallèle.
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const request = this.requestToken(creds, resource, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private async requestToken(creds: M365Credentials, resource: M365Resource, key: string): Promise<string> {
    const url = `https://login.microsoftonline.com/${creds.entraTenantId}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      client_id: creds.clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: this.buildAssertion(creds),
      scope: `${resource}/.default`,
      grant_type: 'client_credentials',
    });

    const res = await this.fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      },
      resource,
      '/oauth2/v2.0/token',
    );

    const data = (await res.json()) as TokenResponse;
    if (!data.access_token) {
      throw new M365ApiError('Réponse de jeton sans access_token', res.status, null, resource, '/oauth2/v2.0/token');
    }

    this.tokens.set(key, {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS,
    });
    return data.access_token;
  }

  /** Oublie les jetons d'un tenant, après une rotation de certificat ou un retrait de consentement. */
  invalidateTokens(entraTenantId: string): void {
    for (const key of this.tokens.keys()) {
      if (key.startsWith(`${entraTenantId}:`)) this.tokens.delete(key);
    }
  }

  // ── Requêtes ───────────────────────────────────────────────────────────────

  /**
   * Rejoue une requête sur les réponses 429 et 5xx, en respectant `Retry-After`
   * quand le serveur en fournit un. Microsoft limite agressivement les lectures
   * d'audit : sans reprise, un scan de posture échoue dès que plusieurs tenants
   * sont interrogés dans la même minute.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    resource: string,
    path: string,
  ): Promise<Response> {
    let lastError: M365ApiError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        // Coupure réseau ou dépassement du délai : même traitement qu'un 503.
        lastError = new M365ApiError(
          `Appel ${path} injoignable : ${(err as Error).message}`,
          503,
          'network',
          resource,
          path,
        );
        if (attempt === MAX_ATTEMPTS) throw lastError;
        await this.sleep(this.backoffMs(attempt, null));
        continue;
      }

      if (res.ok) return res;

      const retryable = res.status === 429 || res.status >= 500;
      const detail = await this.readError(res);

      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw new M365ApiError(detail.message, res.status, detail.code, resource, path);
      }

      const wait = this.backoffMs(attempt, res.headers.get('Retry-After'));
      logger.warn(
        { resource, path, status: res.status, attempt, waitMs: wait },
        'M365 : réponse temporaire, nouvelle tentative',
      );
      await this.sleep(wait);
    }

    // Inatteignable : la boucle sort par un retour ou une exception.
    throw lastError ?? new M365ApiError(`Échec de ${path}`, 500, null, resource, path);
  }

  private backoffMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
    // Exponentiel avec bruit, pour ne pas resynchroniser tous les tenants sur la même seconde.
    const base = Math.min(2 ** attempt * 500, MAX_BACKOFF_MS);
    return base + Math.floor(Math.random() * 500);
  }

  private async readError(res: Response): Promise<{ message: string; code: string | null }> {
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string } | string;
        error_description?: string;
      };
      if (typeof body.error === 'string') {
        return { message: body.error_description ?? body.error, code: body.error };
      }
      if (body.error) {
        return { message: body.error.message ?? res.statusText, code: body.error.code ?? null };
      }
    } catch {
      // Corps absent ou illisible : le statut HTTP suffit à qualifier l'échec.
    }
    return { message: `HTTP ${res.status} ${res.statusText}`, code: null };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Appelle un chemin d'API. `path` peut être relatif (« /users ») ou absolu,
   * ce qui permet de suivre un `@odata.nextLink` sans le retraiter.
   */
  async request<T>(creds: M365Credentials, path: string, options: GraphRequestOptions = {}): Promise<T> {
    const resource = options.resource ?? GRAPH_RESOURCE;
    const token = await this.getAccessToken(creds, resource);
    const url = path.startsWith('http')
      ? path
      : `${resource}${resource === GRAPH_RESOURCE ? '/v1.0' : ''}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...options.headers,
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetchWithRetry(
      url,
      {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
      resource,
      path,
    );

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * Parcourt toutes les pages d'une collection OData et renvoie les éléments concaténés.
   * À réserver aux collections bornées, comme les utilisateurs ou les rôles d'un
   * tenant PME ; les flux d'audit se lisent par curseur, pas par accumulation.
   */
  async getAll<T>(creds: M365Credentials, path: string, options: GraphRequestOptions = {}): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;

    for (let page = 0; next && page < MAX_PAGES; page++) {
      const body: ODataPage<T> = await this.request<ODataPage<T>>(creds, next, options);
      if (Array.isArray(body.value)) items.push(...body.value);
      next = body['@odata.nextLink'];
    }

    if (next) {
      logger.warn({ path, pages: MAX_PAGES }, 'M365 : pagination interrompue au garde-fou');
    }
    return items;
  }

  /**
   * Variante tolérante : renvoie `null` au lieu de lever quand l'objet n'existe
   * pas ou que la permission manque. Un contrôle de posture qui interroge une
   * ressource par utilisateur ne doit pas s'arrêter au premier refus.
   */
  async tryRequest<T>(
    creds: M365Credentials,
    path: string,
    options: GraphRequestOptions = {},
  ): Promise<T | null> {
    try {
      return await this.request<T>(creds, path, options);
    } catch (err) {
      if (err instanceof M365ApiError && (err.isNotFound || err.isPermissionDenied)) {
        logger.debug({ path, status: err.status, code: err.code }, 'M365 : ressource inaccessible, ignorée');
        return null;
      }
      throw err;
    }
  }
}

export const graphClient = new GraphClient();
