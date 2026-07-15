Le canal de commande WebSocket remplace l'ancienne boucle de push HTTP : chaque agent maintient une connexion persistante vers le serveur, sur laquelle transitent les heartbeats, les événements d'authentification et les commandes serveur (config, pare-feu, ban, uninstall). Deux fichiers concentrent toute la logique :

- Serveur : `server/src/services/obliguardHub.service.ts` (classe `ObliguardHubService`)
- Agent Go : `agent/cmd_ws.go` (fonctions `runCmdWS` / `cmdWSSession`)

### Établissement de la connexion

L'endpoint WS est monté à la main sur le serveur HTTP existant, dans `server/src/index.ts`, en interceptant l'événement `upgrade` avant qu'il n'atteigne Socket.io :

```ts
const agentWss = new WebSocketServer({ noServer: true });
const OBLIGUARD_AGENT_WS_RE = /^\/api\/agent\/ws$/;

server.on('upgrade', (request, socket, head) => {
  if (OBLIGUARD_AGENT_WS_RE.test(pathname)) {
    // vérifie X-Api-Key + ?uuid=... puis appelle obliguardHub.register(...)
  }
  // sinon, transfert vers les listeners d'origine de socket.io
});
```

L'authentification se fait via deux éléments transmis à l'upgrade :

- Header `X-Api-Key` — résolu contre la table `agent_api_keys` (donne `tenant_id` et `apiKeyId`)
- Query param `uuid` — UUID matériel de l'agent (`?uuid=<DeviceUUID>`)

Une clé API absente ferme la socket avec le code `4003`, un UUID manquant avec `4000`, une clé invalide avec `4003`. Côté agent, l'URL est construite dans `cmdWSSession` (`agent/cmd_ws.go`) à partir de `cfg.ServerURL`, en remplaçant `http(s)://` par `ws(s)://` :

```go
wsURL := wsBase + "/api/agent/ws?uuid=" + url.QueryEscape(cfg.DeviceUUID)
ws, err := wsConnect(wsURL, http.Header{"X-API-Key": []string{cfg.APIKey}})
```

Une fois la connexion établie, `obliguardHub.register()` :

1. Annule un éventuel timer « offline » en attente (voir plus bas) si l'agent s'était déconnecté puis reconnecté à temps.
2. Ferme toute connexion existante pour ce même `deviceUuid` (remplacement, pas de doublons).
3. Enregistre les handlers `close`/`error`/`message` sur la socket.
4. Draine immédiatement `agent_devices.pending_command` s'il existe (commande mise en file pendant que l'agent était hors-ligne) et l'envoie sous forme d'un message `{ type: "config", command: ... }`.

### Heartbeat — toutes les 30 secondes

La cadence est fixée côté agent par la constante `cmdWSHeartbeatInterval = 30 * time.Second` dans `agent/cmd_ws.go`. Un `time.Ticker` déclenche `sendOGHeartbeat()` à chaque tick, en plus d'un premier heartbeat envoyé immédiatement à la connexion (pour enregistrer/mettre à jour l'agent en base et récupérer la config courante).

Message agent → serveur (`cmdHeartbeatMsg`) :

```json
{
  "type": "heartbeat",
  "hostname": "web01",
  "agentVersion": "1.4.2",
  "osInfo": { "platform": "linux", "distro": "ubuntu", "release": "22.04", "arch": "amd64" },
  "services": [{ "type": "ssh", "port": 22, "active": true }],
  "firewallBanned": ["203.0.113.5"],
  "firewallName": "nftables",
  "lanIPs": ["10.0.0.12"]
}
```

Ce message ne contient jamais d'événements — ceux-ci sont flushés séparément (voir ci-dessous). Côté serveur, `_handleHeartbeat()` (dans `obliguardHub.service.ts`) reconstruit un `ObliguardPushBody` (type partagé `shared/src/types.ts`, avec `events: []`) et appelle le pipeline complet `agentService.handlePush()` — identique à celui utilisé par l'ancien endpoint HTTP de push, ce qui garantit la même logique de résolution des bans, de la whitelist, des configs de service, etc.

La réponse serveur → agent est un message `{ type: "config", ... }` (type `cmdConfigMsg` côté Go / `ObliguardPushResponse` côté partagé), construit champ par champ : seuls les champs non vides sont inclus pour limiter la taille de la trame.

```json
{
  "type": "config",
  "pushIntervalSeconds": 30,
  "latestVersion": "1.4.3",
  "banList": { "add": ["198.51.100.7"], "remove": [] },
  "whitelist": ["10.0.0.0/8"],
  "services": { "ssh": { "enabled": true, "threshold": 5, "windowSeconds": 300 } },
  "command": "uninstall"
}
```

Si le statut de l'agent renvoyé par `handlePush` est `pending` ou `refused` (agent en attente d'approbation admin ou explicitement refusé), aucun message de config n'est envoyé — l'agent continue d'émettre des heartbeats sans jamais recevoir de banList tant qu'il n'est pas approuvé.

Côté agent, `applyOGConfig()` traite la réponse dans cet ordre :

1. `command` (ex. `"uninstall"`) — traité en priorité, court-circuite le reste.
2. `banList.add` / `banList.remove` — appliqués en goroutine (`fw.BanIP` / `fw.UnbanIP` puis `fw.Flush()`), car le flush peut être lent sous Windows avec de nombreuses règles.
3. `rateLimits` — toujours appelé via `fw.ApplyRateLimits()` si le backend le supporte (un tableau vide efface les règles précédentes).
4. `services` — met à jour `LogWatcher` (`lw.UpdateConfigs`) et persiste `cfg.ServiceConfigs` sur disque (`saveConfig`).
5. `latestVersion` — déclenche `applyUpdateIfNewer()` (auto-update MSI/binaire).

### Flush des événements — debounce 500 ms

Les événements d'authentification (échecs/succès SSH, RDP, etc.) ne suivent pas la cadence du heartbeat : ils sont poussés en quasi temps réel via un mécanisme de debounce, pour que la Starmap/NetMap et l'engine de ban voient l'activité en moins d'une seconde.

Constante : `cmdWSEventDebounce = 500 * time.Millisecond` (`agent/cmd_ws.go`). Fonctionnement dans `cmdWSSession` :

```go
case <-lw.FlushCh():
    // Nouveau signal du LogWatcher : (re)démarre la fenêtre de 500 ms
    debounce = time.After(cmdWSEventDebounce)

case <-debounce:
    debounce = nil
    events := lw.DrainEvents()
    if len(events) > 0 {
        sendOGEvents(ws, events)
    }
```

Chaque nouvel événement détecté par `LogWatcher` réarme la fenêtre de 500 ms ; tant que des événements arrivent en rafale, le flush est repoussé, ce qui regroupe les bursts en une seule trame WS au lieu d'en envoyer une par ligne de log.

Message agent → serveur (`cmdEventsMsg`) :

```json
{
  "type": "events",
  "events": [
    {
      "id": "a1b2c3d4",
      "ip": "203.0.113.5",
      "username": "root",
      "service": "ssh",
      "eventType": "auth_failure",
      "timestamp": "2026-07-04T10:15:32Z",
      "rawLog": "Failed password for root from 203.0.113.5 port 51422 ssh2"
    }
  ]
}
```

Côté serveur, `_handleEventsFlush()` résout le `deviceId` (mis en cache dans `ObliguardConn.deviceId` dès le premier heartbeat ou la première trame reçue) puis appelle `agentService.processEventsFlush(deviceId, tenantId, events)` — un pipeline allégé qui ne traite que l'enrichissement, l'insertion en base, la réputation IP et l'émission Starmap, sans le coût du cycle complet de `handlePush` (pas de recalcul de banList/whitelist/services à chaque flush).

### Autres types de messages

| Direction | `type` | Rôle |
|---|---|---|
| agent → serveur | `heartbeat` | Statut périodique (30 s) |
| agent → serveur | `events` | Flush d'événements (debounce 500 ms) |
| agent → serveur | `firewall_response` | Réponse à une commande pare-feu (corrélée par `id`) |
| serveur → agent | `config` | Réponse au heartbeat (banList, whitelist, services, command, version) |
| serveur → agent | `firewall_list` / `firewall_add` / `firewall_delete` / `firewall_toggle` | Commandes de gestion des règles pare-feu (voir `firewall_rules.go`) |

Les commandes pare-feu suivent un modèle requête-réponse avec corrélation par identifiant, implémenté par `pushAndWait()` dans `obliguardHub.service.ts` : la commande est poussée via `push()`, puis une `Promise` est enregistrée dans `firewallWaiters` (Map `id → { resolve, timer }`) avec un timeout de 30 s. Quand l'agent répond avec `{ type: "firewall_response", id: ... }`, `_resolveFirewallResponse()` retrouve le waiter correspondant et résout la promesse ; en absence de réponse, le timer rejette avec `Agent did not respond within 30s`.

### Ping/pong de maintien de connexion

Indépendamment du heartbeat applicatif (30 s), le serveur envoie un ping WebSocket bas-niveau toutes les 15 s à chaque connexion active (constructeur de `ObliguardHubService`), pour garder la connexion ouverte à travers les reverse proxies :

```ts
setInterval(() => {
  for (const [uuid, conn] of this.byDevice) {
    if (conn.ws.readyState === 1) conn.ws.ping();
  }
}, 15_000);
```

Côté agent, `cmdWSReadTimeout = 60 * time.Second` : toute trame (message ou ping) réinitialise le délai de lecture ; l'absence de trame pendant 60 s (soit 4 pings manqués) provoque la fermeture de la session et un cycle de reconnexion.

### Détection hors-ligne et grâce

Quand une socket se ferme (`ws.on('close')` / `ws.on('error')`), `_unregister()` retire la connexion de `byDevice` et démarre un timer de grâce via `_startOfflineTimer()`. Le délai est calculé à partir des réglages résolus de l'agent (hiérarchie agent → groupe → global) :

```
delaySec = checkIntervalSeconds × maxMissedPushes
```

(valeurs par défaut : `checkIntervalSeconds = 60`, `maxMissedPushes = 2`, soit 120 s si l'agent n'est pas résolu). Si l'agent se reconnecte avant l'expiration du timer, `register()` l'annule silencieusement. Sinon, à expiration, un événement Socket.io `AGENT_STATUS_CHANGED` (`{ deviceId, status: 'down', wsConnected: false }`) est émis vers la room `role:admin`.

`isConnected(deviceUuid)` renvoie `true` tant que la socket est ouverte **ou** qu'un timer de grâce est encore en cours — ce qui évite un clignotement de l'UI (« offline » puis « online ») lors de courtes coupures réseau ou de redémarrages de l'agent.

### Reconnexion agent (backoff exponentiel)

Si la session WS se termine (erreur réseau, timeout de lecture, fermeture propre), `runCmdWS()` boucle indéfiniment et retente la connexion avec un backoff exponentiel :

```go
cmdWSReconnectBase = 2 * time.Second
cmdWSReconnectMax  = 60 * time.Second
// next = backoff × 1.5, plafonné à 60 s
```

Une fermeture propre (`err == nil`, opcode `0x8`) réinitialise le backoff à sa valeur de base ; toute autre erreur applique la progression ×1.5 jusqu'au plafond de 60 s.

### Commandes hors-ligne en file d'attente

Si `push(deviceUuid, cmd)` est appelé alors que l'agent n'est pas connecté (`byDevice` ne contient pas de socket ouverte pour cet UUID), la méthode renvoie `false` sans lever d'exception — libre à l'appelant de retomber sur la colonne `agent_devices.pending_command` en base pour une livraison différée. Cette colonne est vidée (`update({ pending_command: null })`) puis livrée dès que l'agent se reconnecte, via `_drainPendingCommand()`, avant même le traitement du premier heartbeat.
