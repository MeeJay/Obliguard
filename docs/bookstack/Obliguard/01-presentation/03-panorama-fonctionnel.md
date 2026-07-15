Cette page recense tous les modules fonctionnels d'Obliguard, avec leurs fichiers d'implémentation principaux côté serveur (`server/src/services/`), agent (`agent/`) et client (`client/src/`).

## Moteur de bannissement (Ban Engine)

`server/src/services/ban.service.ts` — cœur de l'IPS.

- Cycle d'évaluation cron toutes les 30 secondes (`BAN_ENGINE_INTERVAL_MS = 30_000`) : compte les événements `auth_failure` par IP sur la fenêtre temporelle configurée par service.
- Création automatique de bans globaux quand le seuil du template de service est dépassé.
- Vérifie la whitelist avant tout ban, et détecte les doublons (retour HTTP 409 si l'IP est déjà bannie).
- Déclenche les notifications d'attaque vers les agents concernés.
- Portée du ban (`BanScope`) : `global` / `tenant` / `group` / `agent`.
- Type de ban : `auto` (créé par le moteur) vs `manual` (action admin).
- TTL optionnel avec désactivation automatique, exemptions par tenant via la table `ip_ban_exclusions` (migration `006_ban_exclusions.ts`).
- Expose la liste (`list()`), la promotion en ban global, la levée de ban, le ban en masse.
- Table exposée côté API : `bans.routes.ts` / `bans.controller.ts`.

## Hub WebSocket agents (Obliguard Hub)

`server/src/services/obliguardHub.service.ts` (`ObliguardHubService`) — canal de commande persistant par agent, remplace l'ancien mécanisme de push HTTP en boucle.

- Heartbeat agent toutes les 30 s (`cmdWSHeartbeatInterval`, codé en dur côté Go dans `agent/cmd_ws.go`).
- Flush des événements quasi temps réel (debounce 500 ms) via des frames `events` séparées des heartbeats.
- `isConnected(deviceUuid)` : détection de mise en ligne/hors ligne avec période de grâce = `checkIntervalSeconds × maxMissedPushes`, pour éviter le flicker d'état dans l'UI.
- `pushAndWait(deviceUuid, cmd, timeoutMs = 30000)` : envoi de commande avec corrélation par ID et timeout, utilisé pour les patterns requête/réponse (commandes pare-feu).
- Livraison de commandes instantanée via WS, ou mise en file dans la colonne DB `pending_command` si l'agent est hors ligne.
- Événement Socket.io `AGENT_STATUS_CHANGED` émis côté client pour mise à jour temps réel de l'UI (`wsConnected: true/false`).

## Templates de service (Service Templates)

`server/src/services/serviceTemplate.service.ts` (`ServiceTemplateService`), routes `serviceTemplates.routes.ts`.

- Parsers intégrés pour 8 services : SSH, RDP, Nginx, Apache, IIS, FTP, Mail, MySQL.
- Regex personnalisées avec groupes nommés (`?P<ip>`, `?P<username>`).
- Seuil + fenêtre temporelle par template (ex. 5 échecs en 300 s).
- Mode `ban` (création automatique de ban) ou `track` (journalisation seule).
- Assignation hiérarchique : override au niveau agent > groupe > défaut du template (migration `003_local_templates.ts` pour les overrides locaux agent/groupe).
- `007_template_inactive_default.ts` : gestion du statut inactif par défaut d'un template.

## Listes de blocage distantes (Remote Blocklists)

`server/src/services/remoteBlocklist.service.ts`, routes `remoteBlocklist.routes.ts`, migration `020_remote_blocklists.ts`.

- Listes IP personnalisées par URL (texte brut, une IP par ligne).
- Intégration guard.obli.tools : push des auto-bans, pull en delta du blocklist partagé.
- Configuration via la page Settings : clé API, nom d'instance, activation du push.
- Moteur de synchronisation avec parseur d'URL et pull delta obli.tools.

## Réputation IP (IP Reputation)

`server/src/services/ipReputation.service.ts` (`IpReputationService`), routes `ipReputation.routes.ts`.

- Agrégats par IP : compteurs d'échecs/succès, agents affectés, services ciblés, noms d'utilisateur tentés.
- Enrichissement GeoIP : pays, ville, ASN.
- Statuts : `clean` → `suspicious` → `banned`.
- Suppression douce (soft-delete) par tenant via la table `ip_reputation_clears` (migration `008_ip_reputation_clears.ts`), pour masquer une IP sans affecter la vue des autres tenants.
- Optimisations de performance dédiées (migration `024_ip_reputation_perf.ts`).
- UI : `client/src/pages/IPReputationPage.tsx`, onglets Local/Remote, sélection en masse, ban/whitelist en masse.

## Whitelist

`server/src/services/whitelist.service.ts` (`WhitelistService`), routes `whitelist.routes.ts`.

- Support de la notation CIDR.
- Même portée hiérarchique que les bans (global / tenant / groupe / agent).
- Vérification systématique avant tout ban automatique : une IP whitelistée n'est jamais bannie par le moteur.
- UI : `client/src/pages/WhitelistPage.tsx`.

## Noms d'affichage IP (IP Display Names)

`server/src/services/ipDisplayNames.service.ts`, routes `ipDisplayNames.routes.ts`, migration `012_ip_display_names.ts`.

- Étiquettes personnalisées pour les IP, portée globale ou tenant.
- Affichées sur la NetMap, `BansPage.tsx` et `IPReputationPage.tsx`.

## NetMap 2D / 3D

Visualisation temps réel de la topologie agents/IP.

**Mode 2D** — `client/src/netmap/` :
- `types.ts` (AgentNode, IpNode, AgentPeerLink), `constants.ts` (couleurs, tailles, TTL), `helpers.ts` (points de spawn, mapping couleurs), `layout.ts` (positionnement initial des agents), `physics.ts` (classe `ForceSimulation`), `tabStore.ts` (store Zustand pour l'état onglet/vue).
- Rendu Canvas 2D, système orbital des IP (espacement en angle d'or, vitesse de Kepler), anneaux d'orbite, liens pairs, minimap, recherche, filtre "menaces uniquement".

**Mode 3D** — `client/src/netmap3d/` (Three.js, chargé en lazy-loading dans un chunk séparé) :
- `NetMap3D.tsx` : cycle de vie React/Three.js, synchronisation agents/IP/liens pairs.
- `scene.ts` : renderer WebGL, post-traitement bloom, `OrbitControls`, éclairage.
- `skybox.ts` : champ d'étoiles (15 000) avec shader GLSL de scintillement.
- `agentMesh.ts` : sphères émissives (le bloom crée le halo, pas de mesh de bulle additive).
- `ipMesh.ts` : pool `InstancedMesh` pour les points IP.
- `orbitRing.ts` : ellipses d'orbite inclinées en 3D, `getOrbitPosition3D()`.
- `interactions.ts` : raycaster au clic (agents via `traverse`, IP via `instanceId`), `flyTo`.
- `constants3d.ts` : échelle, rayons, paramètres de bloom et caméra.
- Point critique : le tick physique (simulation de forces, mouvement orbital, arrivée/expiration des IP) tourne dans la boucle d'animation quel que soit `viewMode` — le null-check du canvas ne garde que le rendu 2D, pas la simulation elle-même. Les deux modes lisent les mêmes refs (`agentsRef`, `ipsRef`, `agentLinksRef`), le composant 3D convertissant les coordonnées pixel 2D en 3D via un facteur `SCALE` de 0.35.
- UI : `client/src/pages/NetMapPage.tsx` (bascule 2D/3D).

## Notifications (10 plugins)

`server/src/services/notification.service.ts` + registre `server/src/notifications/registry.ts` (fonction `getPlugin(type)`).

Plugins présents dans `server/src/notifications/plugins/` :

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

- Chaque canal (`NotificationChannel`) a un binding (`NotificationBinding`) par portée avec `overrideMode`.
- `plugin.send()` / `plugin.sendTest()` pour l'envoi réel et le test depuis l'UI.
- Alertes live via Socket.io (toasts) en plus des canaux externes : `server/src/services/liveAlert.service.ts`, `client/src/pages/LiveEventsPage.tsx`.
- UI : `client/src/pages/NotificationsPage.tsx`.

## Multi-tenant et groupes

- `server/src/services/tenant.service.ts` : espaces de travail isolés, contrôle admin plateforme via `isMasterTenant`.
- `server/src/services/group.service.ts` : hiérarchie de groupes en table de fermeture (closure table), profondeur illimitée.
- Héritage des paramètres global → groupe → agent (templates, seuils, config d'affichage).
- RBAC : `permission.service.ts` / `permissionSet.service.ts`, droits lecture seule / lecture-écriture par groupe (migration `015_permission_sets.ts`).
- Équipes : `team.service.ts` (capacités par équipe, migration `014_team_capabilities.ts`).
- UI : `AdminTenantsPage.tsx`, `GroupManagePage.tsx`, `GroupDetailPage.tsx`, `GroupEditPage.tsx`.

## Intégration MikroTik

`server/src/services/mikrotik/` :

- `mikrotikDevice.service.ts` : gestion des équipements MikroTik (CRUD, credentials — migrations `013-015`).
- `routerosClient.ts` : client API RouterOS.
- `syslogParser.ts` : ingestion syslog pour extraction des échecs d'authentification.
- `mikrotikLogPoller.service.ts` : sondage des logs.
- `mikrotikBanSync.service.ts` : synchronisation des bans vers les address-lists RouterOS.
- `mikrotikImport.service.ts` : import de listes (migration `018_mikrotik_import_lists.ts`), token d'ingestion dédié (migration `019_mikrotik_ingest_token.ts`), device (migration `017_mikrotik_devices.ts`).
- Contrôleur/routes : `mikrotik.controller.ts` / `mikrotik.routes.ts`.

## Import/Export

`server/src/controllers/importExport.controller.ts`, routes `importExport.routes.ts`.

- Export/import au format JSON avec résolution de conflits.
- UI : `client/src/pages/ImportExportPage.tsx`.

## Application bureau (tray app)

- Application Go avec icône de zone de notification (tray), pour Windows et macOS, avec mise à jour automatique (référencée dans `CLAUDE.md`, dépôt/dossier `desktop-app/` séparé du monorepo principal analysé ici).
- Vient compléter l'agent en fournissant un point d'accès rapide côté poste utilisateur/administrateur.

## Agent Go — enforcement pare-feu et détection

`agent/` (binaire multiplateforme) :

- `services.go` : auto-détection des services écoutants par scan de ports.
- `logwatcher.go` : suivi des logs de service, extraction d'événements par regex.
- `firewall.go` : enforcement multiplateforme — nftables > firewalld > ufw > iptables (Linux), `netsh` (Windows), `pf` (macOS/FreeBSD).
- Windows : règles `netsh` groupées (`Obliguard-Block-N`, 500 IP max par règle), fichier `obliguard-banlist.txt` comme source de vérité.
- `firewall_rules.go` + `firewall_rules_windows.go` / `firewall_rules_linux.go` (4 backends : nft, firewalld, ufw, iptables) : gestion des règles pare-feu (liste/ajout/suppression/toggle) pilotée par commandes WebSocket.
- `eventlog_windows.go` : sondage de l'Event Log Windows pour RDP/échecs d'authentification (EventID 4625/4624).
- `uninstall.go` : nettoyage spécifique par plateforme.
- `cmd_ws.go` : boucle de session WS, flush heartbeat/événements, dispatch des frames serveur (y compris commandes pare-feu).
- Mise à jour automatique : téléchargement du nouveau MSI/binaire via `/api/agent/download/`, réinstallation silencieuse.

## Internationalisation

- 18 langues (`en, fr, de, es, pt, it, nl, pl, cs, ro, ru, uk, zh, ja, ko, ar, tr, he`) via i18next, fichiers `client/src/i18n/locales/*.json` (874 clés chacun).
