Le moteur de bans expose deux niveaux de granularité orthogonaux : un **scope** (qui applique le ban) et un **type** (qui l'a créé). Toute la logique est centralisée dans `server/src/services/ban.service.ts`, autour de la table `ip_bans` (créée en migration `001_obliguard_schema.ts`) et de sa table satellite `ip_ban_exclusions` (migration `006_ban_exclusions.ts`).

## Table `ip_bans`

```sql
ip_bans (
  id                integer PK,
  ip                inet NOT NULL,
  cidr_prefix       integer NULL,        -- ban de sous-réseau (ex: /24)
  reason            text NULL,
  ban_type          varchar(20) NOT NULL DEFAULT 'auto',    -- 'auto' | 'manual'
  scope             varchar(20) NOT NULL DEFAULT 'global',  -- 'global'|'tenant'|'group'|'agent'
  scope_id          integer NULL,        -- NULL si scope='global'
  tenant_id         integer NULL REFERENCES tenants(id) ON DELETE CASCADE,
  origin_tenant_id  integer NULL REFERENCES tenants(id) ON DELETE SET NULL,
  banned_by_user_id integer NULL REFERENCES users(id) ON DELETE SET NULL,
  banned_at         timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NULL,
  is_active         boolean NOT NULL DEFAULT true
)
```

Index notables :

- `idx_ip_bans_active` sur `ip` filtré par `is_active = true` — lookup rapide « cette IP est-elle bannie ».
- `idx_ip_bans_scope` sur `(scope, scope_id)` filtré par `is_active = true` — résolution des bans applicables à un agent/groupe/tenant.
- `idx_ip_bans_expires` sur `expires_at` — pour l'auto-désactivation des bans à TTL.

Le type partagé côté TypeScript est défini dans `shared/src/types.ts` :

```ts
export type BanScope = 'global' | 'tenant' | 'group' | 'agent';
export type BanType = 'auto' | 'manual';

export interface IpBan {
  id: number;
  ip: string;
  cidrPrefix: number | null;
  reason: string | null;
  banType: BanType;
  scope: BanScope;
  scopeId: number | null;
  tenantId: number | null;
  originTenantId: number | null;   // visible admin uniquement
  originTenantName?: string;
  bannedByUserId: number | null;
  bannedAt: string;
  expiresAt: string | null;
  isActive: boolean;
  isExcludedByTenant?: boolean;    // calculé côté API, cf. exclusions
}
```

`CreateBanRequest` (même fichier) est le contrat d'entrée pour la création manuelle : `ip`, `cidrPrefix?`, `reason?`, `scope?`, `scopeId?`, `expiresAt?`.

## Les quatre scopes

Le scope détermine à quel périmètre le ban s'applique lors du calcul du delta envoyé à chaque agent (`banService.computeBanDelta`) :

| Scope | `scope_id` | Portée |
|---|---|---|
| `global` | `NULL` | Appliqué par **tous les agents**, tous tenants confondus. C'est le scope par défaut du moteur d'auto-ban. |
| `tenant` | `NULL` (le tenant est porté par `tenant_id`) | Appliqué uniquement aux agents du tenant propriétaire. |
| `group` | `id` du `monitor_group` | Appliqué aux agents rattachés à ce groupe (via `group_closure`, hiérarchie fermée). |
| `agent` | `id` de `agent_devices` | Appliqué à un seul agent. |

La résolution se fait dans `computeBanDelta(deviceId, groupIds, tenantId, agentCurrentBans, resolvedWhitelist)` :

```ts
const bans = await db('ip_bans')
  .where('is_active', true)
  .where((b) => {
    b.where('scope', 'global')
      .orWhere('tenant_id', tenantId)
      .orWhere((c) => c.where('scope', 'group').whereIn('scope_id', groupIds))
      .orWhere((c) => c.where('scope', 'agent').where('scope_id', deviceId));
  })
```

`groupIds` est la liste des ancêtres du groupe de l'agent (résolue via `group_closure`), donc un ban `scope='group'` posé sur un groupe parent s'applique aussi à tous ses agents descendants. Le résultat est ensuite filtré :

1. Les IPs couvertes par une exclusion tenant (`ip_ban_exclusions`) sont retirées.
2. Les IPs whitelistées sont retirées (`resolvedWhitelist`, contrôle rapide côté serveur ; l'agent réapplique de toute façon sa propre whitelist localement).
3. Le résultat est diffé contre `agentCurrentBans` (l'état firewall réel remonté par l'agent) pour produire `{ add: string[], remove: string[] }`.

Ce delta est ce qui est réellement transmis à l'agent via le hub WebSocket (`obliguardHub.service.ts`), qui l'applique localement dans `agent/firewall.go`.

### Permissions de création par scope

`banService.create()` impose :

```ts
const scope: BanScope = data.scope ?? (isAdmin ? 'global' : 'tenant');
if (!isAdmin && scope !== 'tenant') {
  throw new Error('Only platform admins can create non-tenant-scoped bans');
}
```

- Un utilisateur non-admin (rôle tenant) ne peut créer que des bans `scope='tenant'`, implicitement sur son propre `tenantId`.
- Seul un platform admin (`req.session.role === 'admin'`) peut créer des bans `global`, `group` ou `agent`.
- La route `POST /bans` (`server/src/routes/bans.routes.ts`) est de toute façon protégée par `requireRole('admin')`, donc en pratique seul un admin crée un ban manuel via l'API HTTP standard — le chemin `scope='tenant'` sans droits admin correspond à des appels internes/service-to-service.

Avant insertion, une vérification anti-doublon rejette la création si l'IP a déjà un ban actif (`is_active = true` et `expires_at` NULL ou futur) : `This IP is already banned` (HTTP mappé en 409 par le controller).

## Types de ban : `auto` vs `manual`

### `manual`

Créé via `banService.create()`, appelée par `POST /bans` (contrôleur `createBan` dans `server/src/controllers/bans.controller.ts`). Toujours `banned_by_user_id` renseigné, `origin_tenant_id = null`. Émet `ban:created` sur Socket.io et pousse le ban aux devices MikroTik (`mikrotikBanSync.pushBanToAll(ip, 'ban')`, fire-and-forget, import dynamique pour éviter une dépendance circulaire).

### `auto`

Créé exclusivement par `BanEngine.createAutoBan()`, jamais via l'API HTTP directement. Toujours `scope='global'`, `banned_by_user_id = null`, `origin_tenant_id` renseigné avec le tenant dont l'agent a détecté l'attaque.

Le cycle du `BanEngine` (classe en bas de `ban.service.ts`, instance exportée `banEngine`) :

- Tourne toutes les 30 secondes (`BAN_ENGINE_INTERVAL_MS = 30_000`) via `setInterval`, démarré par `banEngine.start()`.
- Garde de ré-entrance (`this.running`) : si un cycle précédent n'est pas terminé (contention DB), le tick est sauté plutôt que d'empiler des exécutions concurrentes.
- `evaluateThresholds()` :
  1. Récupère tous les agents `status = 'approved'`.
  2. Exclut les devices/groupes marqués `evaluate_only = true` (mode dry-run — observation sans auto-ban ; le flag est hérité de tout groupe ancêtre via `monitor_groups.evaluate_only`).
  3. Résout les templates de service actifs par agent via `serviceTemplateService.resolveForAgent(deviceId, groupIds)` — modèle **opt-in** : un template ne compte que s'il est explicitement activé (`enabled_override = true`) au niveau groupe ou agent, et en `mode = 'ban'` (par opposition à `mode = 'track'`, qui journalise sans bannir).
  4. Pour chaque template actif, compte les événements `ip_events` de type `auth_failure` (`track_only = false`) sur la fenêtre glissante `windowSeconds`, groupés par `(ip, tenant_id)`, avec `HAVING count(id) >= threshold`.
  5. Chaque IP dépassant le seuil déclenche `createAutoBan(ip, tenantId, serviceType, failureCount)`.

`createAutoBan()` :

- Skip si un ban `scope='global'` actif existe déjà pour cette IP (pas de doublon).
- Skip si l'IP est couverte par une entrée `ip_whitelist` de scope `global` (`?::inet << ip`, containment CIDR).
- Insère le ban avec `reason: "Auto-ban: <n> <service> auth failures"`.
- Garantit une ligne `ip_reputation` via `ipReputationService.ensureExists(ip)` (non bloquant).
- Émet `ban:auto` sur Socket.io, pousse aux devices MikroTik.
- Marque les agents source comme « sous attaque » : recherche les `agent_devices` ayant eu des `auth_failure` de cette IP dans les 10 dernières minutes, met à jour `last_attack_at`, et déclenche une notification `attack` par agent affecté via `notificationService.sendForAgent(...)`.

## Promotion d'un ban local vers global

`banService.promoteToGlobal(banId)` — appelée par `POST /bans/:id/promote-global` (route protégée `requireRole('admin')`) :

```ts
async promoteToGlobal(banId: number): Promise<IpBan> {
  const [row] = await db('ip_bans')
    .where('id', banId)
    .update({ scope: 'global', scope_id: null, tenant_id: null })
    .returning('*');
  ...
}
```

Opération simple et irréversible via l'API (pas de « démotion ») : un ban `tenant`/`group`/`agent` devient `global`, perd son `scope_id` et son `tenant_id`, et s'applique donc immédiatement à tous les tenants au prochain calcul de delta. Émet `ban:updated`. Aucune vérification métier supplémentaire n'est faite ici au-delà du rôle admin — la promotion est une action volontaire d'un platform admin, typiquement depuis `BansPage.tsx`.

## Levée de ban (lift)

`banService.lift(banId, tenantId, isAdmin)` — appelée par `DELETE /bans/:id` (route `requireRole('admin')`) désactive le ban (`is_active = false`) plutôt que de le supprimer physiquement (conservation de l'historique).

Règles d'autorité, dans l'ordre :

1. **Ban global** : autoritaire pour tous les tenants. Ne peut être levé que depuis le tenant maître (`isMasterTenant(tenantId)`, contrôle importé de `@obliview/shared`). Toute autre tentative échoue avec :
   > `Global bans can only be lifted from the Default tenant. Use "Exclude" to override this ban on the current tenant.`
2. **Ban non-global** : un admin peut lever n'importe quel ban ; un non-admin ne peut lever que ses propres bans `scope='tenant'` (`ban.tenant_id === tenantId`) — sinon `Insufficient permissions to lift this ban`. En pratique la route HTTP exige déjà `requireRole('admin')`, cette branche protège les appels internes.

Une fois levé : émission `ban:lifted` en Socket.io, et push d'un `unban` fire-and-forget vers les équipements MikroTik (`mikrotikBanSync.pushBanToAll(ban.ip, 'unban')`).

## Exclusion tenant d'un ban global

Puisqu'un tenant non-maître ne peut pas lever un ban `global` (qui protège potentiellement d'autres tenants), il dispose d'une échappatoire locale sans révoquer la protection ailleurs : `ip_ban_exclusions`.

```sql
ip_ban_exclusions (
  id          integer PK,
  ban_id      integer NOT NULL REFERENCES ip_bans(id) ON DELETE CASCADE,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by  integer NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ban_id, tenant_id)
)
```

- `excludeForTenant(banId, tenantId, userId)` — `POST /bans/:id/exclude` : refuse si le ban n'est pas `scope='global'` ou n'est plus actif ; insert idempotent (`onConflict(['ban_id','tenant_id']).ignore()`).
- `removeExclusion(banId, tenantId)` — `DELETE /bans/:id/exclude` : supprime l'exclusion, erreur si aucune n'existait.
- Effet : le ban reste actif globalement (les autres tenants continuent de l'enforcer), mais `computeBanDelta` filtre les IPs dont le `ban.id` est dans `excludedBanIds` pour ce tenant précis — l'agent de ce tenant ne recevra jamais cette IP dans son `banList.add`.
- Côté liste (`banService.list()`), un `LEFT JOIN` sur `ip_ban_exclusions` filtré par le `tenantId` appelant calcule `isExcludedByTenant`, exposé dans `IpBan.isExcludedByTenant` pour affichage dans `BansPage.tsx`.

## Visibilité en lecture (`list`)

`banService.list({ tenantId, isAdmin, onlyActive, search, limit, offset })` filtre selon le rôle :

- **Platform admin** : voit tous les bans (global + tous les tenants), et seul lui reçoit `originTenantId`/`originTenantName` (masqués à `null`/`undefined` pour les non-admins dans `rowToBan()`).
- **Tenant non-maître, non-admin** : voit les bans `scope='global'` OU `tenant_id = tenantId` uniquement.
- **Tenant maître** (`isMasterTenant`) : traité comme voyant tout, cohérent avec son rôle de « god view » utilisé pour la levée des bans globaux.

## Résumé du flux bout en bout

1. `BanEngine.evaluateThresholds()` (toutes les 30s) détecte un dépassement de seuil → `createAutoBan()` insère un ban `type='auto'`, `scope='global'`.
2. Un admin tenant juge le ban trop agressif pour son périmètre → `excludeForTenant()` au lieu de `lift()` (interdit hors tenant maître).
3. Un admin plateforme constate qu'un ban `tenant`/`group`/`agent` mérite une portée plus large → `promoteToGlobal()`.
4. Un admin (ou le tenant maître pour un ban global) juge le ban obsolète/faux positif → `lift()` désactive le ban (`is_active=false`), sans suppression physique.
5. À chaque cycle de synchronisation agent, `computeBanDelta()` recalcule l'ensemble `{add, remove}` en tenant compte du scope, des exclusions tenant et de la whitelist, et le hub (`obliguardHub.service.ts`) le transmet à l'agent Go qui l'applique via `agent/firewall.go`.
