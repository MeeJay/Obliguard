## Qu'est-ce qu'Obliguard

Obliguard est un IPS (Intrusion Prevention System) réseau auto-hébergé, à architecture agent/serveur. Il détecte les attaques par force brute sur les services exposés d'une infrastructure — SSH, RDP, Nginx, Apache, IIS, FTP, Mail, MySQL, ainsi que les équipements MikroTik — et bannit automatiquement les IP attaquantes au niveau du pare-feu, sur **tous les agents simultanément**, pas seulement sur la machine qui a détecté l'attaque.

Le projet est un monorepo npm workspaces (`shared/`, `server/`, `client/`, `agent/`), dérivé techniquement d'un projet antérieur nommé **Obliview** (`package.json` racine porte encore `"name": "obliview"`) dont Obliguard hérite toute l'infrastructure applicative : authentification, multi-tenant, groupes hiérarchiques, RBAC, notifications, import/export, i18n. Le cœur métier IPS (moteur de bans, agents, service templates, réputation IP, NetMap) a été construit par-dessus cette base.

## Le problème résolu

Sur une infrastructure multi-serveurs classique, chaque machine surveille (ou pas) ses propres logs d'authentification indépendamment :

- Un admin doit consulter `/var/log/auth.log` ou l'Event Log Windows serveur par serveur pour repérer une attaque en cours.
- Les règles de blocage (iptables, netsh, fail2ban...) sont configurées et maintenues machine par machine, sans coordination.
- Une IP qui attaque le serveur A et bannie localement peut continuer d'attaquer le serveur B sans qu'aucune information ne soit partagée entre les deux.
- Il n'existe pas de vue d'ensemble en temps réel de qui attaque quoi, ni d'historique centralisé des tentatives.

Obliguard centralise la détection (événements remontés par les agents au serveur) et la décision (moteur de bans), puis **redistribue** la décision à l'ensemble des agents concernés pour qu'ils appliquent le blocage localement à leur pare-feu — qu'ils aient ou non été la cible directe de l'attaque. Un ban « global » créé suite à une attaque sur un agent SSH à Paris peut ainsi protéger immédiatement un serveur RDP à Amsterdam.

## Principe de fonctionnement : agent + serveur central + enforcement synchronisé

Le flux, décrit dans `README.md` (section « How It Works ») et implémenté par `server/src/services/ban.service.ts` :

1. **Les agents** (binaire Go, `agent/`) tournent sur les machines à surveiller. Ils détectent automatiquement les services en écoute par scan de ports (`agent/services.go`), puis suivent (`tail`) les fichiers de logs correspondants et en extraient les tentatives d'authentification par regex nommées (`agent/logwatcher.go`).
2. Les événements (`auth_failure` / `auth_success`) sont poussés au serveur en quasi temps réel via le canal WebSocket persistant (`server/src/services/obliguardHub.service.ts`), avec un debounce de 500 ms sur le flush.
3. Le **moteur de bans** (`BanService`, `server/src/services/ban.service.ts`) tourne selon un cycle d'évaluation de 30 secondes : il compte les `auth_failure` par IP sur la fenêtre temporelle configurée dans le service template concerné, vérifie la whitelist, puis crée un ban IP global si le seuil est dépassé.
4. Le ban est **distribué à tous les agents concernés** via commande WebSocket (livraison instantanée si l'agent est connecté, sinon mise en file dans la colonne `pending_command` pour livraison au prochain contact).
5. Chaque agent applique le blocage **localement**, au niveau de son propre pare-feu — nftables, firewalld, ufw ou iptables selon la disponibilité sur Linux (ordre de priorité défini dans `agent/firewall.go`), `netsh` (règles groupées `Obliguard-Block-N`, jusqu'à 500 IP par règle) sous Windows, `pf` sous macOS/FreeBSD.
6. La **NetMap** (`client/src/pages/NetMapPage.tsx`, rendu 2D canvas ou 3D Three.js) visualise en temps réel l'ensemble du parc : agents, IP en cours d'attaque, liens entre pairs, étincelles d'événements.

Cette boucle fait d'Obliguard un système de prévention **coordonné** plutôt qu'une collection d'installations fail2ban isolées : une seule détection déclenche une protection réseau entière.

## Services surveillés

| Service | Détection | Chemins de logs par défaut |
|---|---|---|
| SSH | Regex sur logs | `/var/log/auth.log`, `/var/log/secure`, `journald:sshd.service` |
| RDP | Event Log Windows | EventID 4625 (échec) / 4624 (succès) |
| Nginx | Regex sur logs | `/var/log/nginx/error.log` |
| Apache | Regex sur logs | `/var/log/apache2/error.log`, `/var/log/httpd/error_log` |
| IIS | Regex sur logs | `C:\inetpub\logs\LogFiles\` |
| FTP | Regex sur logs | `/var/log/vsftpd.log`, `/var/log/proftpd/proftpd.log` |
| Mail | Regex sur logs | `/var/log/mail.log`, `/var/log/maillog` |
| MySQL | Regex sur logs | `/var/log/mysql/error.log` |
| MikroTik | Ingestion syslog | Adresse list sync via `server/src/services/mikrotik/` |

Chaque service dispose d'un parseur intégré défini dans `server/src/services/serviceTemplate.service.ts`, avec possibilité de surcharger la regex par une expression personnalisée à groupes nommés (`?P<ip>`, `?P<username>`). Le seuil (nombre d'échecs), la fenêtre temporelle et le mode (`ban` = ban automatique, `track` = journalisation seule) sont configurables par service template, avec une résolution hiérarchique agent > groupe > défaut du template.

## Positionnement dans la suite obli.tools

Obliguard fait partie de l'écosystème **obli.tools** (voir `server/src/routes/oblitools.routes.ts`, dossier `obli.tools/`), un ensemble d'outils auto-hébergés partageant une base d'infrastructure commune :

- **Obligate** est le fournisseur d'identité SSO de la suite. Obliguard s'y connecte via `server/src/services/obligate.service.ts` : échange de code d'autorisation OAuth (`exchangeCode`), vérification de la joignabilité (`getSsoConfig` interroge `/health` avec un timeout de 2 s), et récupération d'une assertion utilisateur (`ObligateUserAssertion`) contenant rôle, tenants, équipes, capacités et préférences. Les migrations 009-011 (`server/src/db/migrations/`) portent l'intégration SSO externe (« Foreign SSO »).
- **guard.obli.tools** est le service de partage de blocklists distantes : Obliguard peut y pousser ses bans automatiques et en tirer une blocklist delta, via `server/src/services/remoteBlocklist.service.ts`.
- **Obliview** est le socle technique hérité : système d'authentification (login, 2FA TOTP + Email OTP, sessions), utilisateurs/équipes/RBAC, workspaces multi-tenant, groupes hiérarchiques (closure table), héritage de paramètres, 10 plugins de notification, import/export JSON, alertes temps réel Socket.io, application tray desktop (Go, Windows/macOS), assistant d'enrôlement. Obliguard n'a pas réécrit cette couche : il l'utilise et bâtit par-dessus la logique IPS (moteur de bans, agents, templates de service, réputation IP, NetMap).

En résumé, Obliguard est la déclinaison « sécurité réseau / IPS » de la plateforme obli.tools, s'appuyant sur Obligate pour l'identité et sur l'infrastructure Obliview pour tout ce qui est gestion multi-tenant, permissions et notifications.
