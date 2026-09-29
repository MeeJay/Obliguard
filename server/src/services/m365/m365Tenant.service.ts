import crypto from 'crypto';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { encryptSecret, decryptSecret } from '../../utils/crypto';
import { generateCertificate } from './certificate';
import { graphClient, GRAPH_RESOURCE, M365ApiError, type M365Credentials } from './graphClient';
import { PERMISSION_PROBES, readPermissionNames } from './permissions';
import type {
  CreateM365TenantRequest,
  UpdateM365TenantRequest,
  M365EnrolmentInstructions,
  M365EnrolmentVerification,
  M365LicenceProfile,
  M365SourceFreshness,
  M365Tenant,
  M365TenantSettings,
} from '@obliview/shared';

/**
 * Enregistrement et enrôlement des tenants Microsoft 365.
 *
 * Un tenant est une ligne d'`agent_devices` avec `device_type = 'm365'`, plus une
 * ligne de `m365_tenants`, sur le modèle exact des équipements MikroTik.
 *
 * L'enrôlement se fait en trois temps :
 *   1. `create` enregistre le tenant et fabrique la paire de clés. Aucun appel
 *      à Microsoft : le tenant existe dans Obliguard mais n'est pas encore relié.
 *   2. `issueEnrolmentToken` rend un jeton à usage unique et la commande à lancer.
 *      Le script crée l'inscription d'application dans le tenant client, téléverse
 *      le certificat, assigne les permissions et déclenche le consentement admin.
 *   3. `completeEnrolment`, appelé par le script avec ce jeton, enregistre
 *      `entra_tenant_id` et `client_id`, puis sonde les permissions obtenues.
 *
 * La clé privée est chiffrée dès sa création et ne sort jamais du serveur. Aucun
 * mot de passe d'administrateur n'est collecté à aucune étape.
 */

interface M365TenantRow {
  id: number;
  device_id: number;
  entra_tenant_id: string | null;
  primary_domain: string | null;
  client_id: string | null;
  cert_private_key_enc: string | null;
  cert_public_pem: string | null;
  cert_thumbprint: string | null;
  cert_not_after: Date | null;
  licence_profile: M365LicenceProfile | null;
  has_write_consent: boolean;
  exo_worker_enabled: boolean;
  exo_role_assigned: boolean;
  last_posture_at: Date | null;
  last_signin_at: Date | null;
  last_ual_cursor: unknown | null;
  last_ual_event_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  settings: M365TenantSettings | null;
  created_at: Date;
  updated_at: Date;
}

/** Validité du jeton d'enrôlement : le temps de lancer le script, pas davantage. */
const ENROLMENT_TOKEN_TTL_MS = 60 * 60 * 1000;

const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

export const m365TenantService = {
  /**
   * Enregistre un tenant et fabrique sa paire de clés.
   *
   * Le domaine principal sert de nom d'hôte de l'équipement, ce qui le rend
   * reconnaissable partout où Obliguard liste des équipements sans savoir ce
   * qu'ils sont.
   */
  async create(
    data: CreateM365TenantRequest,
    tenantId: number,
    createdBy: number,
  ): Promise<{ deviceId: number; uuid: string }> {
    const domain = data.primaryDomain.trim().toLowerCase();
    if (!domain) throw new Error('Le domaine principal est obligatoire');

    // Un domaine ne peut être enrôlé qu'une fois. Le contrôle porte aussi sur les
    // tenants non encore reliés, pour éviter deux enregistrements concurrents du
    // même client ; l'unicité d'entra_tenant_id, elle, est garantie par le schéma.
    const existing = await db('m365_tenants').where('primary_domain', domain).first();
    if (existing) {
      throw new Error(`Le domaine "${domain}" est déjà enregistré sur cette instance`);
    }

    const uuid = crypto.randomUUID();
    const now = new Date();
    const cert = await generateCertificate(`obliguard-m365-${domain}`);

    const [device] = await db('agent_devices')
      .insert({
        uuid,
        hostname: domain,
        tenant_id: tenantId,
        name: data.name,
        device_type: 'm365',
        // Pas d'approbation en attente : l'équipement est créé par un administrateur.
        status: 'approved',
        approved_by: createdBy,
        approved_at: now,
        group_id: data.groupId ?? null,
        // Un tenant M365 n'envoie pas de heartbeat : sa santé se mesure à la
        // fraîcheur de ses sources, pas à une absence de battement.
        heartbeat_monitoring: false,
        check_interval_seconds: 300,
        os_info: JSON.stringify({ platform: 'm365', distro: 'Microsoft 365', release: null, arch: 'cloud' }),
        created_at: now,
        updated_at: now,
      })
      .returning('id');

    const deviceId = typeof device === 'object' ? (device as { id: number }).id : (device as number);

    await db('m365_tenants').insert({
      device_id: deviceId,
      primary_domain: domain,
      cert_private_key_enc: encryptSecret(cert.privateKeyPem),
      cert_public_pem: cert.certificatePem,
      cert_thumbprint: cert.thumbprint,
      cert_not_after: cert.notAfter,
      settings: JSON.stringify({}),
      created_at: now,
      updated_at: now,
    });

    logger.info({ deviceId, domain, thumbprint: cert.thumbprint }, 'Tenant M365 enregistré');
    return { deviceId, uuid };
  },

  /**
   * Émet un jeton d'enrôlement à usage unique et renvoie la commande à lancer.
   *
   * Le jeton n'est stocké que haché : un jeton lu dans la base ne doit pas être
   * rejouable, même règle que les jetons de réinitialisation de mot de passe.
   * Les jetons antérieurs encore valides sont révoqués, pour qu'un enrôlement
   * relancé n'en laisse pas traîner.
   */
  async issueEnrolmentToken(
    deviceId: number,
    createdBy: number,
    publicOrigin: string,
  ): Promise<M365EnrolmentInstructions> {
    const row = await db<M365TenantRow>('m365_tenants').where('device_id', deviceId).first();
    if (!row) throw new Error('Tenant M365 introuvable');
    if (!row.cert_public_pem || !row.cert_thumbprint) {
      throw new Error('Le certificat de ce tenant est absent : recréer le tenant');
    }

    await db('m365_enrolment_tokens').where('device_id', deviceId).whereNull('used_at').del();

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ENROLMENT_TOKEN_TTL_MS);

    await db('m365_enrolment_tokens').insert({
      device_id: deviceId,
      token_hash: hashToken(token),
      expires_at: expiresAt,
      created_by: createdBy,
      created_at: new Date(),
    });

    const base = publicOrigin.replace(/\/$/, '');
    // Le script est servi par l'instance elle-même : l'opérateur n'a rien à
    // télécharger au préalable, et la version du script suit celle du serveur.
    const command =
      `$s = Invoke-RestMethod '${base}/api/m365/enrol/script'; ` +
      `Invoke-Expression $s; ` +
      `Register-ObliguardM365 -Server '${base}' -Token '${token}'`;

    logger.info({ deviceId, expiresAt }, "Jeton d'enrôlement M365 émis");

    return {
      deviceId,
      token,
      expiresAt: expiresAt.toISOString(),
      certificatePem: row.cert_public_pem,
      certThumbprint: row.cert_thumbprint,
      command,
    };
  },

  /**
   * Résout un jeton d'enrôlement en ce que le script doit appliquer.
   *
   * Le jeton est validé sans être consommé : si le script échoue à mi-parcours,
   * par exemple faute du module PowerShell attendu, l'opérateur doit pouvoir le
   * relancer sans repasser par l'interface.
   */
  async getEnrolmentPlan(token: string): Promise<{
    deviceId: number;
    appDisplayName: string;
    primaryDomain: string;
    certificatePem: string;
    certThumbprint: string;
  } | null> {
    const tokenRow = await db('m365_enrolment_tokens')
      .where('token_hash', hashToken(token))
      .whereNull('used_at')
      .where('expires_at', '>', new Date())
      .first();
    if (!tokenRow) return null;

    const row = await db<M365TenantRow>('m365_tenants').where('device_id', tokenRow.device_id).first();
    if (!row || !row.cert_public_pem || !row.cert_thumbprint) return null;

    const domain = row.primary_domain ?? String(row.device_id);
    return {
      deviceId: row.device_id,
      appDisplayName: `Obliguard M365 Guard (${domain})`,
      primaryDomain: domain,
      certificatePem: row.cert_public_pem,
      certThumbprint: row.cert_thumbprint,
    };
  },

  /**
   * Termine l'enrôlement depuis le script, authentifié par le jeton seul.
   *
   * Le jeton est consommé avant toute autre écriture : même si la vérification
   * des permissions échoue ensuite, il n'est pas rejouable. Renvoie le résultat
   * du sondage pour que le script l'affiche à l'opérateur.
   */
  async completeEnrolment(
    token: string,
    entraTenantId: string,
    clientId: string,
    exchangeRoleAssigned: boolean,
  ): Promise<M365EnrolmentVerification & { deviceId: number }> {
    const tokenRow = await db('m365_enrolment_tokens')
      .where('token_hash', hashToken(token))
      .whereNull('used_at')
      .where('expires_at', '>', new Date())
      .first();
    if (!tokenRow) throw new Error("Jeton d'enrôlement invalide, expiré ou déjà utilisé");

    const deviceId: number = tokenRow.device_id;
    await db('m365_enrolment_tokens').where('id', tokenRow.id).update({ used_at: new Date() });

    await db('m365_tenants').where('device_id', deviceId).update({
      entra_tenant_id: entraTenantId,
      client_id: clientId,
      exo_role_assigned: exchangeRoleAssigned,
      last_error: null,
      last_error_at: null,
      updated_at: new Date(),
    });

    logger.info(
      { deviceId, entraTenantId, clientId, exchangeRoleAssigned },
      'Enrôlement M365 terminé, vérification en cours',
    );

    const verification = await this.verifyPermissions(deviceId);
    return { ...verification, deviceId };
  },

  /**
   * Charge les identifiants d'appel d'un tenant, clé privée déchiffrée.
   * Usage strictement interne : ce que renvoie cette fonction ne doit jamais
   * atteindre une réponse HTTP.
   */
  async getCredentials(deviceId: number): Promise<M365Credentials | null> {
    const row = await db<M365TenantRow>('m365_tenants').where('device_id', deviceId).first();
    if (!row || !row.entra_tenant_id || !row.client_id || !row.cert_private_key_enc || !row.cert_thumbprint) {
      return null;
    }
    try {
      return {
        entraTenantId: row.entra_tenant_id,
        clientId: row.client_id,
        privateKeyPem: decryptSecret(row.cert_private_key_enc),
        certificateThumbprint: row.cert_thumbprint,
      };
    } catch (err) {
      // Clé illisible : typiquement un SESSION_SECRET changé après l'enrôlement.
      logger.error({ deviceId, err }, 'Clé privée M365 indéchiffrable');
      return null;
    }
  },

  /**
   * Sonde les permissions réellement obtenues et en déduit la licence.
   *
   * On vérifie par l'appel, pas en relisant les consentements : un consentement
   * peut figurer dans l'annuaire sans que l'appel passe, par exemple quand le
   * rôle Exchange n'a pas été attribué au principal de service.
   */
  async verifyPermissions(deviceId: number): Promise<M365EnrolmentVerification> {
    const row = await db<M365TenantRow>('m365_tenants').where('device_id', deviceId).first();
    const exoRoleAssigned = Boolean(row?.exo_role_assigned);
    const creds = await this.getCredentials(deviceId);
    if (!creds) {
      return { ok: false, licenceProfile: null, exoRoleAssigned, grantedScopes: [], missingScopes: readPermissionNames(), error: 'Tenant non enrôlé' };
    }

    // Un échec d'acquisition de jeton est sans ambiguïté : certificat non
    // téléversé, consentement non accordé, ou application supprimée.
    try {
      await graphClient.getAccessToken(creds, GRAPH_RESOURCE);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.recordError(deviceId, `Acquisition de jeton impossible : ${message}`);
      return { ok: false, licenceProfile: null, exoRoleAssigned, grantedScopes: [], missingScopes: readPermissionNames(), error: message };
    }

    const granted: string[] = [];
    const missing: string[] = [];
    let licence: M365LicenceProfile = 'free';

    for (const probe of PERMISSION_PROBES) {
      try {
        await graphClient.request(creds, probe.path, { resource: probe.resource });
        granted.push(probe.permission);
        if (probe.requiresLicence === 'p1' && licence === 'free') licence = 'p1';
        if (probe.requiresLicence === 'p2') licence = 'p2';
      } catch (err) {
        if (err instanceof M365ApiError && err.isPermissionDenied) {
          // Une sonde facultative refusée décrit la licence, pas une erreur de
          // configuration : sur un tenant gratuit, les journaux de connexion
          // répondent 403 même avec AuditLog.Read.All accordé.
          if (!probe.optional) missing.push(probe.permission);
          continue;
        }
        if (err instanceof M365ApiError && err.isNotFound) {
          // Objet absent mais lecture autorisée : la permission est bien là.
          granted.push(probe.permission);
          continue;
        }
        throw err;
      }
    }

    const now = new Date();
    await db('m365_tenants').where('device_id', deviceId).update({
      licence_profile: licence,
      last_error: missing.length ? `Permissions manquantes : ${missing.join(', ')}` : null,
      last_error_at: missing.length ? now : null,
      updated_at: now,
    });

    logger.info({ deviceId, licence, granted: granted.length, missing }, 'Permissions M365 vérifiées');
    // Un rôle Exchange absent ne rend pas l'enrôlement invalide, mais il retire
    // du périmètre tous les contrôles P-EXO : l'appelant doit pouvoir le dire.
    return { ok: missing.length === 0, licenceProfile: licence, exoRoleAssigned, grantedScopes: granted, missingScopes: missing };
  },

  /** Consigne une erreur d'accès, pour que l'interface et F-DATA-01 la montrent. */
  async recordError(deviceId: number, message: string): Promise<void> {
    const now = new Date();
    await db('m365_tenants')
      .where('device_id', deviceId)
      .update({ last_error: message.slice(0, 2000), last_error_at: now, updated_at: now });
  },

  /** Renvoie le tenant sans aucun matériel secret. */
  async get(deviceId: number): Promise<M365Tenant | null> {
    const row = await db<M365TenantRow>('m365_tenants').where('device_id', deviceId).first();
    return row ? toApi(row) : null;
  },

  async update(deviceId: number, data: UpdateM365TenantRequest): Promise<void> {
    const updates: Record<string, unknown> = { updated_at: new Date() };

    if (data.primaryDomain !== undefined) updates.primary_domain = data.primaryDomain.trim().toLowerCase();
    if (data.exoWorkerEnabled !== undefined) updates.exo_worker_enabled = data.exoWorkerEnabled;
    if (data.settings !== undefined) updates.settings = JSON.stringify(data.settings);

    await db('m365_tenants').where('device_id', deviceId).update(updates);
  },

  /**
   * Refabrique la paire de clés d'un tenant déjà enrôlé.
   *
   * Le tenant continue de fonctionner avec l'ancien certificat jusqu'à ce que le
   * script ait téléversé le nouveau : les jetons en cache restent valides et la
   * clé n'est remplacée qu'ici, en une écriture. C'est ce qui permet une rotation
   * sans interruption, à condition de lancer le script dans l'heure.
   */
  async rotateCertificate(deviceId: number): Promise<{ certificatePem: string; certThumbprint: string }> {
    const row = await db<M365TenantRow>('m365_tenants').where('device_id', deviceId).first();
    if (!row) throw new Error('Tenant M365 introuvable');

    const cert = await generateCertificate(`obliguard-m365-${row.primary_domain ?? deviceId}`);
    await db('m365_tenants').where('device_id', deviceId).update({
      cert_private_key_enc: encryptSecret(cert.privateKeyPem),
      cert_public_pem: cert.certificatePem,
      cert_thumbprint: cert.thumbprint,
      cert_not_after: cert.notAfter,
      updated_at: new Date(),
    });
    if (row.entra_tenant_id) graphClient.invalidateTokens(row.entra_tenant_id);

    logger.info({ deviceId, thumbprint: cert.thumbprint }, 'Certificat M365 renouvelé');
    return { certificatePem: cert.certificatePem, certThumbprint: cert.thumbprint };
  },

  /** Purge les jetons d'enrôlement expirés ou consommés. */
  async purgeExpiredTokens(): Promise<number> {
    return db('m365_enrolment_tokens')
      .where('expires_at', '<', new Date())
      .orWhereNotNull('used_at')
      .del();
  },
};

// ── Projection ───────────────────────────────────────────────────────────────

function freshnessOf(row: M365TenantRow): M365SourceFreshness {
  const lastUal = row.last_ual_event_at;
  return {
    lastPostureAt: row.last_posture_at?.toISOString() ?? null,
    lastSignInAt: row.last_signin_at?.toISOString() ?? null,
    lastUalEventAt: lastUal?.toISOString() ?? null,
    ualLagHours: lastUal ? Math.floor((Date.now() - lastUal.getTime()) / 3_600_000) : null,
  };
}

function toApi(row: M365TenantRow): M365Tenant {
  return {
    id: row.id,
    deviceId: row.device_id,
    entraTenantId: row.entra_tenant_id,
    primaryDomain: row.primary_domain,
    clientId: row.client_id,
    certThumbprint: row.cert_thumbprint,
    certNotAfter: row.cert_not_after?.toISOString() ?? null,
    licenceProfile: row.licence_profile,
    hasWriteConsent: row.has_write_consent,
    exoWorkerEnabled: row.exo_worker_enabled,
    exoRoleAssigned: row.exo_role_assigned,
    freshness: freshnessOf(row),
    lastError: row.last_error,
    lastErrorAt: row.last_error_at?.toISOString() ?? null,
    settings: row.settings ?? {},
    enrolled: Boolean(row.entra_tenant_id && row.client_id),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
