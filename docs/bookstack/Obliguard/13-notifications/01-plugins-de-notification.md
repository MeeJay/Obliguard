Obliguard distingue deux circuits de notification bien séparés :

- les **canaux de notification** (plugins externes : Telegram, Discord, Slack, Teams, SMTP, Webhook, Gotify, Ntfy, Pushover, Free Mobile), gérés depuis `NotificationsPage.tsx` et livrés par `server/src/services/notification.service.ts` ;
- les **alertes live** (toasts temps réel dans l'UI, via Socket.io), gérées par `server/src/services/liveAlert.service.ts` et affichées par `client/src/components/layout/LiveAlerts.tsx`.

Les deux sont indépendants : un ban auto peut déclencher un envoi Telegram sans jamais passer par la table `live_alerts`, et inversement.

## Les 10 plugins de notification

Chaque plugin est un objet `NotificationPlugin` (`server/src/notifications/types.ts`) avec `type`, `name`, `description`, `configFields` (formulaire dynamique côté UI) et deux méthodes `send()` / `sendTest()`. Ils sont enregistrés dans `server/src/notifications/registry.ts` :

```ts
[
  webhookPlugin, discordPlugin, telegramPlugin, slackPlugin, teamsPlugin,
  gotifyPlugin, ntfyPlugin, pushoverPlugin, smtpPlugin, freemobilePlugin,
].forEach((plugin) => plugins.set(plugin.type, plugin));
```

`getPluginMetas()` expose au client la liste des types disponibles avec leurs champs de config (`configFields`), ce qui permet à `NotificationsPage.tsx` de générer le formulaire de création de canal sans hardcoder les champs par type.

Détail des plugins (`server/src/notifications/plugins/`) :

| Type | Fichier | Champs de config | Mécanisme |
|---|---|---|---|
| `telegram` | `telegram.ts` | `botToken`, `chatId` | POST `https://api.telegram.org/bot{token}/sendMessage`, HTML parse mode |
| `discord` | `discord.ts` | `webhookUrl`, `username` (optionnel) | POST webhook Discord, embed coloré via `STATUS_COLORS_HEX` |
| `slack` | `slack.ts` | webhook Slack | POST vers l'Incoming Webhook Slack |
| `teams` | `teams.ts` | webhook Teams | POST vers le connecteur Microsoft Teams |
| `smtp` | `smtp.ts` | `smtpServerId`, `fromOverride`, `to` | Utilise `nodemailer`, résolu via `smtpServerService` (serveur SMTP global partagé) |
| `webhook` | `webhook.ts` | `url`, `secret` (optionnel) | POST JSON brut du `NotificationPayload`, header `Authorization` si secret défini |
| `gotify` | `gotify.ts` | URL + token Gotify | POST vers une instance Gotify auto-hébergée |
| `ntfy` | `ntfy.ts` | topic/URL ntfy | POST vers ntfy.sh ou instance self-hosted |
| `pushover` | `pushover.ts` | `userKey`, `appToken`, `priority` | POST `https://api.pushover.net/1/messages.json` |
| `freemobile` | `freemobile.ts` | `userId`, `apiKey` | GET `https://smsapi.free-mobile.fr/sendmsg` (SMS France) |

Tous les appels HTTP sortants utilisent `AbortSignal.timeout(10000)` (10s) et lèvent une erreur si `res.ok` est faux — l'erreur est capturée par `notification.service.ts` et journalisée dans `notification_log` sans interrompre l'envoi aux autres canaux.

Le cas SMTP est particulier : `channel.config` ne contient que `smtpServerId` (référence à un serveur SMTP global défini dans Admin), et `resolveChannelConfig()` (dans `notification.service.ts`) résout à l'envoi les credentials réels via `smtpServerService.getTransportConfig()` — le mot de passe SMTP n'est donc jamais dupliqué dans chaque canal.

## Canaux, bindings et héritage hiérarchique

Un **canal** (`notification_channels`) est une configuration réutilisable (ex: "Telegram — Admins"). Un **binding** (`notification_bindings`) relie un canal à une portée (`scope` : `global` / `group` / `agent` / `monitor`) avec un `overrideMode` :

- `merge` — ajoute le canal à l'ensemble hérité du niveau parent
- `replace` — vide l'ensemble hérité à ce niveau puis repart de zéro
- `exclude` — retire un canal spécifique de l'ensemble hérité

La résolution se fait dans `notification.service.ts` via `_applyBindings()`, appliquée en chaîne **Global → ancêtres de groupe (racine→feuille) → agent/monitor**, en s'appuyant sur la closure table `group_closure` :

- `resolveChannelsForAgent(deviceId)` — chaîne complète pour un agent
- `resolveChannelsForGroup(groupId)` — pas de niveau agent/monitor
- `resolveChannelsForMonitor(monitorId, groupId)` — hérité d'Obliview pour les moniteurs uptime
- `resolveBindingsWithSourcesForAgent(deviceId)` / `resolveBindingsWithSources(scope, scopeId, groupId)` — même résolution mais enrichie avec la source (`global`/`group`/`agent`) et `isDirect`/`isExcluded`, utilisée par `NotificationsPage.tsx` pour afficher visuellement d'où vient chaque canal actif.

Un canal peut aussi être **partagé entre tenants** via la table `notification_channel_tenants` (`getChannelTenants` / `setChannelTenants`) : un canal créé sur un tenant peut être rendu visible et utilisable sur d'autres tenants, géré par le composant `TenantSharingPanel` dans `NotificationsPage.tsx`.

## Types de notification par agent

En plus des bindings de canal, chaque agent a des **types de notification** activables indépendamment : `global` (interrupteur maître), `down`, `up`, `threat`, `attack`. La résolution suit la même logique de chaîne (device → groupe ancêtre → config globale `app_config.agent_global_config` → défauts codés `DEFAULT_NOTIFICATION_TYPES`), via `resolveNotificationTypesForDevice(deviceId)`.

`sendForAgent()` vérifie ces flags avant tout envoi :

```ts
if (!types.global) return; // notifications désactivées globalement pour ce device
if (effectiveType === 'attack' && !types.attack) return;
```

## Déclenchement lors d'un ban automatique / d'une attaque

Le déclenchement se fait dans `server/src/services/ban.service.ts`, dans la méthode qui crée un ban global auto (`ip_bans`, `ban_type: 'auto'`). Séquence :

1. Vérification qu'aucun ban actif n'existe déjà et que l'IP n'est pas en liste blanche (`ip_whitelist`).
2. Insertion du ban dans `ip_bans` (`scope: 'global'`, `reason: "Auto-ban: N <service> auth failures"`).
3. `_io?.emit('ban:auto', { ip, service, failureCount, originTenantId })` — événement Socket.io consommé par la NetMap pour l'animation en temps réel (indépendant du système de plugins).
4. Push fire-and-forget du ban vers les devices MikroTik (`mikrotikBanSync.pushBanToAll`).
5. Recherche des `agent_devices` ayant reçu des `auth_failure` de cette IP dans les 10 dernières minutes (`ip_events`), mise à jour de `last_attack_at`.
6. Pour chaque agent affecté, appel de `notificationService.sendForAgent(devId, label, 'attack', 'ok', [message], 'attack')` — en fire-and-forget (`.catch()` loggé, ne bloque jamais le ban).

```ts
notificationService.sendForAgent(devId, label, 'attack', 'ok',
  [`${ip} banned (${failureCount} ${service} failures)`], 'attack')
  .catch((err) => logger.warn({ err, devId, ip }, 'Failed to send attack notification'));
```

`sendForAgent()` construit un `NotificationPayload` (`monitorName`, `oldStatus`, `newStatus`, `message`, `timestamp`, `appName`), résout les canaux applicables via `resolveChannelsForAgent()`, ne garde que les canaux `is_enabled = true`, puis boucle sur chacun : résolution config → `plugin.send()` → log dans `notification_log` (succès ou échec avec message d'erreur). Un échec sur un canal n'empêche pas l'essai des suivants.

## Alertes live (toasts Socket.io)

Indépendamment des plugins, `server/src/services/liveAlert.service.ts` gère une table `live_alerts` (persistée, 200 entrées max par tenant, purge automatique après 30 jours via `cleanup()`) :

- `liveAlertService.add(tenantId, { severity, title, message, navigateTo?, stableKey? })` insère une alerte et émet `SOCKET_EVENTS.NOTIFICATION_NEW` sur la room `tenant:{tenantId}:notifications`.
- La déduplication via `stableKey` évite les doublons : si une alerte non lue avec la même clé existe déjà pour le tenant, l'insertion est court-circuitée (`null` retourné).
- Sévérités : `down` / `up` / `warning` / `info`.

Côté client, `client/src/hooks/useSocket.ts` écoute `NOTIFICATION_NEW` et pousse l'alerte dans `useLiveAlertsStore` (`client/src/store/liveAlertsStore.ts`), un store Zustand persistant (préférences uniquement — la liste d'alertes est toujours rechargée depuis le serveur via `GET /api/live-alerts/all`). Le composant `client/src/components/layout/LiveAlerts.tsx` affiche les toasts, avec :

- position configurable (`top-center` / `bottom-right`)
- activation séparée pour les alertes du tenant courant (`localEnabled`) et celles des autres tenants accessibles (`multiTenantEnabled`)
- dismiss du toast sans marquer l'alerte comme lue (`dismissToast`) vs. marquage lu réel (`markAlertRead`, `PATCH /api/live-alerts/:id/read`)

L'app tray desktop (Go, `desktop-app/`) reçoit également ces événements via `window.dispatchEvent(new CustomEvent('obliview:notify', ...))` (`useSocket.ts`, fonction `notifyNative`) pour jouer un son natif sur les transitions `down`/`up`/`alert`/`fixed`.

## Journalisation

Chaque tentative d'envoi (réussie ou non) est tracée dans `notification_log` via `notificationService.logNotification(channelId, monitorId, eventType, success, error?)`, avec `eventType` parmi `status_change`, `agent_status_change`, `group_status_change`. Cela permet de diagnostiquer un canal qui échoue silencieusement (ex: token Telegram expiré) sans dépendre uniquement des logs serveur.

## Test d'un canal

`notificationService.testChannel(id)` (exposé par `NotificationsPage.tsx` via le bouton "Tester") résout la config effective puis appelle `plugin.sendTest(config)`. Chaque plugin implémente `sendTest()` en rejouant `send()` avec un payload factice (`monitorName: 'Test Monitor'`, transition `up → down`), ce qui permet de valider la configuration sans attendre un vrai événement de ban.
