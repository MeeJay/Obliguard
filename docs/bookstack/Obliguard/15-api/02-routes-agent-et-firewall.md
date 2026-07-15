Toutes les routes agent sont montées sous le préfixe `/api/agent` et définies dans `server/src/routes/agent.routes.ts`. Elles se répartissent en deux groupes : des routes **publiques** (authentifiées par clé API ou sans authentification, appelées par le binaire Go de l'agent) et des routes **admin** (session + rôle `admin` + tenant, appelées par le client React).

## Routes publiques (appelées par l'agent)

| Méthode | Route | Middleware | Handler |
|---|---|---|---|
| GET | `/ws` | — | garde-fou (voir ci-dessous) |
| POST | `/push` | `agentAuth` | `agentPush` |
| POST | `/notifying-update` | `agentAuth` | `notifyingUpdate` |
| GET | `/version` | — | `agentVersion` |
| GET | `/download/:filename` | — | `agentDownload` |
| GET | `/desktop-version` | — | `desktopVersion` |
| GET | `/installer/linux`, `/installer/windows`, `/installer/macos`, `/installer/freebsd` | — | scripts d'installation avec clé injectée |
| GET | `/installer/windows.msi` | — | `agentInstallerWindowsMsi` |
| POST | `/mikrotik/ingest` | — (token par device) | `ingestMikroTikSyslog` |

### Canal WebSocket `/api/agent/ws`

Le vrai canal de commandes temps réel n'est **pas** une route Express : c'est un upgrade HTTP intercepté directement dans `server/src/index.ts`. Le serveur retire tous les listeners `upgrade` posés par Socket.io, les sauvegarde (`sioUpgradeListeners`), puis pose son propre listener :

```ts
const OBLIGUARD_AGENT_WS_RE = /^\/api\/agent\/ws$/;
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (OBLIGUARD_AGENT_WS_RE.test(pathname)) {
    // authentification par X-Api-Key + ?uuid=... puis obliguardHub.register(...)
    return;
  }
  // sinon, transmis aux listeners d'origine de socket.io
});
```

L'authentification se fait via l'en-tête `X-Api-Key` (recherché dans `agent_api_keys`) et le paramètre de requête `?uuid=<device-uuid>`. Une fois validé, la connexion est enregistrée dans `obliguardHub.register()` (`server/src/services/obliguardHub.service.ts`), qui gère heartbeats, flush d'événements et dispatch de commandes.

La route `GET /agent/ws` déclarée dans `agent.routes.ts` (ligne 47) n'est qu'un **filet de sécurité** : si un reverse proxy mal configuré (ex. Nginx Proxy Manager sans "WebSocket Support") strip l'en-tête `Upgrade`, la requête tombe en `request` classique plutôt qu'en `upgrade`, et passerait alors par le routeur Express protégé par `requireAuth` — ce qui renverrait un 401 incompréhensible côté agent. Cette route renvoie à la place un 400 explicite :

```json
{ "error": "WebSocket upgrade required — enable WebSocket Support on the reverse-proxy host for this service" }
```

### `POST /agent/push` — push HTTP legacy

Protégé par le middleware `agentAuth` (`server/src/middleware/agentAuth.ts`), qui valide l'en-tête `X-API-Key` contre `agent_api_keys` et attache `agentApiKeyId` / `agentTenantId` à la requête. Le handler `agentPush` (`server/src/controllers/agent.controller.ts:10`) exige également l'en-tête `X-Device-UUID`, extrait l'IP client (`X-Forwarded-For` sinon `socket.remoteAddress`), puis délègue à `agentService.handlePush(agentApiKeyId, agentTenantId, deviceUuid, clientIp, req.body)`. Le code HTTP de retour dépend du statut renvoyé par le service : `ok` → 200, `pending` (device pas encore approuvé) → 202, autre → 401.

Ce push HTTP reste utilisé pour l'enregistrement initial d'un agent ; le canal WS le remplace ensuite pour les commandes en quasi temps réel (voir l'architecture du hub dans `obliguardHub.service.ts`).

### `POST /agent/notifying-update`

Appelé par l'agent juste avant de s'auto-mettre à jour, pour que le serveur sache qu'une déconnexion imminente est attendue (et ne la traite pas comme un agent offline). Vérifie que le device UUID appartient bien à la clé API authentifiée, puis appelle `agentService.setDeviceUpdating(device.id, agentTenantId)`.

### `GET /agent/version` et `/agent/desktop-version`

Renvoient les métadonnées de version courante (`agentService.getAgentVersion()` / `getDesktopVersion()`), utilisées par l'agent Go pour décider s'il doit s'auto-mettre à jour, et par le client React pour afficher une bannière de mise à jour du tray app.

### `GET /agent/download/:filename`

Sert les binaires d'agent compilés depuis `agent/dist/`. La liste des noms de fichiers autorisés est whitelistée en dur (`ALLOWED_AGENT_BINARIES`) pour éviter tout path traversal :

```ts
const ALLOWED_AGENT_BINARIES: Record<string, string> = {
  'obliguard-agent.msi':            'obliguard-agent.msi',
  'obliguard-agent.exe':            'obliguard-agent.exe',
  'obliguard-agent-linux-amd64':    'obliguard-agent-linux-amd64',
  'obliguard-agent-linux-arm64':    'obliguard-agent-linux-arm64',
  'obliguard-agent-darwin-amd64':   'obliguard-agent-darwin-amd64',
  'obliguard-agent-darwin-arm64':   'obliguard-agent-darwin-arm64',
  'obliguard-agent-freebsd-amd64':  'obliguard-agent-freebsd-amd64',
};
```

Le nom de fichier de la requête est utilisé comme clé de lookup — jamais concaténé directement au chemin disque.

### Scripts d'installation (`/installer/linux`, `/windows`, `/macos`, `/freebsd`)

Lisent un script modèle (`install.sh`, `install.ps1`, `install-macos.sh`, `install-freebsd.sh` dans `agent/installer/`), remplacent les placeholders `__SERVER_URL__` et `__API_KEY__` (ce dernier via `?key=` en query string) et renvoient le script en `Content-Disposition: attachment`.

### `/installer/windows.msi`

Sert directement `agent/dist/obliguard-agent.msi` (MSI pré-construit, statique — l'URL serveur et la clé API sont passées via propriétés `msiexec` au moment de l'exécution, pas injectées dans le fichier).

### Assistant d'installation hors-ligne (`/installer/wizard.exe`, `/installer/wizard-linux-amd64`)

Ces deux routes sont en réalité **admin-gated** (`requireAuth`, `requireRole('admin')`, `requireTenant`) malgré leur emplacement dans le fichier de routes, car elles embarquent une clé API en clair dans le binaire téléchargé. Le binaire de base (compilé séparément via `//go:embed` dans `agent/dist/`) reçoit un blob de configuration ajouté en fin de fichier :

```
[json {serverUrl, apiKey}][magic 8B "OBLI_CFG"][len uint32 LE]
```

La fonction `buildWizardPayload()` (`agent.controller.ts:247`) résout la clé via `?keyId=` (scopé au tenant, comme `listKeys`), construit le JSON, et concatène `baseBin + cfgBuf + CFG_MAGIC + lenBuf`. Ajouter des octets casse la signature Authenticode du wrapper (le MSI embarqué reste signé) : l'opérateur ne voit qu'un seul prompt SmartScreen "Exécuter quand même". Cela permet de déployer un agent pré-configuré sans réseau (clé USB, presse-papiers RDP, scp) sans jamais faire coller la clé API à l'admin.

### `POST /agent/mikrotik/ingest`

Point d'ingestion syslog HTTP pour les devices MikroTik, monté avec `express.text({ type: '*/*', limit: '1mb' })` (le corps arrive en texte brut syslog, pas en JSON). Authentifié par un token d'ingestion propre à chaque device (pas de session) — voir `mikrotik.controller.ts`.

## Routes admin (session + rôle admin + tenant)

### Clés API agent

| Route | Handler |
|---|---|
| GET `/keys` | `listKeys` |
| POST `/keys` | `createKey` |
| DELETE `/keys/:id` | `deleteKey` |

`createKey` exige un `name` non vide, associe `req.session.userId` et `req.tenantId`, et délègue à `agentService.createKey`.

### CRUD des devices agent

> Note d'ordre de déclaration dans `agent.routes.ts` : les routes statiques (`/devices/stats`, `/devices/bulk`, `/devices/bulk-command`) sont déclarées **avant** `/devices/:id`, sinon Express interpréterait le segment littéral `stats` ou `bulk` comme un `:id`.

| Route | Handler | Notes |
|---|---|---|
| GET `/devices/stats` | `getDeviceStats` | `{ online: agentService.countOnlineDevices(tenantId) }` |
| DELETE `/devices/bulk` | `bulkDeleteDevices` | body `{ deviceIds: number[] }` |
| PATCH `/devices/bulk` | `bulkUpdateDevices` | body `{ deviceIds, groupId?, heartbeatMonitoring?, overrideGroupSettings?, status? }` |
| POST `/devices/bulk-command` | `bulkDeviceCommand` | body `{ deviceIds, command }` |
| GET `/devices` | `listDevices` | filtre `?status=pending\|approved\|refused\|suspended` |
| GET `/devices/:id` | `getDevice` | |
| GET `/devices/:id/metrics` | `getDeviceMetrics` | renvoie toujours 404 — les agents Obliguard poussent des événements IP, pas des métriques matérielles (hérité d'Obliview) |
| GET `/devices/:id/templates` | `getDeviceTemplates` | résout les templates de service après avoir remonté la chaîne d'héritage de groupe, via `serviceTemplateService.getResolvedForDevice(id)` |
| PATCH `/devices/:id` | `updateDevice` | voir logique d'approbation ci-dessous |
| DELETE `/devices/:id` | `deleteDevice` | |
| POST `/devices/:id/command` | `sendDeviceCommand` | body `{ command }` |

`updateDevice` (`agent.controller.ts:346`) contient une logique conditionnelle non triviale sur le champ `status` :

- `status: 'approved'` sur un device actuellement `suspended` → réinstanciation (`agentService.reinstateDevice`) sans recréer de monitor.
- `status: 'approved'` sur un device `pending` → première approbation : `agentService.approveDevice(id, userId, groupId, agentThresholds)` crée le monitor de surveillance.
- `status: 'suspended'` → `agentService.suspendDevice(id)` met en pause le monitor.
- Si `agentThresholds` est fourni, `agentService.updateDeviceThresholds(id, agentThresholds)` est appelé indépendamment du statut.
- Les champs `maxMissedPushes`, `notificationTypes`, `wanMatchingEnabled`, `evaluateOnly` ne sont propagés à `agentService.updateDevice()` que s'ils sont explicitement présents dans `req.body` (via `'champ' in req.body`), pour distinguer "non fourni" de "explicitement remis à `null`/`false`".

## Commandes pare-feu (`server/src/controllers/firewall.controller.ts`)

Ces quatre routes pilotent la gestion des règles pare-feu **système** de l'agent (à distinguer des règles de ban Obliguard gérées par `agent/firewall.go`) :

| Route | Handler | Commande WS envoyée |
|---|---|---|
| GET `/devices/:id/firewall/rules` | `getFirewallRules` | `firewall_list` |
| POST `/devices/:id/firewall/rules` | `addFirewallRule` | `firewall_add` |
| DELETE `/devices/:id/firewall/rules/:ruleId` | `deleteFirewallRule` | `firewall_delete` |
| PATCH `/devices/:id/firewall/rules/:ruleId` | `toggleFirewallRule` | `firewall_toggle` |

Chaque handler suit le même schéma :

1. Résout l'UUID du device (`getDeviceUuid(deviceId)` — 404 `Device not found` si absent).
2. Construit une commande avec un `id` de corrélation (`randomUUID()`).
3. Appelle `obliguardHub.pushAndWait(uuid, cmd, timeoutMs = 30000)` (`server/src/services/obliguardHub.service.ts:295`) — envoie la commande sur le WS de l'agent et attend la réponse corrélée par `id`, avec un timeout par défaut de 30 secondes.
4. Si l'agent n'est pas connecté (`pushAndWait` rejette avec un message contenant `not connected`), la route répond 503 `Agent is not connected` via `AppError`. Toute autre erreur est propagée à `next(err)`.

Exemple pour `toggleFirewallRule` :

```ts
const result = await obliguardHub.pushAndWait(uuid, {
  type: 'firewall_toggle',
  id: randomUUID(),
  payload: { ruleId, enabled },
});
res.json({ success: true, data: result });
```

### Côté agent (`agent/firewall_rules.go`)

Le dispatch de ces commandes côté Go se fait dans `handleFirewallCommand()` (appelé depuis `cmd_ws.go`), qui délègue à l'implémentation `FirewallRuleManager` détectée pour la plateforme (`firewall_rules_windows.go` pour netsh, `firewall_rules_linux.go` avec 4 backends : nft, firewalld, ufw, iptables). L'interface commune :

```go
type FirewallRuleManager interface {
    ListRules() ([]FwRule, error)
    AddRule(req FwAddRequest) error
    DeleteRule(ruleID string) error
    ToggleRule(ruleID string, enabled bool) error
    PlatformName() string
}
```

Chaque règle unifiée (`FwRule`) transporte `direction` (`in`/`out`/`both`), `action` (`allow`/`block`), `protocol`, `localPort`, `remoteIp`, `enabled`, ainsi que `source` (`system` vs `obliguard`, pour distinguer les règles pré-existantes des règles créées par le moteur de ban) et `platform`. Après chaque `firewall_add` / `firewall_delete` / `firewall_toggle` réussi, l'agent renvoie systématiquement la liste à jour des règles (`resp.Rules`) dans la même réponse, évitant un aller-retour supplémentaire côté client React.
