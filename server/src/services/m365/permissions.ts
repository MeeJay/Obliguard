import { GRAPH_RESOURCE, MANAGE_RESOURCE, EXO_RESOURCE, type M365Resource } from './graphClient';

/**
 * Permissions demandées à un tenant client, et sondes qui vérifient ce qui a
 * réellement été accordé.
 *
 * Les permissions sont désignées par leur nom, jamais par leur GUID. Le script
 * d'enrôlement résout chaque nom en identifiant de rôle à l'exécution, en
 * interrogeant les `appRoles` du principal de service de la ressource. Un GUID
 * recopié à la main est une source d'erreur silencieuse : l'assignation
 * réussirait en pointant la mauvaise permission.
 *
 * Le consentement est découpé en deux : la lecture, indispensable, et l'écriture,
 * que le client accorde ou non. Tant que l'écriture n'est pas accordée, les
 * playbooks de réponse restent grisés dans l'interface.
 */

/** Identifiants d'application des ressources Microsoft, stables et publics. */
export const RESOURCE_APP_IDS = {
  /** Microsoft Graph. */
  graph: '00000003-0000-0000-c000-000000000000',
  /** Office 365 Management APIs, qui porte le flux d'audit unifié. */
  management: 'c5393580-f805-4401-95e8-94b7a6ef2fc2',
  /** Office 365 Exchange Online. */
  exchange: '00000002-0000-0ff1-ce00-000000000000',
} as const;

export interface PermissionSet {
  resource: keyof typeof RESOURCE_APP_IDS;
  /** Noms des permissions applicatives, tels qu'ils apparaissent dans `appRoles.value`. */
  permissions: string[];
}

/** Premier consentement : lecture seule. Sans lui, le module ne fonctionne pas. */
export const READ_PERMISSIONS: PermissionSet[] = [
  {
    resource: 'graph',
    permissions: [
      'AuditLog.Read.All',
      'Directory.Read.All',
      'Policy.Read.All',
      'UserAuthenticationMethod.Read.All',
      'Application.Read.All',
      'RoleManagement.Read.Directory',
      'Reports.Read.All',
      'Domain.Read.All',
    ],
  },
  { resource: 'management', permissions: ['ActivityFeed.Read'] },
  { resource: 'exchange', permissions: ['Exchange.ManageAsApp'] },
];

/**
 * Permissions qui ne servent qu'en licence P2. Elles sont demandées dans le même
 * consentement, mais leur absence n'est pas une erreur : sur un tenant gratuit,
 * Entra n'expose pas ces données de toute façon.
 */
export const P2_ONLY_PERMISSIONS: PermissionSet[] = [
  { resource: 'graph', permissions: ['IdentityRiskyUser.Read.All', 'IdentityRiskEvent.Read.All'] },
];

/**
 * Second consentement, optionnel : écriture, pour les actions de confinement.
 * Aucune n'est utilisée automatiquement, la décision étant de ne rien exécuter
 * sans clic humain ; elles conditionnent seulement les boutons de l'interface.
 */
export const WRITE_PERMISSIONS: PermissionSet[] = [
  {
    resource: 'graph',
    permissions: [
      'User.ReadWrite.All',
      'User.RevokeSessions.All',
      'DelegatedPermissionGrant.ReadWrite.All',
      'UserAuthenticationMethod.ReadWrite.All',
      'MailboxSettings.ReadWrite',
    ],
  },
];

/**
 * Rôle Exchange en lecture à attribuer au principal de service. `Exchange.ManageAsApp`
 * ouvre la porte, ce rôle décide de ce qu'on peut y lire : sans lui, toutes les
 * commandes Exchange échouent en « accès refusé », y compris les lectures.
 */
export const EXO_READ_ROLE = 'View-Only Organization Management';
/** Rôle Exchange en écriture, pour le second consentement. */
export const EXO_WRITE_ROLE = 'Organization Management';

// ── Sondes ───────────────────────────────────────────────────────────────────

/**
 * Une sonde est un appel réel, choisi pour être peu coûteux et sans effet de bord.
 * Vérifier par l'appel plutôt qu'en relisant les consentements accordés est le
 * seul moyen fiable : un consentement peut figurer dans l'annuaire sans que
 * l'appel passe, par exemple quand le rôle Exchange manque.
 */
export interface PermissionProbe {
  /** Permission que cette sonde valide. */
  permission: string;
  resource: M365Resource;
  /** Chemin appelé. `$top=1` partout où c'est possible, pour ne rien télécharger. */
  path: string;
  /** Une sonde facultative qui échoue ne fait pas échouer l'enrôlement. */
  optional?: boolean;
  /** Licence minimale, quand l'absence de réponse s'explique par la licence. */
  requiresLicence?: 'p1' | 'p2';
}

export const PERMISSION_PROBES: PermissionProbe[] = [
  { permission: 'Directory.Read.All', resource: GRAPH_RESOURCE, path: '/users?$top=1&$select=id' },
  { permission: 'Domain.Read.All', resource: GRAPH_RESOURCE, path: '/domains?$top=1&$select=id' },
  {
    permission: 'Policy.Read.All',
    resource: GRAPH_RESOURCE,
    path: '/policies/authorizationPolicy',
  },
  {
    permission: 'Application.Read.All',
    resource: GRAPH_RESOURCE,
    path: '/servicePrincipals?$top=1&$select=id',
  },
  {
    permission: 'RoleManagement.Read.Directory',
    resource: GRAPH_RESOURCE,
    path: '/directoryRoles?$top=1&$select=id',
  },
  {
    permission: 'AuditLog.Read.All',
    resource: GRAPH_RESOURCE,
    path: '/auditLogs/directoryAudits?$top=1&$select=id',
  },
  {
    // Les journaux de connexion exigent P1. Un 403 ici n'est donc pas une
    // permission manquante mais l'absence de licence, et c'est précisément ce
    // que la détection de licence exploite.
    permission: 'AuditLog.Read.All (signIns)',
    resource: GRAPH_RESOURCE,
    path: '/auditLogs/signIns?$top=1&$select=id',
    optional: true,
    requiresLicence: 'p1',
  },
  {
    permission: 'IdentityRiskyUser.Read.All',
    resource: GRAPH_RESOURCE,
    path: '/identityProtection/riskyUsers?$top=1&$select=id',
    optional: true,
    requiresLicence: 'p2',
  },
];

/** Toutes les permissions de lecture attendues, à plat, pour les comparaisons. */
export function readPermissionNames(): string[] {
  return READ_PERMISSIONS.flatMap((s) => s.permissions);
}

/**
 * Représentation destinée au script d'enrôlement et à l'interface : par ressource,
 * l'identifiant d'application et les noms de permissions à assigner.
 */
export function enrolmentPermissionPlan(includeWrite: boolean): Array<{
  resourceAppId: string;
  resourceName: string;
  permissions: string[];
}> {
  const sets = [...READ_PERMISSIONS, ...P2_ONLY_PERMISSIONS, ...(includeWrite ? WRITE_PERMISSIONS : [])];
  const byResource = new Map<keyof typeof RESOURCE_APP_IDS, Set<string>>();

  for (const set of sets) {
    const bucket = byResource.get(set.resource) ?? new Set<string>();
    for (const p of set.permissions) bucket.add(p);
    byResource.set(set.resource, bucket);
  }

  return [...byResource.entries()].map(([resource, permissions]) => ({
    resourceAppId: RESOURCE_APP_IDS[resource],
    resourceName: resource,
    permissions: [...permissions],
  }));
}

/** Ressource appelée par une sonde, pour les journaux et les messages d'erreur. */
export const PROBE_RESOURCE_LABELS: Record<string, string> = {
  [GRAPH_RESOURCE]: 'Microsoft Graph',
  [MANAGE_RESOURCE]: 'Office 365 Management APIs',
  [EXO_RESOURCE]: 'Exchange Online',
};
