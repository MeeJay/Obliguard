Le serveur Obliguard (`server/`) est une application Express + TypeScript organisée en couches classiques **routes → controllers → services → db (Knex)**. Le code source vit sous `server/src/`, avec un découpage par domaine plutôt que par type technique pur : `services/` (14 services + sous-dossier `mikrotik/`), `controllers/` (23 fichiers), `routes/` (29 fichiers), plus `middleware/`, `socket-handlers/`, `notifications/`, `validators/`, `db/migrations/`.

## Démarrage (`server/src/index.ts`)

La fonction `main()` orchestre le boot dans un ordre précis :

1. `db.migrate.latest()` — applique les migrations Knex en attente au démarrage (pas de commande manuelle séparée en prod).
2. `authService.ensureDefaultAdmin(...)` — crée l'admin par défaut si absent.
3. `createApp()` (Express) puis `http.createServer(app)`.
4. `createSocketServer(server)` attache Socket.io, puis injection de l'instance `io` dans les services qui émettent des événements temps réel : `setAgentServiceIO(io)`, `setLiveAlertIO(io)` (et `setBanServiceIO(io)` côté `ban.service.ts`).
5. **Interception manuelle des upgrades WebSocket** : le serveur agent Obliguard (`/api/agent/ws`) et Socket.io partagent le même port HTTP. `index.ts` retire tous les listeners `upgrade` posés par Socket.io (`server.removeAllListeners('upgrade')`), les garde en mémoire, et pose son propre listener qui route vers `agentWss.handleUpgrade(...)` + `obliguardHub.register(...)` si le path matche `/^\/api\/agent\/ws$/`, sinon relaie aux listeners Socket.io d'origine. L'authentification agent se fait par header `X-Api-Key` validé contre `agent_api_keys`.
6. `banEngine.start()` — démarre le cycle d'évaluation des bans (30 s).
7. Démarrage des pollers MikroTik (`mikrotikLogPoller.start()`, `mikrotikImport.start()`), chargés en dynamic import.
8. `server.listen(config.port)`, puis sync des schémas de capacités avec Obligate (`obligateService.syncCapabilitySchemas()`, non-bloquant).
9. Plusieurs `setInterval` de fond sont armés après le listen : purge de rétention `ip_events` (`IP_EVENTS_RETENTION_DAYS`, défaut 90j, toutes les 6h), `agentCleanupTimer`, `banExpiryTimer` (désactivation des bans expirés), `remoteBlocklistTimer` (sync périodique des blocklists distantes). Tous sont nettoyés proprement (`clearInterval`) en cas d'arrêt.

## Chargement de l'environnement : `env.ts` et `knexfile.ts`

`server/src/env.ts` est le point d'entrée unique du chargement dotenv :

```ts
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
```

Il est importé en tout premier dans `index.ts` (`import './env';`) et dans `knexfile.ts` (`import './src/env';`) — c'est ce qui garantit que `DATABASE_URL` et les autres variables sont disponibles avant toute connexion Knex, y compris quand `knex` est invoqué en CLI (`npx knex migrate:latest`) indépendamment du serveur.

`server/knexfile.ts` définit un unique config Postgres avec résolution du chemin des migrations/seeds selon que le code tourne compilé (`.js` dans `dist/`) ou en dev via `tsx` (`.ts`) :

```ts
const isCompiled = __filename.endsWith('.js');
```

Le pool est configuré avec des valeurs pensées pour un déploiement multi-instance sur PostgreSQL partagé : `max` overridable via `DATABASE_POOL_MAX` (défaut 10), `acquireTimeoutMillis: 20000` (échec rapide plutôt que blocage indéfini si le pool est saturé), `idleTimeoutMillis: 30000` + `reapIntervalMillis: 1000` pour libérer les connexions inactives.

## Services clés

### `ban.service.ts` — moteur de bannissement

Deux classes distinctes dans le même fichier :

- **`BanService`** (exportée en singleton `banService`) : CRUD orienté API — `list()` (avec visibilité par tenant : un admin voit tout, un tenant non-master voit les bans `global` + les siens, jointure sur `ip_ban_exclusions` pour exposer `isExcludedByTenant`), `create()` (ban manuel, scope `global`/`tenant`/`group`/`agent`, rejet 409 si l'IP est déjà activement bannie), `promoteToGlobal()`, `lift()`, `excludeForTenant()` / `removeExclusion()` (exemptions par tenant sur un ban global), `computeBanDelta()` (calcule le delta add/remove à pousser à un agent donné). La création d'un ban manuel émet `ban:created` via Socket.io et pousse le ban aux devices MikroTik en fire-and-forget (`import('./mikrotik/mikrotikBanSync.service')`).
- **`BanEngine`** (singleton `banEngine`) : cron interne sans dépendance externe (`setInterval`, `BAN_ENGINE_INTERVAL_MS = 30_000`). `run()` a un **garde de ré-entrance** (`this.running`) : si un cycle précédent n'est pas terminé (contention DB), le tick suivant est sauté plutôt que de s'empiler. `evaluateThresholds()` :
  - récupère tous les `agent_devices` au statut `approved` ;
  - construit l'ensemble des `monitor_groups` en `evaluate_only` (dry-run) et l'ascendance de groupe de chaque device via `group_closure` ;
  - saute les devices en évaluation seule (flag propre ou hérité d'un groupe ancêtre) ;
  - résout la config de templates effective par device via `serviceTemplateService.resolveForAgent(dev.id, groupIds)` ;
  - ne traite que les templates activés en mode `ban` ;
  - pour chaque template, compte les `auth_failure` dans `ip_events` sur la fenêtre `windowSeconds`, et crée un ban global auto (`createAutoBan`) si le seuil est dépassé et l'IP non whitelistée.

### `obliguardHub.service.ts` — hub WebSocket agents

`ObliguardHubService` maintient une map `deviceUuid → ObliguardConn` (connexion WS active) et une map `offlineTimers` pour la grâce de déconnexion. Un `setInterval` de 15 s envoie un `ping()` à chaque connexion ouverte pour maintenir le lien à travers les reverse proxies.

`register(deviceUuid, tenantId, apiKeyId, clientIp, ws)` :
- annule le timer offline en cours si l'agent se reconnecte à temps ;
- ferme toute connexion existante pour le même UUID (remplacement) ;
- écoute les messages entrants et dispatch par `type` : `heartbeat` → `_handleHeartbeat`, `events` → `_handleEventsFlush`, `firewall_response` → `_resolveFirewallResponse` ;
- draine la `pending_command` en base au moment de la connexion (commandes mises en file pendant que l'agent était hors ligne).

À la déconnexion (`_unregister`), un timer offline est démarré via `_startOfflineTimer`, avec un délai = `checkIntervalSeconds × maxMissedPushes` résolu depuis les settings effectifs du device (agent → groupe → global), fallback 2 minutes. Ce mécanisme absorbe les reconnexions WS brèves sans faire clignoter l'UI. Le hub expose aussi `pushAndWait()` (mentionné dans le protocole) pour les commandes firewall requête-réponse avec corrélation par ID et timeout 30 s.

### `agent.service.ts` — le plus volumineux (1355 lignes)

Couvre la gestion complète du cycle de vie agent :
- clés API : `listKeys`, `createKey`, `deleteKey`, `getKeyById` ;
- devices : `listDevices`, `getDeviceById`, `getDeviceByUuid`, `countOnlineDevices`, `updateDevice`, `deleteDevice`, `bulkDeleteDevices`, `bulkUpdateDevices` ;
- cycle de vie : `approveDevice`, `suspendDevice`, `reinstateDevice`, `cleanupUninstalledDevices` ;
- commandes : `sendCommand`, `bulkSendCommand` ;
- **`handlePush`** (ligne ~630) : traite le push HTTP legacy (encore utilisé pour l'enregistrement initial de l'agent, avant bascule sur le canal WS) ;
- **`processEventsFlush`** (ligne ~1086) : ingestion des lots d'événements `auth_failure`/`auth_success` envoyés par un agent (WS ou HTTP), écriture dans `ip_events`, et déclenchement de la mise à jour de la réputation IP ;
- maintenance : `setDeviceUpdating`, `cleanupStuckUpdating` (détecte les agents bloqués en état "mise à jour" après un auto-update raté).

### `ipReputation.service.ts`

`IpReputationService` agrège les événements par IP dans la table `ip_reputation`. Fonctions clés : `upsertFromEvents()` (agrégation incrémentale depuis les événements bruts), `ensureExists()`, `list()` (avec filtre par `status`, dont un cas spécial `status='banned'` qui pilote la requête depuis `ip_bans` plutôt que `ip_reputation`), `getByIp()`. Le statut calculé (`clean` → `suspicious` → `banned`, plus `whitelisted`) résulte d'une expression SQL (`STATUS_CASE`) combinant présence dans `ip_bans`, dans la whitelist, et dépassement d'un seuil de baseline via `ip_reputation_clears` (soft-delete par tenant — une purge « efface » l'IP visuellement pour un tenant donné sans toucher aux données globales).

### `serviceTemplate.service.ts`

`ServiceTemplateService` gère les templates de détection (SSH, RDP, Nginx, Apache, IIS, FTP, Mail, MySQL) avec CRUD standard (`list`, `listLocal` pour les overrides agent/groupe, `create`, `update`, `delete`) et gestion des assignations (`upsertAssignment`, `deleteAssignment`). La fonction centrale est **`resolveForAgent(deviceId, groupIds)`** (ligne 358) qui applique la hiérarchie de résolution agent > groupe > défaut de template pour produire la config effective (seuil, fenêtre, mode `ban`/`track`, activé ou non) consommée à la fois par `BanEngine` et par la réponse de config poussée à l'agent. `getResolvedForDevice()` charge l'ascendance de groupe depuis la DB puis délègue à `resolveForAgent`. `requestLogSample()` permet de demander à l'agent un échantillon de logs bruts pour aider à calibrer une regex custom.

### `whitelist.service.ts`

CRUD classique (`listByScope`, `listAll`, `create`, `delete`) avec le même modèle de scoping hiérarchique que les bans (`global`/`tenant`/`group`/`agent`), support CIDR. `resolveWhitelistForAgent()` calcule la liste effective pour un agent donné, et `isWhitelisted()` est le point de contrôle appelé avant tout ban automatique (utilisé indirectement via `createAutoBan` dans `ban.service.ts`).

### `remoteBlocklist.service.ts`

Gère les blocklists distantes configurables (URL texte brut, une IP par ligne) et l'intégration guard.obli.tools. Fonctions : `list`, `create`, `update`, `delete`, `listIps`, `toggleIp`, `getStats`. Deux moteurs de synchronisation distincts :
- `syncOblitools(list)` : pull delta depuis obli.tools, transforme chaque entrée en ban (`reason: obli.tools: ... (N reports)`) ou en signalement suspicious selon la donnée reçue ;
- `syncUrl(list)` : parseur générique pour une URL de blocklist texte brut.

`pushNewBans()` est le sens inverse : POST vers `https://guard.obli.tools/blocklist/api/push` pour contribuer les bans locaux au réseau partagé. `syncAll()` boucle sur toutes les blocklists actives (déclenché par le `remoteBlocklistTimer` dans `index.ts`), `forceSync(id)` permet un déclenchement manuel depuis l'UI Settings.

## Pattern controllers / routes

Chaque domaine suit le même triptyque fichier-par-fichier : `routes/X.routes.ts` → `controllers/X.controller.ts` → `services/X.service.ts`. Exemple avec les bans :

- `routes/bans.routes.ts` monte les handlers avec `requireAuth` (toujours) et `requireRole('admin')` sur les opérations mutatives (`createBan`, `liftBan`, `promoteBan`, `wipeAllBans`, `bulkBan`, etc.). Un commentaire du code souligne un piège d'ordre de montage Express : `/stats` et `/wipe-*` doivent être déclarées **avant** `/:id`, sinon Express les interprète comme un paramètre `id`.
- `controllers/bans.controller.ts` contient des fonctions exportées individuellement (`getBanById`, `listBans`, `createBan`, …) typées `(req: Request, res: Response, next: NextFunction) => Promise<void>`, qui appellent `banService` et gèrent la sérialisation JSON de réponse (`{ success: true, data: ... }`) ainsi que les erreurs via `AppError` (`middleware/errorHandler`).
- Les controllers font parfois des requêtes DB directes complémentaires (ex. résolution du `bannedByUsername` dans `getBanById`) plutôt que de tout déléguer au service, quand la logique est purement liée à la présentation.

`routes/index.ts` agrège 29 sous-routers et les monte sur le router Express principal, avec deux catégories explicites :
- **routes globales** (pas de tenant requis) : `/auth`, `/agent` (auth par clé API), `/admin/config`, `/system`, `/profile/2fa`, `/live-alerts`, `/oblitools`, `/permission-sets` ;
- **routes tenant-scoped** (`requireAuth` + `requireTenant`) : `/tenants`, `/groups`, `/bans`, `/whitelist`, `/ip-events`, `/ip-reputation`, `/ip-labels`, `/service-templates`, `/remote-blocklists`, `/mikrotik`, etc.

Les routes spécifiques à l'IPS Obliguard sont regroupées sous un commentaire dédié dans `routes/index.ts` (`// Obliguard IPS routes`), les distinguant des routes héritées d'Obliview (auth, users, groups, notifications, teams, tenants, settings).
