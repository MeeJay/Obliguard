Le hub WebSocket (`server/src/services/obliguardHub.service.ts`) maintient une connexion persistante par agent (`byDevice: Map<deviceUuid, ObliguardConn>`). Une coupure de connexion (câble réseau, redémarrage de l'agent, coupure réseau intermittente) ne doit pas immédiatement afficher l'agent comme hors ligne dans l'UI — c'est le rôle du **grace timer**.

### Déclenchement du grace timer

Quand le WebSocket d'un agent se ferme (`ws.on('close')` ou `ws.on('error')`), `_unregister()` retire la connexion de `byDevice` et démarre un timer différé via `_startOfflineTimer(deviceUuid, deviceId)` :

```ts
private _unregister(deviceUuid: string, ws: WebSocket): void {
  const existing = this.byDevice.get(deviceUuid);
  if (existing?.ws === ws) {
    const deviceId = existing.deviceId;
    this.byDevice.delete(deviceUuid);
    if (deviceId) {
      this._startOfflineTimer(deviceUuid, deviceId);
    }
  }
}
```

### Calcul du délai : `checkIntervalSeconds × maxMissedPushes`

`_startOfflineTimer` résout les settings effectifs de l'agent (agent → groupe → global, via `agentService.getDeviceById`) et calcule le délai de grâce :

```ts
let delaySec = 60 * 2; // fallback: 2 minutes
const device = await agentService.getDeviceById(deviceId);
if (device) {
  const cis = device.resolvedSettings?.checkIntervalSeconds ?? 60;
  const mmp = device.resolvedSettings?.maxMissedPushes ?? 2;
  delaySec = cis * mmp;
}
```

Concrètement : si `checkIntervalSeconds = 30` (fréquence de push/heartbeat attendue) et `maxMissedPushes = 2`, l'agent dispose de 60 secondes sans connexion avant d'être déclaré hors ligne. Ce calcul absorbe les micro-coupures WS (reconnexions TCP, redémarrage réseau bref, latence de proxy inverse) sans faire clignoter l'UI.

Le timer est stocké dans `offlineTimers: Map<deviceUuid, Timeout>`, distinct de `byDevice`, ce qui permet de distinguer trois états :

| État | `byDevice.has(uuid)` | `offlineTimers.has(uuid)` |
|---|---|---|
| Connecté | oui | non |
| Déconnecté, en grâce | non | oui |
| Réellement hors ligne | non | non |

### Annulation du timer à la reconnexion

Si l'agent se reconnecte avant l'expiration du délai, `register()` annule le timer en tout premier :

```ts
async register(deviceUuid, tenantId, apiKeyId, clientIp, ws) {
  const pendingTimer = this.offlineTimers.get(deviceUuid);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    this.offlineTimers.delete(deviceUuid);
    logger.info({ deviceUuid }, 'Obliguard agent reconnected — offline timer cancelled');
  }
  ...
}
```

Aucun événement `AGENT_STATUS_CHANGED: down` n'est jamais émis dans ce cas — la coupure est totalement invisible côté UI.

### Expiration du timer → émission `down`

Si le timer arrive à échéance sans reconnexion, il vérifie une dernière fois `isConnected()` (garde contre une race condition où l'agent se serait reconnecte entre-temps) puis émet l'événement Socket.io :

```ts
const timer = setTimeout(() => {
  this.offlineTimers.delete(deviceUuid);
  if (!this.isConnected(deviceUuid)) {
    const io = getAgentServiceIO();
    io?.to('role:admin').emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, {
      deviceId,
      status: 'down',
      wsConnected: false,
    });
  }
}, delaySec * 1000);
```

### `isConnected()` : rester `true` pendant la grâce

`isConnected(deviceUuid)` est la méthode utilisée partout ailleurs dans le code (API REST, résolution du champ `wsConnected` sur `AgentDevice`) pour déterminer l'état affiché d'un agent. Elle traite explicitement la période de grâce comme "connecté" :

```ts
isConnected(deviceUuid: string): boolean {
  const conn = this.byDevice.get(deviceUuid);
  if (conn && conn.ws.readyState === 1) return true;
  // During grace period, report as still connected to avoid UI flicker
  return this.offlineTimers.has(deviceUuid);
}
```

C'est ce qui garantit qu'un rechargement de page, un GET sur `/agent/devices`, ou tout calcul de `wsConnected` pendant la fenêtre `checkIntervalSeconds × maxMissedPushes` continue de renvoyer `true`, même si la socket physique est fermée. `wsConnected` est calculé côté serveur dans `agent.service.ts` :

```ts
wsConnected: row.device_type === 'mikrotik'
  ? isMikrotikOnline(row.id)
  : obliguardHub.isConnected(row.uuid),
```

### Émission `up` à la reconnexion effective

À l'inverse, quand un agent effectue un push réussi (heartbeat traité par `agentService.handlePush`), le serveur émet immédiatement `AGENT_STATUS_CHANGED` avec `status: 'up'` et `wsConnected: true`, en plus de l'événement léger `agent:pushHeartbeat` (`server/src/services/agent.service.ts`, ~ligne 1050) :

```ts
_io.emit('agent:pushHeartbeat', { deviceId, updatedAt: pushTime.toISOString(), agentVersion });
_io.emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, {
  deviceId, status: 'up', wsConnected: true, violations: [], violationKeys: [],
});
```

Un état intermédiaire `status: 'updating'` existe également (`setDeviceUpdating`, ~ligne 1281) : il est émis pendant un auto-update d'agent pour afficher un badge "UPDATING" dans le sidebar au lieu de "down", évitant une fausse alerte pendant le redémarrage du binaire.

### Consommation côté client

L'événement Socket.io `AGENT_STATUS_CHANGED` est écouté à plusieurs endroits du client, chacun mettant à jour son propre état local :

- **`client/src/hooks/useSocket.ts`** — hook global : déclenche les notifications natives de l'app desktop (`agent_alert` / `agent_fixed`) sur transition `alert`, et propage `status: 'updating'` vers le monitor lié dans `useMonitorStore`.
- **`client/src/components/layout/Sidebar.tsx`** — met à jour `deviceStatuses` (Map `deviceId → status`) pour le point de statut coloré dans la barre latérale. Le commentaire du fichier précise que l'état initial est déjà seedé depuis le `wsConnected` renvoyé par l'API au premier chargement (donc correct dès le premier rendu, sans attendre un événement socket), le polling 30 s resynchronisant ensuite depuis cette même source de vérité côté serveur.
- **`client/src/pages/DashboardPage.tsx`** — met à jour `wsConnected` dans la liste `agentDevices` affichée sur le tableau de bord.
- **`client/src/pages/AgentDetailPage.tsx`** — met à jour `device.wsConnected` sur la fiche détail d'un agent (filtré par `deviceId` correspondant à la page affichée).
- **`client/src/pages/AdminAgentPage.tsx`** — met à jour la liste des agents dans la vue d'administration.

Tous ces listeners filtrent sur `data.deviceId` et ignorent silencieusement les événements pour d'autres agents ou dépourvus de `wsConnected`.

### Points clés

- Le délai de grâce est **par agent**, dérivé de ses `resolvedSettings` (hiérarchie agent → groupe → global) — un agent avec un `checkIntervalSeconds` court aura un délai de détection hors-ligne plus court.
- Fallback à 2 minutes (`60 * 2`) si la résolution des settings échoue ou si `deviceId` n'est pas encore connu.
- Le ping keep-alive du hub (`setInterval` toutes les 15 s dans le constructeur de `ObliguardHubService`) sert à maintenir la connexion à travers les proxys inverses, mais n'a pas de rôle dans la détection offline — c'est bien la fermeture du WS (`close`/`error`) qui déclenche `_unregister()`.
- Les agents MikroTik (device_type `mikrotik`) n'utilisent pas ce mécanisme WS : leur état online est déterminé par `isMikrotikOnline()`, basé sur la fraîcheur des ingestions syslog.
