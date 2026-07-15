## TTL et désactivation automatique

Un ban (`ip_bans`) peut porter une date d'expiration optionnelle, stockée dans la colonne `expires_at` (timestamp nullable, migration `server/src/db/migrations/001_obliguard_schema.ts`, ligne 630). Un index partiel accélère les recherches de bans expirés encore actifs :

```sql
CREATE INDEX idx_ip_bans_expires ON ip_bans(expires_at)
  WHERE is_active = true AND expires_at IS NOT NULL;
```

- **Bans manuels** : le TTL est fourni par l'admin via `CreateBanRequest.expiresAt` et transmis tel quel à l'insertion dans `BanService.create()` (`server/src/services/ban.service.ts`, ligne 140). Un ban sans `expiresAt` reste actif indéfiniment (`expires_at = null`).
- **Bans automatiques** (`ban_type = 'auto'`, créés par `BanEngine.createAutoBan()`) n'ont actuellement pas de TTL — ils restent actifs jusqu'à levée manuelle (`lift()`) ou wipe.
- La vérification d'unicité au moment de la création (`BanService.create()`, lignes 119-127) tient compte du TTL : une IP est considérée "déjà bannie" seulement si un ban actif existe *et* que `expires_at` est `null` ou dans le futur — un ban expiré n'empêche donc pas un nouveau ban d'être recréé.

La désactivation effective des bans expirés n'est pas gérée par le moteur de bans (`ban.service.ts`) mais par un job séparé démarré dans `server/src/index.ts` (section "10. ip_bans expiry job"), un `setInterval` toutes les **5 minutes** :

```ts
const expired = await db('ip_bans')
  .where('is_active', true)
  .whereNotNull('expires_at')
  .where('expires_at', '<', new Date())
  .update({ is_active: false });
```

Ce job tourne indépendamment du `BanEngine` (cycle 30 s décrit dans la page précédente) : le TTL n'est donc pas garanti à la seconde près, mais avec une granularité de 5 minutes maximum. Une fois `is_active = false`, le ban sort du calcul de delta (`computeBanDelta()`) au prochain heartbeat de chaque agent, qui reçoit alors l'IP dans la liste `remove[]` et lève le blocage au niveau du pare-feu local.

## Exemptions par tenant (`ip_ban_exclusions`)

Obliguard est multi-tenant : un ban `scope = 'global'` s'applique par défaut à tous les tenants. La table `ip_ban_exclusions` (migration `006_ban_exclusions.ts`) permet à un tenant de désactiver localement l'application d'un ban global sans le lever pour les autres tenants ni révoquer la protection globale :

```ts
t.integer('ban_id').references('id').inTable('ip_bans').onDelete('CASCADE');
t.integer('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
t.integer('created_by').references('id').inTable('users').onDelete('SET NULL');
t.unique(['ban_id', 'tenant_id']);
```

Un index `idx_ip_ban_exclusions_tenant(tenant_id, ban_id)` accélère la lecture lors du calcul de delta par agent.

### Règles métier (`BanService`)

- **`excludeForTenant(banId, tenantId, userId)`** (ligne 198) : n'autorise l'exclusion que sur un ban `scope = 'global'` encore actif. L'insertion utilise `onConflict(['ban_id', 'tenant_id']).ignore()` pour être idempotente. Émet l'événement Socket.io `ban:excluded`.
- **`removeExclusion(banId, tenantId)`** (ligne 216) : supprime l'exemption, réactive l'application du ban pour ce tenant. Émet `ban:exclusionRemoved`.
- **`lift(banId, tenantId, isAdmin)`** (ligne 168) : un ban `global` ne peut être **levé** (supprimé pour tout le monde) que depuis le tenant maître (`isMasterTenant`). Un tenant non-maître qui veut échapper à un ban global doit passer par `excludeForTenant()` plutôt que par `lift()` — c'est le garde-fou explicite documenté dans le commentaire du code : *"Any other tenant must use excludeForTenant() to opt out locally without affecting the tenant that created the ban."*

### Application dans le calcul de delta

`computeBanDelta(deviceId, groupIds, tenantId, agentCurrentBans, resolvedWhitelist)` (ligne 229) est appelé à chaque cycle de résolution de configuration agent. Il :

1. Récupère tous les bans actifs visibles pour l'agent (global, ou son tenant, ou son groupe, ou lui-même en scope `agent`).
2. Récupère l'ensemble des `ban_id` exclus pour le `tenantId` courant via `ip_ban_exclusions`.
3. Filtre : `if (excludedBanIds.has(ban.id)) continue;` — un ban global exclu par le tenant n'entre jamais dans `shouldBeBanned`.
4. Filtre ensuite les IP whitelistées, puis calcule `add`/`remove` par différence avec `agentCurrentBans` (état actuel remonté par l'agent).

Le champ `isExcludedByTenant` est aussi exposé côté API dans `BanService.list()` (jointure `LEFT JOIN ip_ban_exclusions ... AND ex.tenant_id = tenantId`) pour que le frontend (`BansPage.tsx`) affiche visuellement les bans globaux exclus pour le tenant courant.

## Déclenchement des notifications d'attaque

Lorsque `BanEngine.createAutoBan()` (`ban.service.ts`, ligne 398) crée un ban `auto`, il déclenche en cascade une notification "attaque" vers les agents concernés :

1. **Identification des agents affectés** — recherche des `device_id` distincts ayant généré un événement `auth_failure` pour cette IP dans les 10 dernières minutes (`ip_events`, fenêtre glissante codée en dur : `Date.now() - 10 * 60 * 1000`).
2. **Marquage "sous attaque"** — mise à jour de `agent_devices.last_attack_at = new Date()` pour tous les devices affectés (colonne ajoutée par la migration `004_agent_threat_timestamps.ts`).
3. **Notification par agent** — pour chaque device affecté, appel de `notificationService.sendForAgent(devId, label, 'attack', 'ok', [message], 'attack')`, en fire-and-forget (erreurs journalisées via `logger.warn` sans bloquer la boucle).

### Résolution des canaux et filtrage par type

`sendForAgent()` (`server/src/services/notification.service.ts`, ligne 717) :

- Ignore l'envoi si `newStatus === previousStatus` (ici toujours différent : `'attack'` vs `'ok'`).
- Résout les préférences de type de notification via `resolveNotificationTypesForDevice(deviceId)`, qui suit la chaîne **global → agent**, avec repli sur les défauts globaux (`appConfigService.getResolvedAgentNotificationTypes()`) puis sur `DEFAULT_NOTIFICATION_TYPES`. Si `types.global === false` ou `types.attack === false`, la notification est silencieusement abandonnée (`logger.info` explicatif).
- Résout la liste des canaux via `resolveChannelsForAgent(deviceId)` (ligne 492), qui empile les bindings dans l'ordre **global → groupes ancêtres (racine → feuille) → agent**, chaque niveau pouvant ajouter ou retirer des canaux (`_applyBindings`).
- Construit un `NotificationPayload` (`monitorName`, `oldStatus`, `newStatus`, `message` = liste des violations jointes par `; `, `timestamp`, `appName`) puis itère sur les canaux actifs (`is_enabled = true`).

### Dispatch vers les plugins

Pour chaque canal, `getPlugin(channel.type)` (`server/src/notifications/registry.ts`) résout l'implémentation parmi les 10 plugins enregistrés dans `server/src/notifications/plugins/` :

| Fichier | Canal |
|---|---|
| `telegram.ts` | Telegram |
| `discord.ts` | Discord |
| `slack.ts` | Slack |
| `teams.ts` | Microsoft Teams |
| `smtp.ts` | E-mail (SMTP) |
| `webhook.ts` | Webhook générique |
| `gotify.ts` | Gotify |
| `ntfy.ts` | Ntfy |
| `pushover.ts` | Pushover |
| `freemobile.ts` | Free Mobile (SMS) |

Chaque plugin implémente `send(resolvedConfig, payload)`. L'appel est encapsulé dans un `try/catch` par canal : succès ou échec sont journalisés individuellement via `logNotification(channel.id, null, 'agent_status_change', success, errMsg)`, ce qui garantit qu'une erreur sur un canal (ex. webhook injoignable) n'empêche pas l'envoi sur les autres canaux résolus pour l'agent.

### Lien avec le NetMap et le dashboard

Indépendamment de la notification externe, l'événement `ban:auto` est émis en Socket.io dès la création du ban (`_io?.emit('ban:auto', { ip, service, failureCount, originTenantId })`), consommé côté client pour les toasts d'alertes en direct. La mise à jour de `last_attack_at` alimente par ailleurs l'état "under attack" affiché sur la NetMap (2D et 3D) et sur `AgentDetailPage.tsx`.
