Le moteur de bans d'Obliguard est implémenté dans `server/src/services/ban.service.ts`. Il expose deux briques distinctes dans le même fichier :

- `BanService` (classe `banService`) : CRUD des bans (création manuelle, promotion en global, levée, exclusions par tenant, calcul du delta à pousser à un agent).
- `BanEngine` (classe `banEngine`) : le cron d'évaluation qui scrute les événements d'authentification et crée les bans automatiques.

Cette page couvre le fonctionnement du `BanEngine`.

## Cycle d'évaluation (toutes les 30 secondes)

```ts
const BAN_ENGINE_INTERVAL_MS = 30_000;
```

`banEngine.start()` arme un `setInterval` de 30 s qui appelle `run()`. Le moteur est démarré une seule fois au boot du serveur (import de `banEngine` + `start()` dans le bootstrap).

`run()` implémente un **garde de réentrance** via le flag `this.running` : si un cycle précédent est encore en cours (par exemple parce que `resolveForAgent` traîne à cause d'une contention DB), le tick suivant est **sauté** plutôt que d'empiler des exécutions concurrentes qui saturent le pool de connexions PostgreSQL :

```ts
if (this.running) {
  logger.warn('BanEngine: previous cycle still running — skipping this tick');
  return;
}
```

Chaque cycle exécute `evaluateThresholds()`, encapsulé dans un try/catch qui logue toute erreur sans crasher le process.

## Résolution des agents et des templates

`evaluateThresholds()` déroule les étapes suivantes :

1. **Récupère tous les agents `approved`** (`agent_devices` où `status = 'approved'`), avec `id`, `group_id`, `tenant_id`, `evaluate_only`. Si aucun agent, sortie immédiate.
2. **Charge l'ensemble des groupes en mode `evaluate_only`** (`monitor_groups.evaluate_only = true`) — un mode "dry-run" au niveau groupe.
3. **Pré-calcule l'ascendance de groupe de chaque device** en une passe, via la table de fermeture transitive `group_closure` (`descendant_id` → liste d'`ancestor_id`, triée par `depth`).
4. Pour chaque device :
   - Si le device a `evaluate_only = true`, **ou** si l'un de ses groupes ancêtres est dans `evalOnlyGroups`, il est **ignoré** — les événements sont observés mais aucun ban automatique n'est jamais créé pour cet agent (mode dry-run hérité).
   - Sinon, appelle `serviceTemplateService.resolveForAgent(dev.id, groupIds)` (voir `server/src/services/serviceTemplate.service.ts`) pour obtenir la configuration effective de chaque service, avec héritage **agent > groupe > template par défaut** (`threshold_override`, `window_seconds_override`, `enabled_override`).
   - Filtre les templates résolus pour ne garder que ceux **actifs et en mode `ban`** : `resolved.filter(cfg => cfg.enabled && cfg.mode === 'ban')`. Les templates en mode `track` ne comptent jamais pour un auto-ban — ils ne servent qu'à journaliser.
   - Les templates sont **opt-in** : un template doit être explicitement activé (`enabled_override = true`) au niveau groupe ou agent pour compter dans les auto-bans.

## Comptage des échecs d'authentification par IP

Pour chaque configuration de service active (`cfg`), le moteur calcule la fenêtre temporelle glissante :

```ts
const windowStart = new Date(Date.now() - cfg.windowSeconds * 1000);
```

puis exécute une requête d'agrégation sur `ip_events` :

```ts
const results = await db('ip_events')
  .select('ip', 'tenant_id')
  .count('id as failure_count')
  .where('device_id', dev.id)
  .where('service', cfg.serviceType)
  .where('event_type', 'auth_failure')
  .where('track_only', false)
  .where('timestamp', '>=', windowStart)
  .groupBy('ip', 'tenant_id')
  .havingRaw('count(id) >= ?', [cfg.threshold]);
```

Points clés de cette requête :

- **Scope par device** (`device_id`) et par **type de service** (`service`) — le comptage est fait indépendamment par agent et par service, pas de manière globale.
- Seuls les événements `event_type = 'auth_failure'` comptent (les succès d'authentification, ou d'autres types d'événements, sont ignorés).
- `track_only = false` exclut les événements générés par des templates en mode `track` uniquement.
- `HAVING count(id) >= threshold` : seules les IP qui **dépassent ou atteignent** le seuil configuré ressortent du groupby, avec `tenant_id` pour connaître le tenant d'origine.

Pour chaque IP en dépassement, `createAutoBan(ip, tenant_id, cfg.serviceType, failureCount)` est appelée.

## Création de l'auto-ban (`createAutoBan`)

Cette méthode privée applique une série de vérifications avant de créer le ban :

### 1. Vérification de doublon

```ts
const existing = await db('ip_bans')
  .where('ip', ip)
  .where('scope', 'global')
  .where('is_active', true)
  .first();

if (existing) return; // Already banned globally
```

Contrairement à `banService.create()` (ban manuel via API, qui répond **409** au contrôleur si un ban actif existe déjà pour l'IP), l'auto-ban se contente de **retourner silencieusement** si l'IP est déjà bannie globalement — pas d'erreur, pas de log, le cycle continue sur les IP suivantes. Le 409 explicite (`This IP is already banned`) est réservé au chemin de création manuelle exposé par l'API (`server/src/controllers` sur la route `/bans`).

### 2. Vérification whitelist

```ts
const whitelisted = await db('ip_whitelist')
  .where('scope', 'global')
  .whereRaw('?::inet << ip', [ip])
  .first();

if (whitelisted) return;
```

Le moteur ne vérifie que la whitelist de **scope global** au moment de l'auto-ban (l'opérateur PostgreSQL `<<` teste l'inclusion CIDR : l'IP candidate est-elle contenue dans une entrée de la whitelist). Les whitelists de scope tenant/groupe/agent ne sont pas court-circuitées ici — elles sont appliquées plus tard, côté agent, via `banService.computeBanDelta()` qui filtre le delta poussé à chaque agent selon `resolvedWhitelist`.

### 3. Insertion du ban

Si les deux checks passent, insertion dans `ip_bans` :

```ts
await db('ip_bans').insert({
  ip,
  scope: 'global',
  ban_type: 'auto',
  origin_tenant_id: originTenantId,
  reason: `Auto-ban: ${failureCount} ${service} auth failures`,
  is_active: true,
});
```

Tous les bans créés par le moteur sont **`scope: 'global'`** et **`ban_type: 'auto'`** — ils s'appliquent donc à tous les agents de l'installation (sous réserve d'exclusion par tenant, voir `ip_ban_exclusions`). Le champ `reason` embarque directement le nombre d'échecs et le service concerné, ce qui alimente l'affichage dans `BansPage.tsx`.

### 4. Effets de bord après création

Une fois le ban inséré, plusieurs actions asynchrones (best-effort, non bloquantes) sont déclenchées :

- `ipReputationService.ensureExists(ip)` — garantit qu'une ligne de réputation existe pour cette IP dans le module IP Reputation, même si les événements bruts ont été traités avant le correctif d'upsert.
- `_io?.emit('ban:auto', { ip, service, failureCount, originTenantId })` — notifie les clients connectés en temps réel via Socket.io.
- Import dynamique de `mikrotikBanSync.service` puis `pushBanToAll(ip, 'ban')` (fire-and-forget) — propage le ban aux devices MikroTik configurés.
- **Marquage "sous attaque"** des agents d'origine : recherche des `device_id` distincts ayant généré un événement `auth_failure` pour cette IP sur les **10 dernières minutes** (`ip_events` filtré par `tenant_id = originTenantId`), puis :
  - mise à jour de `agent_devices.last_attack_at = now()` pour ces devices,
  - envoi d'une notification `attack` par device concerné via `notificationService.sendForAgent(devId, label, 'attack', 'ok', [...], 'attack')`, avec le nom ou le hostname de l'agent en libellé.

Cette dernière étape est encapsulée dans son propre try/catch : un échec de mise à jour de `last_attack_at` ou d'envoi de notification n'annule pas le ban déjà créé.

## Résumé du flux complet

```
setInterval (30s)
  └─ run()                                  garde de réentrance (this.running)
       └─ evaluateThresholds()
            ├─ agent_devices (status=approved)
            ├─ monitor_groups.evaluate_only  → set des groupes dry-run
            ├─ group_closure                  → ascendance par device
            └─ pour chaque device non evaluate-only :
                 ├─ serviceTemplateService.resolveForAgent()
                 ├─ filtre templates enabled && mode='ban'
                 └─ pour chaque template :
                      ├─ COUNT(auth_failure) par IP sur window_seconds, HAVING >= threshold
                      └─ pour chaque IP en dépassement : createAutoBan()
                           ├─ skip si déjà banni globalement (silencieux, pas de 409)
                           ├─ skip si whitelist globale (CIDR '<<')
                           ├─ INSERT ip_bans (scope=global, ban_type=auto)
                           ├─ ipReputationService.ensureExists()
                           ├─ emit 'ban:auto' (Socket.io)
                           ├─ mikrotikBanSync.pushBanToAll(ip, 'ban')
                           └─ last_attack_at + notification 'attack' par agent d'origine
```

## Différences avec le ban manuel

| | Auto-ban (`BanEngine`) | Ban manuel (`banService.create`) |
|---|---|---|
| Déclencheur | Cycle cron 30s, seuil dépassé | Appel API (`POST /bans`) |
| Scope | Toujours `global` | `global` (admin) ou `tenant` (défaut) |
| Doublon | Retour silencieux si déjà banni | Exception `'This IP is already banned'` → 409 côté contrôleur |
| `ban_type` | `auto` | `manual` |
| Whitelist | Vérifiée (scope global uniquement) avant insertion | Non vérifiée à la création (c'est `computeBanDelta` qui filtre côté agent) |
| Notifications | `ban:auto` + notification `attack` par agent d'origine | `ban:created` uniquement |

La distribution effective des bans vers les agents ne se fait pas dans le moteur lui-même : elle est calculée à la demande par `banService.computeBanDelta(deviceId, groupIds, tenantId, agentCurrentBans, resolvedWhitelist)`, appelée lors de la construction de la configuration poussée à chaque agent (heartbeat / réponse de config via `server/src/services/obliguardHub.service.ts`). C'est à ce moment que le whitelisting hiérarchique complet (global/tenant/groupe/agent) et les exclusions par tenant (`ip_ban_exclusions`) sont pleinement appliqués.
