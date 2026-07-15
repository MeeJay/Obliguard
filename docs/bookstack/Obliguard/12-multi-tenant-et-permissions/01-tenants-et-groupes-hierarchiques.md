## Vue d'ensemble

Obliguard isole les données par **tenant** (workspace) et organise les agents/équipements en **groupes hiérarchiques** à profondeur illimitée à l'intérieur de chaque tenant. Ces deux notions sont orthogonales : un tenant délimite un périmètre de données isolé (agents, bans, templates, notifications, utilisateurs), tandis qu'un groupe organise les agents *dans* un tenant (structure arborescente, héritage de configuration, permissions RBAC par équipe).

Les tables concernées sont créées dans la migration consolidée `server/src/db/migrations/001_obliguard_schema.ts` (section 1 pour les tenants, section 3 pour les groupes et la closure table).

## Le tenant "master" (god view)

Le tenant `id = 1` (seedé au nom `Default` / slug `default` dans la migration 001) joue un rôle spécial documenté dans `shared/src/tenants.ts` :

```ts
export const MASTER_TENANT_ID = 1;

export function isMasterTenant(tenantId: number | null | undefined): boolean {
  return tenantId === MASTER_TENANT_ID;
}
```

Quand la session active a pour tenant courant le tenant master, les données opérationnelles (agents, groupes, templates, bans, réputation IP, whitelist, rate-limits...) de **tous les tenants** deviennent visibles, et une action de unban effectuée depuis ce contexte est autoritaire (elle lève le ban globalement). C'est visible par exemple dans `groupService.getAll()` :

```ts
async getAll(tenantId: number): Promise<MonitorGroup[]> {
  const q = db<GroupRow>('monitor_groups').orderBy('sort_order').orderBy('name');
  if (!isMasterTenant(tenantId)) q.where({ tenant_id: tenantId });
  const rows = await q;
  return rows.map(rowToGroup);
},
```

Règle de sécurité explicitement documentée dans le code : la god view ne s'applique **qu'aux données opérationnelles**. Les identifiants/secrets (clés API agent, mots de passe SMTP, configuration des canaux de notification) et les résolveurs d'enforcement par agent (fonctions `resolve*ForAgent`) restent strictement scoping tenant, même en contexte master.

## Table `tenants` et rattachement des utilisateurs

```ts
await knex.schema.createTable('tenants', (t) => {
  t.increments('id').primary();
  t.string('name', 255).notNullable();
  t.string('slug', 255).notNullable().unique();
  t.timestamps(true, true);
});

await knex.schema.createTable('user_tenants', (t) => {
  t.integer('user_id')...references('id').inTable('users').onDelete('CASCADE');
  t.integer('tenant_id')...references('id').inTable('tenants').onDelete('CASCADE');
  t.string('role', 20).notNullable().defaultTo('member'); // 'admin' | 'member'
  t.primary(['user_id', 'tenant_id']);
});
```

Un utilisateur peut appartenir à plusieurs tenants, avec un rôle **par tenant** (`admin` ou `member`), indépendant du rôle plateforme global (`req.session.role`). Toutes les tables métier (agents, groupes, service templates, bans, whitelist, notification_channels, settings, teams...) portent une colonne `tenant_id` avec `defaultTo(1)` (rattachement implicite au tenant par défaut lors des migrations) et `onDelete('CASCADE')`.

### Service `tenant.service.ts`

`server/src/services/tenant.service.ts` expose les opérations CRUD et de membership :

- `getAll()` — tous les tenants (réservé plateforme admin)
- `getTenantsForUser(userId)` — tenants accessibles par un utilisateur, avec son rôle sur chacun
- `getFirstTenantForUser(userId)` — tenant par défaut à l'ouverture de session (le plus petit id accessible)
- `userHasAccess(userId, tenantId)` — vérification d'accès
- `getMembers`, `addUser`, `removeUser`, `updateUserRole` — gestion des membres du tenant

### Résolution du tenant courant

`server/src/middleware/tenant.ts` résout `req.tenantId` depuis la session (`req.session.currentTenantId`) et doit être appliqué après `requireAuth` sur toute route opérant sur des données scoping tenant :

```ts
export function requireTenant(req, _res, next) {
  const tid = req.session?.currentTenantId;
  if (!tid) { next(new AppError(400, 'No tenant selected')); return; }
  req.tenantId = tid;
  next();
}
```

Le changement de tenant actif passe par `POST /api/tenant/switch` (`server/src/routes/tenant.routes.ts`), qui vérifie l'accès (sauf pour les admins plateforme, qui peuvent basculer vers n'importe quel tenant) puis met à jour `req.session.currentTenantId`.

### Routes tenant (`/tenants`)

| Méthode | Route | Accès |
|---|---|---|
| `POST` | `/switch` | tout utilisateur authentifié (avec vérif d'accès si non-admin) |
| `GET` | `/` | admin: tous les tenants — utilisateur: ses tenants + rôle |
| `POST` | `/` | admin plateforme uniquement |
| `GET` | `/:id` | accès vérifié si non-admin |
| `PUT` | `/:id` | admin plateforme uniquement |
| `DELETE` | `/:id` | admin plateforme uniquement — refuse `id === 1` (le tenant par défaut n'est jamais supprimable) |
| `GET/POST/PUT/DELETE` | `/:id/members[/:uid]` | admin plateforme uniquement |

## Groupes hiérarchiques : `monitor_groups` + closure table

Les agents sont organisés dans `monitor_groups` (nom hérité d'Obliview, réutilisé par Obliguard pour le regroupement d'agents). Colonnes notables :

- `parent_id` — FK auto-référencée sur `monitor_groups`, `onDelete('CASCADE')` (supprimer un groupe supprime récursivement ses enfants)
- `kind` — `'monitor' | 'agent'` (migration historique 017), distingue un groupe conteneur générique d'un groupe destiné à recevoir des agents
- `is_general` — marque le groupe "général"/par défaut d'un tenant
- `group_notifications` — active ce groupe comme point d'ancrage de notification (voir plus bas)
- `agent_thresholds` (jsonb) — seuils par défaut appliqués à l'approbation d'un agent dans ce groupe
- `agent_group_config` (jsonb) — `pushIntervalSeconds`, `heartbeatMonitoring`, `maxMissedPushes`, `notificationTypes`, fusionnés par-dessus les valeurs existantes lors d'un `PATCH`
- `evaluate_only` — mode évaluation (ajouté par une migration ultérieure)
- `tenant_id` — isolation par tenant, `defaultTo(1)`

La profondeur illimitée est gérée par une **closure table** classique plutôt que par des requêtes récursives :

```ts
await knex.schema.createTable('group_closure', (t) => {
  t.integer('ancestor_id')...references('id').inTable('monitor_groups').onDelete('CASCADE');
  t.integer('descendant_id')...references('id').inTable('monitor_groups').onDelete('CASCADE');
  t.integer('depth').notNullable();
  t.primary(['ancestor_id', 'descendant_id']);
  t.index('descendant_id');
  t.index('ancestor_id');
});
```

Chaque groupe possède une ligne auto-référencée `(id, id, 0)`, plus une ligne par ancêtre avec la profondeur correspondante. Cela permet des requêtes ancêtres/descendants en une seule jointure, sans CTE récursif.

### `group.service.ts` — maintenance de la closure table

**Création** (`create`) : insère le groupe, ajoute la ligne self-référence `depth=0`, puis copie tous les chemins d'ancêtres du parent :

```ts
await db('group_closure').insert({ ancestor_id: row.id, descendant_id: row.id, depth: 0 });

if (data.parentId) {
  await db.raw(
    `INSERT INTO group_closure (ancestor_id, descendant_id, depth)
     SELECT gc.ancestor_id, ?, gc.depth + 1
     FROM group_closure gc
     WHERE gc.descendant_id = ?`,
    [row.id, data.parentId],
  );
}
```

**Déplacement** (`move`) : c'est l'opération la plus délicate. Elle :
1. Vérifie qu'on ne déplace pas un groupe dans l'un de ses propres descendants (requête sur `group_closure` avec `ancestor_id = id, descendant_id = newParentId`) — sinon `throw new Error('Cannot move group into its own descendant')`.
2. Récupère tout le sous-arbre (soi-même + descendants) via `WHERE ancestor_id = id`.
3. Supprime toutes les entrées de closure reliant l'extérieur du sous-arbre à l'intérieur (`whereIn(descendant_id, subtree).whereNotIn(ancestor_id, subtree)`).
4. Reconnecte le sous-arbre entier sous le nouveau parent via un produit cartésien (`CROSS JOIN`) entre les ancêtres du nouveau parent et les membres du sous-arbre, en sommant les profondeurs + 1.
5. Met à jour la colonne `parent_id` du groupe déplacé.

**Requêtes d'arbre** exposées par le service :
- `getAncestors(groupId)` — jointure `group_closure` triée par `depth DESC` (racine en premier)
- `getDescendantIds(groupId)` — tous les descendants (utilisé pour le scoping de bans/whitelist niveau "group")
- `getChildren(parentId)` — enfants directs (`parent_id` NULL pour les racines)
- `getTree(tenantId)` — reconstruit l'arbre complet en mémoire (`Map<id, GroupTreeNode>`) à partir de `getAll(tenantId)`
- `findGroupNotificationAncestor(groupId)` — remonte la chaîne d'ancêtres (`depth ASC`, soi-même en premier) jusqu'au premier groupe avec `group_notifications = true` ; c'est le mécanisme d'héritage des liaisons de notification (settings inheritance) évoqué dans le CLAUDE.md
- `reorder(items)` — mise à jour groupée de `sort_order` en transaction

Le `delete(id)` s'appuie entièrement sur les `CASCADE` de la base : supprimer un groupe purge automatiquement ses lignes de `group_closure` et ses enfants directs.

## Permissions par groupe (RBAC)

Les routes d'écriture sur `/groups` (`server/src/routes/groups.routes.ts`) ne sont pas simplement protégées par rôle plateforme ; elles utilisent des middlewares dédiés définis dans `server/src/middleware/rbac.ts` :

```ts
router.post('/', requireCanCreate(), validate(createGroupSchema), groupsController.create);
router.put('/:id', requireGroupWrite(), validate(updateGroupSchema), groupsController.update);
router.post('/:id/move', requireGroupWrite(), validate(moveGroupSchema), groupsController.move);
router.delete('/:id', requireGroupWrite(), groupsController.delete);
```

- `requireGroupWrite()` — laisse passer les admins plateforme sans vérification ; pour les autres, délègue à `permissionService.canWriteGroup(userId, groupId, false)`, qui s'appuie sur les affectations `team_permissions` (`scope = 'group'`, `level = 'ro' | 'rw'`) définies dans `user_teams` / `team_memberships` / `team_permissions` (section 4 de la migration 001).
- `requireCanCreate()` — vérifie `permissionService.canCreate(userId, false)` (le flag `can_create` d'une équipe).
- `requireRole('admin')` — réservé aux opérations sensibles : `reorder`, `updateAgentGroupConfig`, suppression de heartbeats de tenant.

Ce modèle permet, par exemple, à une équipe avec accès RW sur un sous-groupe précis de gérer ses propres agents sans avoir de droits sur le reste de l'arborescence — indépendamment du rôle tenant.

## Pages client

### `GroupManagePage.tsx`

Vue arborescente d'administration des groupes (`client/src/pages/GroupManagePage.tsx`) : formulaire de création/édition inline (`kind`, `isGeneral`, `groupNotifications`), rendu récursif du noeud d'arbre avec actions contextuelles (ajouter sous-groupe, éditer, vider les heartbeats, supprimer), et des panneaux modaux dédiés :
- `title={Settings for "..."}` — configuration de groupe
- `title={Notifications for "..."}` — liaisons de notification (`NotificationBindingsPanel`)
- `title={Maintenance for "..."}` — actions de maintenance (heartbeats)

Un badge distingue visuellement les groupes `kind === 'agent'` des groupes conteneurs génériques, et un indicateur signale les groupes marqués `isGeneral`.

### `GroupDetailPage.tsx`

Vue détail d'un groupe (`client/src/pages/GroupDetailPage.tsx`), consommée via `useParams`/`groupsApi`. Contient notamment `AgentGroupSettingsPanel`, qui édite `agentGroupConfig` (intervalle de push, `maxMissedPushes`) avec détection d'override (`cfg.pushIntervalSeconds !== null` signifie que le groupe surcharge la valeur héritée du niveau supérieur), le toggle `evaluateOnly` (mode évaluation sans application des bans), ainsi que des panneaux composés : `NotificationTypesPanel`, `ServiceTemplatesPanel`, `NetworkLimitsPanel` (rate-limits) — tous scoping sur le groupe courant via son `id`.

### `GroupEditPage.tsx`

Formulaire dédié à l'édition d'un groupe isolé (hors vue arborescente), utilisé notamment pour l'édition profonde depuis un lien direct.

## Héritage de configuration

Le modèle d'héritage (global → groupe → agent) mentionné dans le CLAUDE.md repose sur deux mécanismes combinés :
1. La table `settings` (`scope: 'global' | 'group'`, `scope_id`) pour les réglages plateforme/tenant.
2. La closure table `group_closure`, via `findGroupNotificationAncestor` et `getAncestors`, pour remonter la chaîne de groupes et déterminer quelle configuration (seuils, notifications, intervalle de push) s'applique effectivement à un agent placé dans un sous-groupe profond, en l'absence de surcharge locale.

Ce même principe de closure table est réutilisé côté scoping de bans/whitelist niveau `group` (`ban_type = 'group'`) : `groupService.getDescendantIds(groupId)` permet d'étendre un ban ou une règle à tous les agents des sous-groupes d'un groupe donné.
