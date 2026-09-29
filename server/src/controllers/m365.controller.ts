import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger';
import { requestAuthority, requestProto } from '../utils/publicOrigin';
import { checkDeviceAccess } from '../services/deviceAccess.service';
import { m365TenantService } from '../services/m365/m365Tenant.service';
import { certificateToBase64 } from '../services/m365/certificate';
import { enrolmentPermissionPlan, EXO_READ_ROLE, EXO_WRITE_ROLE } from '../services/m365/permissions';
import type { CreateM365TenantRequest, UpdateM365TenantRequest } from '@obliview/shared';

/**
 * Tenants Microsoft 365 : enregistrement, enrôlement et vérification.
 *
 * Deux familles de routes cohabitent :
 *   - celles à session, réservées aux administrateurs du tenant Obliguard ;
 *   - celles de l'enrôlement, authentifiées par le seul jeton à usage unique,
 *     parce que le script tourne sur le poste de l'opérateur sans session.
 */

/**
 * Origine publique de cette instance, pour construire la commande d'enrôlement.
 * Même ordre de préférence que le téléchargement d'agent : la valeur configurée
 * d'abord, l'en-tête Host seulement en dernier recours, puisqu'un client peut le
 * fabriquer.
 */
function inferServerUrl(req: Request): string {
  if (process.env.APP_URL) {
    try {
      const raw = process.env.APP_URL;
      return new URL(raw.includes('://') ? raw : `https://${raw}`).origin;
    } catch {
      // Valeur malformée : on retombe sur la requête.
    }
  }
  const authority = requestAuthority(req)?.authority ?? '';
  return authority ? `${requestProto(req)}://${authority}` : '';
}

/**
 * Garde d'isolation : l'équipement doit appartenir au tenant qui opère, et être
 * bien un tenant M365. Les identifiants d'un tenant ne sont jamais consultables
 * depuis le tenant Default, donc même les lectures passent par la règle d'écriture.
 * Renvoie l'identifiant de l'équipement, ou null si la réponse a déjà été émise.
 */
async function requireOwnM365(req: Request, res: Response): Promise<number | null> {
  const r = await checkDeviceAccess(req.params.id, req.tenantId, 'write');
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return null;
  }
  if (r.row.device_type !== 'm365') {
    res.status(404).json({ error: 'Tenant M365 not found' });
    return null;
  }
  return r.row.id;
}

// ── Routes à session ─────────────────────────────────────────────────────────

export async function createM365Tenant(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as CreateM365TenantRequest;
    if (!body?.name || !body?.primaryDomain) {
      res.status(400).json({ error: 'name et primaryDomain sont obligatoires' });
      return;
    }

    if (body.groupId != null) {
      const { agentService } = await import('../services/agent.service');
      if (!(await agentService.isGroupInTenant(Number(body.groupId), req.tenantId))) {
        res.status(400).json({ error: 'Group does not belong to this tenant' });
        return;
      }
    }

    const userId = (req as Request & { userId?: number }).userId ?? req.session.userId!;
    const result = await m365TenantService.create(body, req.tenantId, userId);
    res.status(201).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erreur inattendue';
    logger.warn({ err }, 'Création de tenant M365 refusée');
    res.status(400).json({ error: message });
  }
}

export async function getM365Tenant(req: Request, res: Response): Promise<void> {
  const deviceId = await requireOwnM365(req, res);
  if (deviceId === null) return;

  const tenant = await m365TenantService.get(deviceId);
  if (!tenant) {
    res.status(404).json({ error: 'Tenant M365 not found' });
    return;
  }
  res.json(tenant);
}

export async function updateM365Tenant(req: Request, res: Response): Promise<void> {
  const deviceId = await requireOwnM365(req, res);
  if (deviceId === null) return;

  try {
    await m365TenantService.update(deviceId, req.body as UpdateM365TenantRequest);
    res.json(await m365TenantService.get(deviceId));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Erreur inattendue' });
  }
}

/** Émet un jeton d'enrôlement et renvoie la commande à lancer. */
export async function issueM365Enrolment(req: Request, res: Response): Promise<void> {
  const deviceId = await requireOwnM365(req, res);
  if (deviceId === null) return;

  const serverUrl = inferServerUrl(req);
  if (!serverUrl) {
    res.status(500).json({ error: "Impossible de déterminer l'URL publique : configurer APP_URL" });
    return;
  }

  try {
    const userId = (req as Request & { userId?: number }).userId ?? req.session.userId!;
    res.json(await m365TenantService.issueEnrolmentToken(deviceId, userId, serverUrl));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Erreur inattendue' });
  }
}

/** Relance le sondage des permissions, par exemple après un consentement complété. */
export async function verifyM365Tenant(req: Request, res: Response): Promise<void> {
  const deviceId = await requireOwnM365(req, res);
  if (deviceId === null) return;

  try {
    res.json(await m365TenantService.verifyPermissions(deviceId));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erreur inattendue';
    await m365TenantService.recordError(deviceId, message);
    res.status(502).json({ error: message });
  }
}

/** Refabrique la paire de clés. Le script doit ensuite être relancé pour téléverser le nouveau certificat. */
export async function rotateM365Certificate(req: Request, res: Response): Promise<void> {
  const deviceId = await requireOwnM365(req, res);
  if (deviceId === null) return;

  try {
    res.json(await m365TenantService.rotateCertificate(deviceId));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Erreur inattendue' });
  }
}

// ── Routes d'enrôlement, authentifiées par le jeton seul ─────────────────────

const SCRIPT_PATH = path.join(__dirname, '..', 'services', 'm365', 'enrol.ps1');

/**
 * Sert le script d'enrôlement. Il est versionné dans le dépôt et servi par
 * l'instance, donc sa version suit celle du serveur et l'opérateur n'a rien à
 * télécharger au préalable.
 */
export async function getM365EnrolScript(_req: Request, res: Response): Promise<void> {
  try {
    const script = await fs.promises.readFile(SCRIPT_PATH, 'utf-8');
    res.type('text/plain; charset=utf-8').send(script);
  } catch (err) {
    logger.error({ err, path: SCRIPT_PATH }, "Script d'enrôlement M365 illisible");
    res.status(500).json({ error: "Script d'enrôlement indisponible" });
  }
}

/**
 * Renvoie au script ce qu'il doit appliquer : le certificat et la liste des
 * permissions, par ressource. Le jeton est validé mais pas consommé, pour qu'un
 * échec en cours de route laisse la possibilité de relancer le script.
 *
 * Les permissions sont désignées par leur nom : c'est le script qui les résout en
 * identifiants de rôle, en interrogeant le tenant. Un GUID figé côté serveur
 * pourrait viser la mauvaise permission sans que rien ne le signale.
 */
export async function getM365EnrolPlan(req: Request, res: Response): Promise<void> {
  const { token, includeWrite } = (req.body ?? {}) as { token?: string; includeWrite?: boolean };
  if (!token) {
    res.status(400).json({ error: 'token manquant' });
    return;
  }

  const plan = await m365TenantService.getEnrolmentPlan(token);
  if (!plan) {
    res.status(401).json({ error: "Jeton d'enrôlement invalide, expiré ou déjà utilisé" });
    return;
  }

  res.json({
    appDisplayName: plan.appDisplayName,
    primaryDomain: plan.primaryDomain,
    certificateBase64: certificateToBase64(plan.certificatePem),
    certThumbprint: plan.certThumbprint,
    resources: enrolmentPermissionPlan(Boolean(includeWrite)),
    exchangeRole: includeWrite ? EXO_WRITE_ROLE : EXO_READ_ROLE,
  });
}

/**
 * Point de retour du script : enregistre les identifiants et renvoie le résultat
 * du sondage des permissions, que le script affiche à l'opérateur.
 */
export async function completeM365Enrolment(req: Request, res: Response): Promise<void> {
  const { token, entraTenantId, clientId, exchangeRoleAssigned } = (req.body ?? {}) as {
    token?: string;
    entraTenantId?: string;
    clientId?: string;
    exchangeRoleAssigned?: boolean;
  };
  if (!token || !entraTenantId || !clientId) {
    res.status(400).json({ error: 'token, entraTenantId et clientId sont obligatoires' });
    return;
  }

  try {
    res.json(
      await m365TenantService.completeEnrolment(token, entraTenantId, clientId, Boolean(exchangeRoleAssigned)),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erreur inattendue';
    logger.warn({ err }, 'Enrôlement M365 refusé');
    // Un jeton invalide ne doit pas se distinguer d'un jeton expiré : les deux
    // répondent 401 sans détailler lequel des deux cas s'applique.
    res.status(401).json({ error: message });
  }
}
