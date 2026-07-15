Chaque template de service (`service_templates`) définit un **seuil**, une **fenêtre temporelle** et un **mode**. Ces trois valeurs peuvent être surchargées à deux niveaux de la hiérarchie (groupe puis agent) via la table `service_template_assignments`. C'est `serviceTemplateService.resolveForAgent()` (`server/src/services/serviceTemplate.service.ts`) qui calcule la configuration effective consommée par le moteur de ban.

## Seuil et fenêtre temporelle

Colonnes sur `service_templates` :

- `threshold` (integer) — nombre d'échecs d'authentification à atteindre
- `window_seconds` (integer) — fenêtre glissante sur laquelle les échecs sont comptés

Valeurs par défaut à la création d'un template custom (`ServiceTemplateService.create`) : `threshold: 5`, `window_seconds: 300` (5 échecs en 5 minutes) si non fournis.

Le moteur de ban (`server/src/services/ban.service.ts`, classe `BanEngine`) tourne toutes les 30 secondes (`BAN_ENGINE_INTERVAL_MS = 30_000`) et, pour chaque template actif en mode `ban`, exécute une requête de comptage par IP :

```sql
SELECT ip, tenant_id, count(id) AS failure_count
FROM ip_events
WHERE device_id = ?
  AND service = ?
  AND event_type = 'auth_failure'
  AND track_only = false
  AND timestamp >= now() - (window_seconds * interval '1 second')
GROUP BY ip, tenant_id
HAVING count(id) >= threshold
```

Chaque IP dont le compte dépasse le seuil déclenche `createAutoBan()` (ban global, type `auto`), sous réserve qu'elle ne soit pas whitelistée et pas déjà bannie.

## Mode `ban` vs `track`

Colonne `service_templates.mode` (`varchar(20)`, défaut `'ban'`), ajoutée par la migration `002_service_template_mode.ts` :

- **`ban`** — les événements du service comptent pour le moteur de ban ; un dépassement de seuil crée un ban IP automatique.
- **`track`** — les événements sont journalisés (visibles dans Live Events, IP Reputation, etc.) mais **ne comptent jamais** pour un ban.

La bascule se fait en deux endroits :

1. À l'ingestion des événements (`agent.service.ts`, `handlePush()`), chaque service dont le template résolu a `cfg.mode === 'track'` est ajouté à un set `trackOnlyServices` ; l'événement inséré porte alors `track_only: true` (colonne `ip_events.track_only`, migration `002`).
2. Dans `BanEngine.evaluateThresholds()`, seuls les templates avec `cfg.enabled && cfg.mode === 'ban'` sont retenus (`activeTemplates`), et la requête de comptage filtre explicitement `where('track_only', false)`.

Un index partiel accélère ce filtrage :

```sql
CREATE INDEX idx_ip_events_track_only ON ip_events(track_only) WHERE track_only = false;
```

`mode: 'track'` est donc l'outil pour observer un service (ex : tester une regex custom, surveiller un service annexe) sans risquer de bannir des IP légitimes tant que le comportement n'est pas validé.

## Modèle opt-in (activation explicite)

Depuis la migration `007_template_inactive_default.ts`, **tous les templates globaux** (`owner_scope IS NULL`) sont créés avec `enabled = false`. Avant cette migration, un template global était actif par défaut sur tous les agents (modèle opt-out), ce qui posait problème — par exemple le template RDP se déclenchait sur des agents Linux, ou le template Nginx sur des machines personnelles sans usage de reverse proxy.

Un groupe ou un agent doit donc explicitement **activer** un template via une entrée `service_template_assignments` avec `enabled_override = true` pour que le `BanEngine` compte ses événements. Les templates tenant-scoped (custom, non globaux) conservent leur état `enabled` d'origine et ne sont pas affectés par cette migration.

## Assignation hiérarchique : agent > groupe > défaut

`resolveForAgent(deviceId, groupIds)` calcule, pour un agent donné, la configuration effective de chaque template en suivant cet ordre de priorité (le premier trouvé gagne) :

```
agent assignment override > assignment du groupe ancêtre le plus proche > valeur par défaut du template
```

Concrètement pour `threshold`, `windowSeconds`, `logPath` et `enabled` :

```ts
const threshold =
  agentAssignment?.threshold_override ??
  groupAssignment?.threshold_override ??
  tpl.threshold;
```

`groupIds` est un tableau ordonné des groupes ancêtres de l'agent, du plus proche (`depth = 0`, l'agent lui-même) au plus lointain, obtenu via la closure table `group_closure`. Pour les assignations de niveau groupe, seul le premier ancêtre possédant une entrée dans `service_template_assignments` est retenu (`groupAssignmentByTemplate`, boucle qui s'arrête au premier match par template).

Le résultat expose aussi la provenance de chaque surcharge pour l'UI :

- `enabledOverrideScope: 'agent' | 'group' | null`
- `thresholdOverrideScope: 'agent' | 'group' | null`

Une entrée d'assignation avec `enabled_override = false` au niveau groupe ou agent agit comme un **"unbind"** explicite : elle désactive le template pour cette portée même s'il est activé plus haut dans la hiérarchie (par ex. un template global activé au niveau groupe, mais désactivé pour un agent précis).

Deux méthodes de résolution sont exposées :

- `resolveForAgent(deviceId, groupIds)` / `getResolvedForDevice(deviceId)` — configuration effective pour un agent précis (inclut les overrides agent + groupe).
- `getResolvedForGroup(groupId)` — état effectif au niveau d'un groupe (overrides des groupes ancêtres uniquement, sans tenir compte d'un agent spécifique), utilisé pour l'écran de gestion de groupe.

## Templates locaux (migration 003)

La migration `003_local_templates.ts` ajoute deux colonnes à `service_templates` :

- `owner_scope` (`varchar(20)`, nullable) — `'agent'`, `'group'` ou `NULL` (template global)
- `owner_scope_id` (integer, nullable) — FK logique vers `agent_devices.id` ou `monitor_groups.id`

Un index partiel optimise les recherches par propriétaire :

```sql
CREATE INDEX idx_service_templates_owner ON service_templates(owner_scope, owner_scope_id)
WHERE owner_scope IS NOT NULL;
```

Caractéristiques des templates locaux :

- Ils ne sont **jamais** visibles dans la liste globale (`ServiceTemplateService.list()` exclut systématiquement `owner_scope IS NOT NULL`) — ils n'apparaissent que sur la page de détail de l'agent ou du groupe propriétaire, via `listLocal(scope, scopeId)`.
- À la création (`create()`), si `data.ownerScope` et `data.ownerScopeId` sont fournis, le service insère automatiquement une assignation vers le propriétaire (`onConflict(...).ignore()` pour éviter les doublons) — pas besoin d'une étape d'activation séparée.
- Dans `resolveForAgent()`, les templates de type `owner_scope = 'group'` appartenant au groupe direct de l'agent (`groupIds[0]`) sont fusionnés avec les templates globaux (`allTemplates = [...globalTemplates, ...groupOwnedTemplates]`). Contrairement aux templates globaux, ils ne subissent pas de résolution d'override au niveau groupe (`groupAssignment: null` forcé) — seul un override agent est possible, puisqu'ils appartiennent déjà à un groupe précis.
- Les templates locaux de type `owner_scope = 'agent'` ne sont pas remontés par `resolveForAgent` en tant que templates du groupe ; ils sont créés et assignés directement à l'agent concerné.

Les templates locaux permettent typiquement de définir une regex custom ou un seuil spécifique pour un service atypique détecté sur un seul agent ou groupe, sans polluer la liste des templates globaux partagés par tout le tenant.

## Suppression et contraintes

`delete()` interdit la suppression d'un template built-in (`is_builtin = true`). Pour un template custom, les assignations liées sont supprimées en premier (contrainte FK) avant le template lui-même. La modification (`update()`) interdit également de définir `custom_regex` sur un template built-in.
