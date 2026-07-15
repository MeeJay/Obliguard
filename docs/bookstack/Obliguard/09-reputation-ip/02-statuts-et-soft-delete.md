Chaque IP suivie par le module de réputation possède un statut calculé dynamiquement (pas stocké en base) : `clean` → `suspicious` → `banned`, avec un état parallèle `whitelisted`. Le calcul et les actions de nettoyage vivent dans `server/src/services/ipReputation.service.ts`, exposées via `server/src/controllers/ipReputation.controller.ts` et `server/src/routes/ipReputation.routes.ts`. Le type est défini dans `shared/src/types.ts` :

```ts
export type IpStatus = 'banned' | 'whitelisted' | 'suspicious' | 'clean';
```

### Calcul du statut

Le statut n'est pas une colonne mais le résultat d'une expression `CASE` SQL (constante `STATUS_CASE` dans `ipReputation.service.ts`, méthode `list()`) évaluée à la volée à partir de trois tables :

```sql
CASE
  WHEN b.id IS NOT NULL THEN 'banned'
  WHEN w.id IS NOT NULL THEN 'whitelisted'
  WHEN <suspiciousExpr> THEN 'suspicious'
  ELSE 'clean'
END
```

- `b` = jointure sur `ip_bans` (ban actif : `is_active = true` et `expires_at` nul ou futur)
- `w` = jointure sur `ip_whitelist` (contenance CIDR via l'opérateur `<<=`)
- `suspiciousExpr` dépend du contexte appelant :
  - **Admin plateforme ou tenant maître** (`isMasterTenant`) : `r.total_failures > 0`
  - **Utilisateur d'un tenant classique** : `r.total_failures > COALESCE(clr.baseline_failures, 0)` — la jointure `clr` pointe vers `ip_reputation_tenant_clears` (voir plus bas)

Les mêmes règles sont dupliquées (sans le `CASE` SQL, en JS) dans `getByIp()` et `getIpDetail()` pour la vue détail d'une IP unique.

Pour le statut `banned`, la requête `list()` change de table pilote : elle part de `ip_bans` (LEFT JOIN vers `ip_reputation`) plutôt que de `ip_reputation`, afin que les bans créés manuellement (sans événement `auth_failure` préalable, donc sans ligne de réputation) restent visibles.

### Le cycle clean → suspicious → banned

1. **clean** : aucune ligne `ip_reputation`, ou `total_failures = 0`, ou baseline de clear non dépassée pour le tenant.
2. **suspicious** : `total_failures > 0` (globalement) ou `total_failures` dépasse le baseline de clear du tenant courant. Une IP devient suspicious dès le premier `auth_failure` enregistré par `ipEvents`/`ban.service.ts`, avant même d'atteindre le seuil de ban du template de service.
3. **banned** : une ligne active existe dans `ip_bans` pour cette IP (créée par le moteur de ban `ban.service.ts` ou manuellement). Le statut `banned` est prioritaire sur tout le reste dans le `CASE`.

`whitelisted` court-circuite `suspicious`/`banned` dans l'affichage mais n'empêche pas un ban preexistant d'apparaître ailleurs — la priorité `banned > whitelisted` dans le `CASE` garantit qu'une IP activement bannie reste affichée comme `banned` même si elle est whitelistée après coup.

### Soft-delete du statut "suspicious" : `ip_reputation_tenant_clears`

Contrairement à ce que suggère le nom générique « clear », il ne s'agit pas d'une suppression des événements ni de la ligne `ip_reputation` : c'est un mécanisme de **baseline par tenant**, défini par la migration `server/src/db/migrations/008_ip_reputation_clears.ts` (nom de table effectif : `ip_reputation_tenant_clears`, PAS `ip_reputation_clears`).

Schéma de la table :

| Colonne | Type | Rôle |
|---|---|---|
| `id` | increments | PK |
| `ip` | text | IP concernée |
| `tenant_id` | integer, FK `tenants.id` (CASCADE) | Tenant qui a effectué le clear |
| `baseline_failures` | integer, défaut 0 | Valeur de `ip_reputation.total_failures` au moment du clear |
| `cleared_at` | timestamp | Date du clear |
| `cleared_by` | integer, FK `users.id` (SET NULL) | Utilisateur ayant effectué le clear |

Contrainte `UNIQUE(ip, tenant_id)` — un seul baseline actif par couple (IP, tenant), plus un index sur `ip`.

**Principe** : au lieu de supprimer les événements de brute-force (qui doivent rester pour l'audit et les autres tenants), on snapshotte le compteur `total_failures` courant dans `baseline_failures`. L'IP redevient `suspicious` pour ce tenant uniquement si de nouveaux échecs arrivent après le clear (`total_failures > baseline_failures`). C'est la logique de soft-delete : rien n'est effacé, seule la *visibilité du statut* change par tenant.

Deux chemins dans `ipReputation.service.ts` :

- **`clearForTenant(ip, tenantId, userId)`** — utilisé par les admins de tenant. Lit `total_failures` courant, puis `insert().onConflict(['ip','tenant_id']).merge()` sur `ip_reputation_tenant_clears` avec ce total comme `baseline_failures`.
- **`clearGlobal(ip)`** — réservé aux admins plateforme (option « nucléaire »). Remet `ip_reputation.total_failures` à `0` ET supprime **toutes** les lignes de clear pour cette IP (`ip_reputation_tenant_clears.where({ ip }).delete()`), puisque le compteur global repart de zéro et que les baselines par tenant deviennent obsolètes.

Route associée : `POST /api/ip-reputation/:ip/clear` (`ipReputation.routes.ts`, `requireRole('admin')`) → contrôleur `clearSuspicious` qui bascule entre `clearGlobal` (si `req.session.role === 'admin'`) et `clearForTenant` (sinon, avec `req.tenantId`).

Deux autres méthodes manipulent le même mécanisme :

- **`markSuspicious(ip)`** — upsert `ip_reputation` avec `total_failures = GREATEST(total_failures, 1)`, puis supprime tous les baselines de clear pour cette IP afin que le statut suspicious redevienne visible pour tous les tenants malgré d'anciens clears.
- **`markClean(ip, tenantId, isAdmin, userId)`** — garantit d'abord l'existence de la ligne `ip_reputation` (`ensureExists`), puis délègue à `clearGlobal` (admin) ou `clearForTenant` (tenant).

Le flag `clearedForTenant` renvoyé dans la réponse API (`IpReputation.clearedForTenant`, calculé via `clr.baseline_failures IS NOT NULL AS cleared_for_tenant` dans la requête `list()`, ou déduit dans `getByIp`/`getIpDetail`) indique si le tenant courant a un baseline actif — utile pour distinguer « jamais suspicious » de « nettoyé mais pourrait redevenir suspicious ».

### Visibilité par tenant

Pour les utilisateurs non-admin d'un tenant classique, `list()` restreint aussi l'ensemble des IP visibles à celles ayant des événements pour les agents de ce tenant :

```sql
WHERE EXISTS (
  SELECT 1 FROM ip_events e
  WHERE e.ip = r.ip AND e.tenant_id = :tenantId
)
```

Ce filtre est appliqué uniquement quand `tenantId && !isAdmin && !isMasterTenant(tenantId)` — les admins plateforme et le tenant maître voient toutes les IP sans restriction, et sans jointure sur `ip_reputation_tenant_clears` (donc sans notion de baseline : pour eux le seuil est simplement `total_failures > 0`).

### UI : `IPReputationPage.tsx`

La page (`client/src/pages/IPReputationPage.tsx`) est organisée en deux onglets de premier niveau (`PAGE_TABS`) :

```ts
const PAGE_TABS: { key: PageTab; label: string }[] = [
  { key: 'local', label: 'Local' },
  { key: 'remote', label: 'Remote' },
];
```

- **Local** → composant `ActivityTab` : liste les IP issues de `ip_reputation` / `ip_bans` via `GET /api/ip-reputation`, avec un second niveau de filtre par statut (`STATUS_FILTERS` : All, Banned, Suspicious, Whitelisted, Clean) et, pour les admins, un sélecteur de tenant (`selectedTenantId`) pour visualiser le baseline d'un tenant spécifique.
- **Remote** → composant `RemoteTab` : liste les IP issues des blocklists distantes (`remoteBlocklistApi.listIps`), indépendant du cycle de statut clean/suspicious/banned local (voir la page dédiée aux Remote Blocklists).

Dans `ActivityTab`, chaque ligne suspicious affiche un badge `StatusBadge` plus, le cas échéant, un badge secondaire "Cleared" (icône `Eraser`, `row.clearedForTenant`) signalant qu'un baseline de clear est actif pour le tenant courant :

```tsx
<StatusBadge status={row.status} />
{row.clearedForTenant && (
  <span className="... bg-blue-500/10 text-blue-400">
    <Eraser size={8} />Cleared
  </span>
)}
```

Le panneau de détail d'une IP suspicious affiche un message contextuel différent selon le rôle avant de proposer l'action de clear (`handleClear`, `POST /ip-reputation/:ip/clear`) :

- Admin plateforme : « Reset total_failures to 0 for ALL tenants (global clear). »
- Tenant déjà cleared (`clearedForTenant === true`) : « New failures occurred since your last clear. Clear again to reset. »
- Tenant jamais cleared : « Mark this IP as reviewed. It will become suspicious again if new failures arrive. »

Après un clear réussi, l'état local React est mis à jour de façon optimiste : `status: 'clean'` partout, et `clearedForTenant: false` pour un clear global (admin) ou `true` pour un clear par tenant.

### Résumé des transitions

| Depuis | Vers | Déclencheur | Effet base de données |
|---|---|---|---|
| clean | suspicious | Événement `auth_failure` reçu (`ban.service.ts`) ou `markSuspicious` manuel | `ip_reputation.total_failures` incrémenté / forcé à ≥1 |
| suspicious | banned | Seuil du template de service dépassé (`ban.service.ts`, cycle 30s) ou ban manuel | Insertion dans `ip_bans` |
| suspicious | clean (par tenant) | `POST /:ip/clear` (non-admin) | Upsert dans `ip_reputation_tenant_clears` (baseline = `total_failures` courant) |
| suspicious | clean (global) | `POST /:ip/clear` (admin) | `ip_reputation.total_failures = 0` + purge de `ip_reputation_tenant_clears` pour l'IP |
| banned | suspicious/clean | Levée du ban (`lift`) | `ip_bans.is_active = false` |
