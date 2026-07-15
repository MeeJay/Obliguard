Le hub WebSocket (`server/src/services/obliguardHub.service.ts`) expose deux mécanismes de livraison de commande vers un agent : un envoi instantané "fire-and-forget" via `push()`, et un pattern request-response synchrone via `pushAndWait()` utilisé exclusivement par les commandes de gestion du pare-feu système. Un troisième canal, la colonne `pending_command` en base, sert de file d'attente pour les agents hors ligne.

### `push()` — envoi instantané fire-and-forget

```ts
push(deviceUuid: string, cmd: OrCommand): boolean {
  const conn = this.byDevice.get(deviceUuid);
  if (!conn || conn.ws.readyState !== 1) return false;
  try {
    conn.ws.send(JSON.stringify(cmd));
    return true;
  } catch {
    this._unregister(deviceUuid, conn.ws);
    return false;
  }
}
```

`push()` recherche la connexion active dans la map interne `byDevice` (clé = UUID de l'agent) et envoie la commande si le WebSocket est `OPEN` (`readyState === 1`). Elle retourne `true` si livrée, `false` si l'agent est hors ligne — dans ce cas l'appelant doit se rabattre sur la file `pending_command` en base (voir plus bas). Ce chemin est utilisé pour les commandes qui ne nécessitent pas de réponse synchrone, comme le `command: 'uninstall'` posé par `agentService.sendCommand()` (`server/src/services/agent.service.ts`).

### `pushAndWait()` — pattern request-response avec corrélation

Les commandes pare-feu (`firewall_list`, `firewall_add`, `firewall_delete`, `firewall_toggle`) exigent une réponse de l'agent avant que l'API HTTP ne puisse répondre au client. `pushAndWait()` implémente ce pattern :

```ts
private firewallWaiters = new Map<string, { resolve: (val: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

async pushAndWait(deviceUuid: string, cmd: OrCommand, timeoutMs = 30000): Promise<unknown> {
  const delivered = this.push(deviceUuid, cmd);
  if (!delivered) throw new Error('Agent is not connected');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      this.firewallWaiters.delete(cmd.id);
      reject(new Error('Agent did not respond within ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);
    this.firewallWaiters.set(cmd.id, { resolve, timer });
  });
}
```

Déroulé :

1. La commande porte un champ `id` — un UUID généré côté serveur avec `crypto.randomUUID()` — qui sert d'identifiant de corrélation.
2. `push()` est appelé pour livrer la commande immédiatement. Si l'agent n'est pas connecté, `pushAndWait()` lève `Error('Agent is not connected')` sans attendre — aucune file d'attente n'est utilisée pour les commandes pare-feu (voir section "Pas de fallback offline" ci-dessous).
3. Une `Promise` est créée et son `resolve` est stocké dans la map `firewallWaiters`, indexée par `cmd.id`, avec un timer de timeout de 30 secondes (`timeoutMs = 30000` par défaut).
4. Quand l'agent répond avec une frame `{ type: 'firewall_response', id, ... }`, le handler `message` du WS route vers `_resolveFirewallResponse(msg)` :

```ts
private _resolveFirewallResponse(msg: { id?: string; [k: string]: unknown }): void {
  if (!msg.id) { logger.warn('Firewall response without id — ignoring'); return; }
  const waiter = this.firewallWaiters.get(msg.id);
  if (!waiter) { logger.warn({ msgId: msg.id }, 'Firewall response for unknown/expired waiter'); return; }
  clearTimeout(waiter.timer);
  this.firewallWaiters.delete(msg.id);
  waiter.resolve(msg);
}
```

Le waiter est retrouvé via `msg.id`, le timer annulé, l'entrée supprimée de la map, et la `Promise` résolue avec le message complet (incluant `success`, `rules`, `error`, etc.). Si la réponse arrive après expiration du timeout, ou porte un `id` inconnu, elle est simplement ignorée avec un `logger.warn`.

5. Si aucune réponse n'arrive dans les 30 secondes, le `setTimeout` rejette la `Promise` avec `Error('Agent did not respond within 30s')` et nettoie l'entrée de `firewallWaiters`.

### Consommateurs : `firewall.controller.ts`

Les quatre routes de gestion du pare-feu (`server/src/controllers/firewall.controller.ts`) suivent toutes le même schéma :

```ts
const cmdId = randomUUID();
const result = await obliguardHub.pushAndWait(uuid, {
  type: 'firewall_list',
  id: cmdId,
  payload: {},
});
res.json({ success: true, data: result });
```

| Fonction | Type de commande | Payload |
|---|---|---|
| `getFirewallRules` | `firewall_list` | `{}` |
| `addFirewallRule` | `firewall_add` | corps de la requête (`name`, `direction`, `action`, `protocol`, `localPort`, `remoteIp`) |
| `deleteFirewallRule` | `firewall_delete` | `{ ruleId }` |
| `toggleFirewallRule` | `firewall_toggle` | `{ ruleId, enabled }` |

Chaque contrôleur intercepte l'erreur `'not connected'` levée par `pushAndWait()` et la traduit en `503 Agent is not connected` (via `AppError`), plutôt que de la laisser remonter en `500`.

### Côté agent Go : `firewall_rules.go` et `cmd_ws.go`

Dans `agent/cmd_ws.go`, `handleOGServerFrame()` dispatche les frames entrantes selon `env.Type` (décodé à la volée depuis une enveloppe minimale `{ type, id }`). Pour les quatre types de commandes pare-feu, un handler est lancé en goroutine :

```go
case "firewall_list", "firewall_add", "firewall_delete", "firewall_toggle":
    frm := DetectFirewallRuleManager()
    go handleFirewallCommand(frm, env.Type, env.ID, payload, func(data []byte) {
        ws.SendText(data)
    })
```

`handleFirewallCommand()` (`agent/firewall_rules.go`) extrait le champ `payload` imbriqué du message brut, exécute l'opération correspondante via l'implémentation `FirewallRuleManager` détectée pour la plateforme (`firewall_rules_windows.go` pour netsh, `firewall_rules_linux.go` pour nft/firewalld/ufw/iptables), puis construit une `FwResponse` :

```go
type FwResponse struct {
    Type     string   `json:"type"` // "firewall_response"
    ID       string   `json:"id"`   // correlation ID — repris tel quel du message entrant
    Success  bool     `json:"success"`
    Error    string   `json:"error,omitempty"`
    Rules    []FwRule `json:"rules,omitempty"`
    Platform string   `json:"platform,omitempty"`
}
```

Le champ `ID` est simplement recopié depuis `env.ID` reçu — c'est ce qui permet au serveur de retrouver le bon waiter dans `firewallWaiters` à la réception.

### File d'attente `pending_command` pour agents hors ligne

Les commandes pare-feu n'ont **pas** de fallback offline : si l'agent n'est pas connecté, `pushAndWait()` échoue immédiatement (503). En revanche, les commandes simples de type `sendCommand()` / `bulkSendCommand()` (`agent.service.ts`, ex. `uninstall`) utilisent la colonne `pending_command` de `agent_devices` comme file d'attente persistante :

```ts
async sendCommand(id: number, command: string): Promise<boolean> {
  const count = await db('agent_devices')
    .where({ id })
    .update({ pending_command: command, updated_at: new Date() });
  return count > 0;
},
```

Au reconnect, `register()` appelle `_drainPendingCommand(conn)` qui lit et vide la colonne, puis pousse la commande sous forme de frame `{ type: 'config', command: ... }` :

```ts
private async _drainPendingCommand(conn: ObliguardConn): Promise<void> {
  const row = await db('agent_devices')
    .where({ uuid: conn.deviceUuid, tenant_id: conn.tenantId })
    .select('id', 'pending_command')
    .first();
  if (!row?.pending_command) return;
  await db('agent_devices').where({ id: row.id }).update({ pending_command: null });
  if (conn.ws.readyState === 1) {
    conn.ws.send(JSON.stringify({ type: 'config', command: row.pending_command }));
  }
}
```

La commande est également renvoyée en réponse à chaque heartbeat via `agentService.handlePush()` (champ `response.command`, consommé côté agent dans `applyOGConfig()` qui traite `msg.Command` — ex. `uninstall` déclenche `handleUninstallCommand(cfg)`). Cela garantit la livraison même si l'agent s'est reconnecté juste avant que `sendCommand()` ne soit appelé côté serveur (fenêtre de course couverte par le prochain heartbeat, cadencé à 30 s par `cmdWSHeartbeatInterval`).

### Résumé des trois canaux

| Canal | Usage | Timeout / attente | Fallback offline |
|---|---|---|---|
| `push()` | Fire-and-forget | Aucun | Aucun (retourne `false`) |
| `pushAndWait()` | Commandes pare-feu (request-response) | 30 s, ID de corrélation | Aucun — échec immédiat `503` |
| `pending_command` (DB) | Commandes différées (ex. `uninstall`) | Jusqu'au prochain heartbeat/reconnect | Oui — persistée en base |
