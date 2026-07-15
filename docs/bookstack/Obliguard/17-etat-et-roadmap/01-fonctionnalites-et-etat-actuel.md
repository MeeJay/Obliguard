Cette page fait le point sur ce qui est réellement en place dans le dépôt `D:\Obliguard` à la date du 4 juillet 2026, en se basant sur le code source, les migrations (`server/src/db/migrations/`) et l'historique Git (branche `dev`, 407 commits, dernier commit `145ca53`). Le dépôt est un monorepo npm workspaces (`shared/`, `server/`, `client/`) plus deux binaires Go (`agent/`, `desktop-app/`).

## Moteur IPS (ban engine)

Le cœur du produit est `server/src/services/ban.service.ts`, qui exporte deux objets :

- `banService` : logique métier (création/levée de bans, vérification whitelist, contrôle de doublon 409, calcul du delta `add[]/remove[]` à pousser à un agent).
- `BanEngine` (instance singleton `banService` associée à un timer) : boucle `setInterval` toutes les 30 secondes (`BAN_ENGINE_INTERVAL_MS = 30_000`) qui évalue les `ip_events` par rapport aux seuils des templates de service et crée automatiquement des bans globaux quand un seuil est dépassé.

Caractéristiques observées dans le code :

- Portée de ban (`scope`) : global / tenant / group / agent, avec type `auto` (créé par le moteur) vs `manual` (action admin).
- Exemptions par tenant via la table `ip_ban_exclusions` (migration 006).
- Mode **evaluate-only** (migration `023_evaluate_only.ts`) : un groupe ou un agent peut être basculé en dry-run — les événements continuent d'être ingérés et affichés (utile pour évaluer les règles de whitelist), mais le `BanEngine` ne crée aucun ban automatique et le serveur envoie une liste de bans vide à l'agent (impact réseau nul). L'héritage suit le même modèle que le reste de la pile (groupe → sous-groupes → agents via `group_closure`).
- Politique « opt-in stricte » réaffirmée par la migration `022_disable_leaked_builtins.ts` : les templates intégrés ajoutés après la migration 007 (OPNsense, MikroTik SSH/Winbox/Web) avaient été semés `enabled=true` par erreur — ils sont désormais désactivés au niveau global par défaut, cohérent avec le principe « aucun template activé ⇒ aucune application de ban ».

## Limitation de débit par IP (rate limiting)

Fonctionnalité plus récente (migration `021_rate_limit_policies.ts`, page client `RateLimitPage.tsx`), distincte du ban engine :

- Table `rate_limit_policies`, avec le même modèle d'héritage global → tenant → group → agent que la whitelist.
- Deux types de politique indépendants, appliqués côté agent au niveau pare-feu : `connection` (nombre max de connexions concurrentes par IP source — `connlimit` / `pf max-src-conn`) et `rate` (nouvelles connexions par seconde — `hashlimit` / `pf max-src-conn-rate`).
- Action à deux paliers : au-delà de `max_value` → `drop` ou `reject` ; au-delà de `max_value * ban_multiplier` → escalade vers un ban automatique en réutilisant le pipeline de ban existant, avec TTL optionnel (`ban_ttl_seconds`).

## Hub WebSocket agents

`server/src/services/obliguardHub.service.ts` gère un canal de commande WS persistant par agent (remplace l'ancien mécanisme de push HTTP en boucle) :

- Heartbeat toutes les 30 s côté agent (`cmdWSHeartbeatInterval` codé en dur dans `agent/cmd_ws.go`).
- Flush des événements en quasi temps réel via des frames `events` séparées (debounce 500 ms).
- Détection de déconnexion avec période de grâce = `checkIntervalSeconds × maxMissedPushes` avant de signaler l'agent hors ligne ; `isConnected()` renvoie `true` pendant cette période pour éviter le clignotement de l'UI.
- `wsConnected` (champ calculé sur `AgentDevice`) et événement Socket.io `AGENT_STATUS_CHANGED` pour la mise à jour temps réel côté client.
- Commandes livrées instantanément par WS, ou mises en file dans la colonne DB `pending_command` pour les agents hors ligne.
- `pushAndWait()` avec suivi par identifiant de corrélation et timeout de 30 s pour les échanges requête/réponse (notamment les commandes pare-feu : `firewall_list`, `firewall_add`, `firewall_delete`, `firewall_toggle`, gérées côté serveur par `server/src/controllers/firewall.controller.ts`).

## Agent Go (`agent/`)

- Détection automatique des services écoutants par scan de ports (`services.go`), suivi de logs et extraction d'événements par regex nommées (`logwatcher.go`).
- Application locale des bans avec sélection de backend pare-feu par priorité : nftables > firewalld > ufw > iptables (Linux), `netsh` (Windows), `pf` (macOS/FreeBSD) — `firewall.go`.
- Sous Windows : règles `netsh` groupées (`Obliguard-Block-N`, 500 IP max par règle), fichier `obliguard-banlist.txt` comme source de vérité, poller de l'Event Log Windows pour les échecs RDP/auth (EventID 4625/4624).
- Sous Linux : sets nftables / opérations batch ipset pour iptables.
- Gestion des règles pare-feu pilotable à distance (`firewall_rules.go` + fichiers spécifiques par plateforme `firewall_rules_windows.go`, `firewall_rules_linux.go` avec 4 backends nft/firewalld/ufw/iptables) ; le parseur Windows gère la locale française (`Actif/Sortie/Autoriser/Bloquer`).
- Auto-update (téléchargement MSI/binaire depuis `/api/agent/download/`, réinstallation silencieuse) et commande de désinstallation propre par plateforme (`uninstall.go`).
- Remontée des IP LAN pour la détection de liens pairs sur la NetMap, remontée de l'état pare-feu courant pour synchronisation delta.

## NetMap 2D / 3D

- **2D** (`client/src/netmap/`) : Canvas 2D avec simulation de forces (`physics.ts` — classe `ForceSimulation`) pour le placement des agents, système orbital des IP (espacement en angle d'or, vitesse képlérienne), anneaux d'orbite, liens pairs, mini-carte, recherche, filtre « menaces uniquement ». État de vue géré par un store Zustand (`tabStore.ts`).
- **3D** (`client/src/netmap3d/`) : Three.js avec post-traitement bloom (les objets émissifs produisent l'effet de lueur nativement, sans maillage de bulle en blend additif — `agentMesh.ts`), `InstancedMesh` pour le pool d'IP (`ipMesh.ts`), `CSS2DRenderer` pour les étiquettes, `OrbitControls`, skybox de 15 000 étoiles avec shader GLSL de scintillement (`skybox.ts`), raycasting pour les clics (agents via `traverse`, IP via `instanceId` — `interactions.ts`).
- Les deux modes lisent les mêmes refs (`agentsRef`, `ipsRef`, `agentLinksRef`) ; la boucle d'animation fait tourner la physique (simulation de forces, mouvement orbital, arrivée/expiration des IP) indépendamment du `viewMode` — seul le rendu Canvas 2D est gardé par un test de nullité.

## Multi-tenant, groupes, permissions

- Tenants isolés (`server/src/services/tenant.service.ts`), groupes hiérarchiques par table de fermeture (`group_closure`, profondeur illimitée), héritage des réglages global → groupe → agent.
- RBAC via `team.service.ts` / `permission.service.ts` ; migrations `014_team_capabilities.ts` et `015_permission_sets.ts` ajoutent des capacités d'équipe granulaires et des jeux de permissions nommés (page client `PermissionSets`), en plus du modèle lecture seule / lecture-écriture par groupe déjà présent.
- SSO Obligate (`obligate.service.ts`, migrations `009_foreign_sso.ts`, `010_sso_link_tokens.ts`, `011_sso_foreign_users.ts`, page `SsoEnrollPage.tsx`).

## Notifications

`server/src/services/notification.service.ts` gère l'envoi vers les canaux configurés, avec un cas spécial pour le SMTP (résolution du serveur SMTP par `channel.config.smtpServerId` — table `smtp_servers`, `smtpServer.service.ts`). Dix plugins de notification annoncés dans le contexte projet (Telegram, Discord, Slack, Teams, SMTP, Webhook, Gotify, Ntfy, Pushover, Free Mobile), avec agrégation par groupe via `groupNotification.service.ts`.

## Intégration MikroTik

Sous-module dédié `server/src/services/mikrotik/` :

- `routerosClient.ts` — client API RouterOS.
- `mikrotikDevice.service.ts` — CRUD des appareils MikroTik (migration `017_mikrotik_devices.ts`).
- `mikrotikImport.service.ts` — import de listes (migration `018_mikrotik_import_lists.ts`).
- `mikrotikLogPoller.service.ts` / `syslogParser.ts` — ingestion syslog, avec jeton d'ingestion dédié (migration `019_mikrotik_ingest_token.ts`).
- `mikrotikBanSync.service.ts` — synchronisation des address-lists MikroTik avec le moteur de ban.
- Templates MikroTik intégrés (`mikrotik_ssh`, `mikrotik_winbox`, `mikrotik_web`) ajoutés en migration 017, désactivés globalement par défaut depuis la migration 022 (opt-in).
- Support OPNsense apparenté (migration `016_opnsense_templates.ts`, templates `opnsense` et `opnsense_filter`).

## Réputation IP, whitelist, blocklists distantes

- `ipReputation.service.ts` : agrégats par IP (échecs/succès, agents affectés, services ciblés, identifiants tentés), GeoIP (pays, ville, ASN), statut `clean → suspicious → banned`, suppression douce par tenant via `ip_reputation_clears` (migration 008). Migration `024_ip_reputation_perf.ts` indique un travail récent de performance sur cette table (probablement index).
- `whitelist.service.ts` : notation CIDR, même modèle de portée hiérarchique que les bans.
- `remoteBlocklist.service.ts` : listes distinctes personnalisées (URL en texte brut) + intégration guard.obli.tools (push des bans automatiques, pull d'un blocklist delta), configurable depuis `SettingsPage.tsx`.

## Autres briques opérationnelles en place

- Authentification : login, 2FA TOTP + OTP par e-mail, sessions, SSO Obligate.
- Import/Export JSON avec résolution de conflit (`ImportExportPage.tsx`).
- Alertes live via Socket.io (toasts).
- Application de tray desktop en Go (`desktop-app/`), Windows + macOS, auto-update.
- Assistant d'enrôlement (langue, profil, alertes, apparence, mot de passe, 2FA).
- i18n : 18 langues (`client/src/i18n/locales/*.json`, ~874 clés chacune).
- 24 migrations au total dans `server/src/db/migrations/` (001 à 024) — la dernière en date (024) porte sur la performance de la réputation IP, ce qui suggère un passage récent en montée en charge sur de plus gros volumes d'événements.

## Pistes d'évolution possibles

Ces pistes sont déduites de l'état du code (fonctionnalités jeunes, commentaires de migration explicites, absence de finition visible) plutôt que d'un roadmap déclaré — aucun `TODO`/`FIXME` significatif n'a été trouvé côté serveur ; un seul existe côté agent (`agent/machine_uuid_windows.go`), sans portée fonctionnelle notable.

- **Rate limiting encore jeune** : `rate_limit_policies` (migration 021) et `RateLimitPage.tsx` sont la fonctionnalité la plus récente du lot ; à vérifier si l'application côté agent (`connlimit`/`hashlimit` Linux, `pf max-src-conn(-rate)` BSD/macOS, équivalent Windows) est déjà complète sur toutes les plateformes ou seulement sur un sous-ensemble.
- **Mode evaluate-only** (migration 023) est très récent — vérifier la couverture UI (indicateurs visuels clairs sur NetMap/Dashboard quand un agent ou groupe est en dry-run) et la documentation utilisateur associée.
- **Nettoyage des templates « leaked »** (migration 022) montre qu'un bug de seed (templates OPNsense/MikroTik activés par défaut) a dû être corrigé après coup — signe qu'un processus de revue des migrations de seed pourrait être renforcé pour éviter une récidive sur de futurs templates intégrés.
- **Performance de la réputation IP** (migration 024, sans détail dans le CLAUDE.md) suggère des soucis de montée en charge sur `ip_reputation` en production — à surveiller si le volume d'IP suivies continue de croître (index, agrégation périodique, purge).
- **Permission sets** (migration 015) et **team capabilities** (migration 014) enrichissent le RBAC au-delà du modèle lecture seule/lecture-écriture d'origine ; la cohérence entre l'ancien modèle par groupe et le nouveau système de permission sets mériterait un audit pour éviter des chevauchements de règles.
- **Intégration OPNsense** : les migrations et templates existent (016) mais aucun service dédié équivalent à `server/src/services/mikrotik/` n'apparaît dans `server/src/services/` — l'intégration semble limitée au parsing de logs/template plutôt qu'à une gestion active de l'appareil (pas de client API OPNsense visible), contrairement à MikroTik qui a un sous-module complet.
- **Cadence de release** : le rythme des commits (« Regular update » très fréquents, alternant avec des commits « Bump + Windows/Linux/FreeBSD builds ») indique un projet en développement continu actif plutôt que figé ; les messages de commit génériques ne permettent pas de tracer un changelog fonctionnel précis depuis Git seul — un CHANGELOG structuré faciliterait le suivi de version pour les utilisateurs auto-hébergés.
