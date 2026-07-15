Obliguard peut enrichir son moteur de bannissement local avec des sources externes d'IP malveillantes. Deux mécanismes coexistent : les **listes URL personnalisées** (texte brut, une IP par ligne) et l'intégration **guard.obli.tools**, un flux centralisé bidirectionnel (push des auto-bans locaux + pull d'un delta partagé par les autres instances Obliguard).

Toute la logique vit dans `server/src/services/remoteBlocklist.service.ts`, exposée via `server/src/controllers/remoteBlocklist.controller.ts` et `server/src/routes/remoteBlocklist.routes.ts`, montée sur `/remote-blocklists`. La configuration se fait depuis `SettingsPage.tsx` (section blocklists distantes), avec persistance dans `app_config` via `appConfig.service.ts`.

## Modèle de données

Migration `server/src/db/migrations/020_remote_blocklists.ts` :

- **`remote_blocklists`** — une source configurée : `name`, `source_type` (`'oblitools' | 'url'`), `url`, `api_key` (bearer token, nullable), `enabled`, `sync_interval` (secondes, défaut 600), `last_sync_at`, `last_sync_count`, `tenant_id` (nullable).
- **`remote_blocked_ips`** — les IP importées depuis chaque source : `blocklist_id` (FK CASCADE), `ip` (type `inet`), `reason`, `first_seen`, `last_seen`, `reports`, `sources` (`text[]`), `enabled`. Contrainte unique `(blocklist_id, ip)` avec upsert (`onConflict().merge()`).
- Deux index : un partiel sur `blocklist_id WHERE enabled = true`, un sur `ip`.

Ces IP importées ne sont **pas** automatiquement dans `ip_bans` — c'est une table de tracking/affichage distincte, consultable dans l'onglet "Remote" de la page IP Reputation (`IPReputationPage.tsx`). Seul le flux `oblitools` avec statut `banned` déclenche la création d'un vrai ban global (voir plus bas).

## Listes URL personnalisées (`source_type: 'url'`)

`remoteBlocklistService.syncUrl(list)` :

1. `fetch(list.url)` avec en-tête `Authorization: Bearer <api_key>` si une clé est configurée, timeout 30s (`AbortSignal.timeout`).
2. Parse le corps texte ligne par ligne : ignore les lignes vides et les commentaires (`#` ou `;`).
3. Supporte un format CSV simplifié — ne garde que la première colonne (séparateurs `,`, `;`, tabulation).
4. Valide chaque IP avec une regex IPv4 (`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}` avec suffixe CIDR optionnel `/\d{1,2}`). IPv6 n'est pas supporté par ce parseur.
5. Upsert de chaque IP dans `remote_blocked_ips` avec `reason: 'blocklist'`, `last_seen` rafraîchi à chaque sync (`onConflict(['blocklist_id', 'ip']).merge({ last_seen })`).
6. Met à jour `last_sync_at` et `last_sync_count` sur la ligne `remote_blocklists`.

Ce mode est purement informatif : les IP atterrissent dans `remote_blocked_ips` pour consultation/export, mais ne créent **aucun ban automatique**. C'est à l'opérateur de les promouvoir manuellement (whitelist/ban) depuis l'UI.

## Intégration guard.obli.tools (`source_type: 'oblitools'`)

### Pull — `syncOblitools(list)`

1. Ne s'exécute que si `list.api_key` est renseigné.
2. Construit l'URL de requête à partir de `list.url` (typiquement `https://guard.obli.tools/blocklist/api/blocklist`) :
   - ajoute `?since=<last_sync_at ISO>` pour ne récupérer qu'un **delta** depuis la dernière synchro ;
   - ajoute `?exclude_source=<oblitools_instance_name>` pour éviter de réimporter ses propres IP poussées.
3. `GET` avec `Authorization: Bearer <api_key>`, timeout 30s. Réponse attendue :
   ```json
   { "ips": { "1.2.3.4": { "first_seen": "...", "last_seen": "...", "reports": 12, "sources": ["instanceA"], "reason": "ssh brute-force", "status": "banned" } } }
   ```
4. Pour chaque IP :
   - Upsert dans `remote_blocked_ips` (fusion `COALESCE`/`GREATEST` sur `reason`, `last_seen`, `reports`, `sources`).
   - Si `status === 'banned'` : vérifie qu'aucun ban actif n'existe déjà pour cette IP (`ip_bans WHERE ip = ? AND is_active = true`), sinon crée un ban **global** `ban_type: 'auto'` avec la raison `obli.tools: <reason> (<N> reports)`. L'insertion est protégée par `.catch(() => {})` pour ignorer les doublons.
   - Si `status === 'suspicious'` : n'insère **pas** de ban direct. À la place, injecte jusqu'à 10 événements `auth_failure` synthétiques dans `ip_events` (service `oblitools_shared`, `id` du type `oblitools-<ip>-<timestamp>-<i>`), plafonnés à `Math.min(reports, 10)` pour éviter un ban instantané. Le but est de préchargeur le compteur du moteur de ban (`ban.service.ts`) : chaque signalement externe rapproche l'IP du seuil local sans le déclencher directement. L'IP est aussi initialisée dans `ip_reputation` via `ipReputationService.ensureExists(ip)`.
5. Met à jour `last_sync_at` / `last_sync_count` = `countBanned + countSuspicious`.

### Push — `pushNewBans()`

Déclenché par le cron (voir plus bas) ou via l'appel manuel `POST /remote-blocklists/push-now`.

1. Vérifie `oblitools_push_enabled === 'true'` dans `app_config`, sinon retourne un message d'information (pas d'erreur).
2. Vérifie la présence d'`oblitools_api_key`.
3. Récupère `oblitools_last_push_at` (défaut : epoch) pour ne pousser que les nouveautés.
4. Collecte deux ensembles, en excluant systématiquement les IP privées RFC1918 (`isRfc1918()` — plages `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`) :
   - `ip_bans` actifs, `ban_type = 'auto'`, `banned_at > last_push` → statut `banned`.
   - `ip_reputation` avec `status = 'suspicious'`, `updated_at > last_push`, en excluant les IP déjà dans le lot `banned` → statut `suspicious`.
   - Le suffixe CIDR est retiré des IP avant envoi (`stripCidr`).
5. Si rien à pousser, retourne un message avec la date du dernier push.
6. `POST https://guard.obli.tools/blocklist/api/push`, `Authorization: Bearer <api_key>`, body :
   ```json
   { "instance": "<oblitools_instance_name>", "ips": [{ "ip": "...", "reason": "...", "status": "banned|suspicious" }] }
   ```
7. En cas d'échec HTTP, lève une erreur (loguée + renvoyée à l'appelant — le contrôleur répond alors `502`).
8. En cas de succès, met à jour `oblitools_last_push_at` et retourne un résumé (`Pushed X banned + Y suspicious — accepted: ..., new: ...`) basé sur l'accusé de réception du serveur.

## Moteur de synchronisation automatique

`server/src/index.ts` démarre un timer toutes les **10 minutes** (job n°11 du bootstrap serveur) qui appelle séquentiellement :

```ts
await remoteBlocklistService.syncAll();
await remoteBlocklistService.pushNewBans();
```

`syncAll()` itère toutes les lignes `remote_blocklists` avec `enabled = true` et route vers `syncOblitools()` ou `syncUrl()` selon `source_type`. Chaque échec est isolé par un `try/catch` par liste — un échec de synchro n'interrompt pas les autres. Le timer est nettoyé (`clearInterval`) à l'extinction gracieuse du serveur.

Une synchro immédiate d'une liste unique est possible via `forceSync(id)` (bouton "Sync" dans l'UI → `POST /remote-blocklists/:id/sync`), qui appelle directement `syncOblitools`/`syncUrl` sans passer par le cron.

## Configuration (page Settings)

Section blocklists distantes de `client/src/pages/SettingsPage.tsx` :

- **Liste des sources** (`remoteBlocklistApi.list()`) : nom, type (badge "Obli.tools" ou "URL"), toggle activé/désactivé, bouton sync manuel, suppression (avec confirmation, cascade sur les IP importées).
- **Formulaire d'ajout** : sélecteur de type (`url` / `oblitools`). Pour le type `oblitools`, l'URL est pré-remplie en dur avec `https://guard.obli.tools/blocklist/api/blocklist` et le nom par défaut est "Obli.tools Global" ; le placeholder de la clé API suggère le format `oblg_xxxxxxxxxxxx`. Pour le type `url`, l'utilisateur saisit librement l'URL, un nom, et un jeton Bearer optionnel.
- **Bloc "contribution obli.tools"** (paramètres globaux, distincts d'une ligne `remote_blocklists`) :
  - toggle **push** (`oblitools_push_enabled`) — active/désactive le partage des auto-bans,
  - **nom d'instance** (`oblitools_instance_name`) — identifiant envoyé dans le payload `instance` et utilisé pour le paramètre `exclude_source` au pull,
  - **clé API** (`oblitools_api_key`) — jamais renvoyée en clair par l'API (`appConfigService.getAll()` la masque en `••••••••`, seul un flag `hasApiKey`/valeur masquée est exposé côté client),
  - horodatage du **dernier push** (`oblitools_last_push_at`), affiché en lecture seule.
  - Ces valeurs sont persistées via `PUT /admin/config/:key` (`oblitools_push_enabled`, `oblitools_instance_name`, `oblitools_api_key`), gérées par `appConfig.controller.ts`/`appConfig.service.ts`, indépendamment des lignes `remote_blocklists`.

## API REST

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/remote-blocklists` | Liste des sources configurées |
| `POST` | `/remote-blocklists` | Créer une source (`name`, `sourceType`, `url`, `apiKey?`, `syncInterval?`) |
| `PUT` | `/remote-blocklists/:id` | Mettre à jour (nom, url, clé API, `enabled`, intervalle) |
| `DELETE` | `/remote-blocklists/:id` | Supprimer une source (cascade sur `remote_blocked_ips`) |
| `POST` | `/remote-blocklists/:id/sync` | Forcer une synchro immédiate |
| `GET` | `/remote-blocklists/ips` | Lister les IP importées (filtres `blocklistId`, `search`, `enabled`, pagination) |
| `PUT` | `/remote-blocklists/ips/:id/toggle` | Activer/désactiver une IP importée |
| `GET` | `/remote-blocklists/stats` | Compteurs globaux (total, actives, sources actives, dernière synchro) |
| `POST` | `/remote-blocklists/push-now` | Déclencher un push manuel vers obli.tools |

`listIps()` supporte une recherche texte sur l'IP (`ILIKE` via cast `ri.ip::text`) et joint `remote_blocklists` pour exposer `blocklist_name`/`source_type` sur chaque ligne. `getStats()` agrège le total d'IP, le nombre d'IP actives, le nombre de sources actives, et la date de dernière synchro toutes sources confondues.

## Points d'attention

- Les IP RFC1918 (privées) ne sont jamais poussées vers obli.tools (`isRfc1918()`), évitant de polluer le flux partagé avec des adresses internes.
- Les IP `suspicious` reçues via obli.tools n'entraînent jamais un ban immédiat : elles alimentent uniquement le compteur du moteur de ban local (`ban.service.ts`), qui reste seul décisionnaire du franchissement de seuil — cohérent avec le principe de scoping des bans (global/tenant/groupe/agent) décrit dans l'architecture du moteur de ban.
- Les listes de type `url` ne créent jamais de ban : elles alimentent uniquement `remote_blocked_ips`, à charge de l'opérateur de les exploiter manuellement.
- L'insertion de ban automatique lors du pull obli.tools est protégée par un `.catch(() => {})` pour tolérer les doublons (contrainte d'unicité potentielle sur `ip_bans`), plutôt que de vérifier explicitement une contrainte SQL — la vérification d'existence (`is_active = true`) reste la garde principale.
