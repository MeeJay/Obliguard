La whitelist protège des IP (adresses ou plages CIDR) contre le bannissement automatique du moteur d'IPS. Elle est implémentée dans `server/src/services/whitelist.service.ts`, exposée via `server/src/routes/whitelist.routes.ts` et `server/src/controllers/whitelist.controller.ts`, et stockée dans la table `ip_whitelist` (migration `server/src/db/migrations/001_obliguard_schema.ts`).

## Modèle de données

```sql
CREATE TABLE ip_whitelist (
  id            serial PRIMARY KEY,
  ip            cidr NOT NULL,
  label         varchar(255),
  scope         varchar(20) NOT NULL DEFAULT 'global',  -- global | tenant | group | agent
  scope_id      integer,
  tenant_id     integer REFERENCES tenants(id) ON DELETE CASCADE,
  created_by    integer REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_ip_whitelist_uniq ON ip_whitelist(ip, scope, COALESCE(scope_id, 0));
CREATE INDEX idx_ip_whitelist_scope ON ip_whitelist(scope, scope_id);
```

Le champ `ip` est typé `cidr` côté PostgreSQL : il accepte aussi bien une IP unique (`1.2.3.4/32`, normalisée automatiquement à partir de `1.2.3.4`) qu'une plage (`192.168.0.0/24`). La validation du format est déléguée à Postgres — `whitelist.service.ts` insère via `db.raw('?::cidr', [data.ip])`, ce qui lève une erreur SQL si la valeur n'est pas une IP/CIDR valide.

L'index unique empêche les doublons pour une même IP/CIDR **au sein d'un même scope** (`COALESCE(scope_id, 0)` gère le cas des scopes global/tenant où `scope_id` est `null`).

Les types partagés sont définis dans `shared/src/types.ts` :

```ts
export type WhitelistScope = 'global' | 'tenant' | 'group' | 'agent';

export interface IpWhitelist {
  id: number;
  ip: string;          // notation CIDR, ex. "192.168.0.0/24" ou "1.2.3.4/32"
  label: string | null;
  scope: WhitelistScope;
  scopeId: number | null;
  tenantId: number | null;
  createdBy: number | null;
  createdAt: string;
}

export interface CreateWhitelistRequest {
  ip: string;
  label?: string | null;
  scope?: WhitelistScope;
  scopeId?: number | null;
}
```

## Scoping hiérarchique

La whitelist reprend exactement le même modèle de scoping hiérarchique que les bans (`ban.service.ts`) : `global → tenant → group → agent`.

- **`global`** — s'applique à tous les tenants. Réservé aux admins (`WhitelistService.create` force `tenant_id: null` quand `scope === 'global'`).
- **`tenant`** — s'applique à tous les agents d'un tenant (`tenant_id` renseigné).
- **`group`** — s'applique à un groupe donné (`scope_id` = ID du groupe, hiérarchie fermée par table de closure comme pour le reste de l'app).
- **`agent`** — s'applique à un seul agent (`scope_id` = ID du device).

`create()` (`whitelist.service.ts:96-122`) exige un `scopeId` pour les scopes `group`/`agent`, sinon lève `scopeId is required for group/agent scope`. Le scope par défaut si omis dans la requête est `tenant`.

### Visibilité par rôle (`listByScope` / `listAll`)

- `listByScope(scope, scopeId, tenantId, isAdmin)` : consultation d'un scope précis.
  - `global` : uniquement les admins (sinon `Only admins can view global whitelist entries`).
  - `tenant` : un non-admin ne voit que les entrées de son propre tenant (sauf tenant maître via `isMasterTenant()`, qui voit toutes les entrées `tenant`).
  - `group` / `agent` : filtrées par `scope_id` si fourni.
- `listAll(tenantId, isAdmin)` : vue agrégée tous scopes confondus. Les admins et le tenant maître voient tout ; les autres tenants voient `global` + leurs propres entrées `tenant` + toutes les entrées `group`/`agent` (filtrage fin par groupe/agent laissé au niveau applicatif).

### Suppression (`delete`)

- Les admins peuvent supprimer n'importe quelle entrée.
- Un non-admin ne peut pas supprimer une entrée `global` (`Only admins can delete global whitelist entries`) ni une entrée appartenant à un autre tenant (`Whitelist entry does not belong to your tenant`).

## Résolution pour un agent (`resolveWhitelistForAgent`)

À chaque push/heartbeat d'un agent, `agent.service.ts` (ligne ~966) appelle :

```ts
resolvedWhitelist = await whitelistService.resolveWhitelistForAgent(deviceId, groupIds, agentTenantId);
```

Cette méthode empile les CIDR applicables dans l'ordre de priorité **agent → groupe (du plus proche au plus lointain) → tenant → global**, en dédupliquant par valeur CIDR exacte (`Set<string>`). Le résultat est une simple liste de chaînes CIDR, envoyée à l'agent Go dans la réponse de configuration (champ `whitelist[]` du protocole agent) : c'est l'agent qui applique localement l'exclusion firewall pour ces plages, en plus du filtrage côté serveur.

En cas d'échec de résolution (erreur DB), `agent.service.ts` logge un warning (`handlePush: whitelistService.resolveWhitelistForAgent failed`) et continue avec une liste vide plutôt que de bloquer le push.

## Vérification pré-ban

La whitelist est vérifiée à deux endroits distincts du moteur de bannissement, avec des stratégies différentes selon le contexte :

### 1. Création d'un ban automatique global (`ban.service.ts::createAutoBan`)

Avant de créer une ligne `ip_bans` (scope `global`), le moteur vérifie l'appartenance CIDR directement en SQL via l'opérateur PostgreSQL `<<` (contained-by) :

```ts
const whitelisted = await db('ip_whitelist')
  .where('scope', 'global')
  .whereRaw('?::inet << ip', [ip])
  .first();

if (whitelisted) return; // pas de ban créé
```

Note : ce garde-fou ne couvre que le scope `global` — les exclusions tenant/group/agent sont gérées séparément côté synchronisation agent (voir point 2), pas au moment de la création du ban global lui-même.

### 2. Synchronisation de la liste de bannissement par agent

Lors du calcul du delta de bans à pousser vers un agent (`ban.service.ts`, autour de la ligne 234-266), chaque ban global potentiel est comparé à `resolvedWhitelist` (la liste résolue pour cet agent précis) :

```ts
const isWhitelisted = resolvedWhitelist.some((cidr) => {
  // Full CIDR containment vérifiée par whitelistService.isWhitelisted ;
  // ici, match exact/prefix pour la performance — l'agent applique aussi sa propre whitelist
  return banIp === cidr || banIp.startsWith(cidr.split('/')[0]);
});
if (!isWhitelisted) shouldBeBanned.add(banIp);
```

Ce check est volontairement une comparaison rapide (égalité ou préfixe), pas une containment CIDR complète — le calcul exact est délégué à `WhitelistService.isWhitelisted()` quand une vérification précise est nécessaire, et l'agent Go réapplique de toute façon sa propre whitelist en local avant d'écrire les règles firewall (défense en profondeur).

### `WhitelistService.isWhitelisted()` — containment CIDR exacte

Pour un contrôle précis (IP contenue dans une plage CIDR, pas juste une égalité de chaîne), la méthode `isWhitelisted(ip, deviceId, groupIds, tenantId)` :

1. Construit dynamiquement les conditions de scope applicables (`agent` sur `deviceId`, `group` sur chaque `groupId`, `tenant` sur `tenantId`, `global`).
2. Récupère toutes les entrées `ip_whitelist` correspondantes.
3. Pour chacune, exécute une requête PostgreSQL dédiée :

```sql
SELECT ?::inet << ?::cidr AS contained
```

4. Retourne `true` dès qu'une containment est positive (`return true` au premier match).

Cette double implémentation (containment SQL précise vs. comparaison de préfixe rapide) illustre le compromis performance/exactitude : le chemin chaud de synchronisation des bans (exécuté à chaque cycle pour potentiellement de nombreux agents) privilégie la vitesse, sachant que l'agent Go applique en local sa propre whitelist résolue comme filet de sécurité final.

## API REST (`/whitelist`, tenant-scopé)

Défini dans `server/src/routes/whitelist.routes.ts`, monté sous le routeur tenant (`tenantRouter.use('/whitelist', whitelistRoutes)`) :

| Méthode | Route | Rôle requis | Contrôleur |
|---|---|---|---|
| GET | `/whitelist?scope=&scopeId=` | authentifié | `listWhitelist` |
| POST | `/whitelist` | `admin` | `createWhitelistEntry` |
| DELETE | `/whitelist/:id` | `admin` | `deleteWhitelistEntry` |

`GET /whitelist` sans paramètre `scope` (ou `scope=all`) retourne la vue agrégée via `listAll()`. Avec un `scope` explicite, `listByScope()` applique les règles de visibilité par rôle décrites plus haut.

## Whitelist en masse depuis l'IP Reputation

`server/src/controllers/bans.controller.ts::bulkWhitelist` (route `POST /bans/bulk-whitelist`, rôle `admin`) permet d'ajouter plusieurs IP d'un coup en scope `global`, typiquement depuis la page **IP Reputation** (sélection multiple → whitelister). Il insère une ligne par IP non déjà présente (vérification d'existence par égalité exacte, pas par containment CIDR).

`server/src/controllers/ipReputation.controller.ts` route également le statut `whitelisted` (endpoint de mise à jour manuelle du statut d'une IP) vers `whitelistService.create()`, au même titre que `banned` route vers `banService.create()`.

## Fichiers clés

- `server/src/services/whitelist.service.ts` — logique métier (CRUD, résolution, containment)
- `server/src/controllers/whitelist.controller.ts` — endpoints CRUD tenant-scopés
- `server/src/routes/whitelist.routes.ts` — routing + RBAC (`requireRole('admin')` sur create/delete)
- `server/src/controllers/bans.controller.ts` — `bulkWhitelist` (whitelist en masse)
- `server/src/services/ban.service.ts` — points d'intégration pré-ban (`createAutoBan`, calcul du delta agent)
- `server/src/services/agent.service.ts` — résolution de whitelist injectée dans la réponse de push (`handlePush`)
- `server/src/db/migrations/001_obliguard_schema.ts` — schéma table `ip_whitelist`
- `shared/src/types.ts` — types `WhitelistScope`, `IpWhitelist`, `CreateWhitelistRequest`
- `client/src/pages/WhitelistPage.tsx` — UI de gestion
