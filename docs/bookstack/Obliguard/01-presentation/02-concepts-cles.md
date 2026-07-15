Cette page définit le vocabulaire utilisé dans le reste de la documentation Obliguard. Chaque terme renvoie, quand c'est pertinent, au fichier du code source qui l'implémente.

## Agent

Binaire Go déployé sur chaque serveur à protéger (`agent/`, point d'entrée `agent/main.go`). Il :

- détecte automatiquement les services en écoute par scan de ports (`agent/services.go`) ;
- suit (tail) les journaux de ces services et en extrait les tentatives d'authentification via des regex (`agent/logwatcher.go`) ;
- applique localement les bans reçus du serveur au niveau du pare-feu — nftables > firewalld > ufw > iptables sous Linux, `netsh` sous Windows, `pf` sous macOS/FreeBSD (`agent/firewall.go`) ;
- maintient une session WebSocket persistante avec le serveur (`agent/cmd_ws.go`), avec heartbeat toutes les 30 s (`cmdWSHeartbeatInterval`) et flush des événements par lot toutes les 500 ms.

Côté serveur, chaque agent connecté est géré par `server/src/services/obliguardHub.service.ts` (hub WebSocket) et représenté par un enregistrement `agent_devices` en base.

## Ban Engine

Moteur d'auto-ban implémenté dans `server/src/services/ban.service.ts`. Il tourne en cycle périodique (cron 30 s) et :

1. compte les événements `auth_failure` par IP sur la fenêtre temporelle configurée par le service template concerné ;
2. si le seuil (`threshold`) est dépassé dans la fenêtre (`window_seconds`), crée un ban global automatique (`ban_type: 'auto'`) ;
3. vérifie d'abord la whitelist et l'absence de ban déjà actif (409 sinon) ;
4. déclenche les notifications d'attaque vers les agents concernés ;
5. respecte le mode « evaluate-only » (dry-run, voir plus bas) — un groupe ou un agent en `evaluate_only=true` continue de faire remonter des événements mais ne génère jamais d'auto-ban et ne reçoit aucune règle de blocage (migration `023_evaluate_only.ts`).

## Service Template

Modèle de détection pour un type de service (SSH, RDP, Nginx, Apache, IIS, FTP, Mail, MySQL, MikroTik), géré par `server/src/services/serviceTemplate.service.ts`. Un template définit :

- une regex avec groupes nommés (`?P<ip>`, `?P<username>`) pour parser les lignes de log ;
- un `threshold` (nombre d'échecs) et un `window_seconds` (fenêtre glissante), par défaut 5 échecs / 300 s ;
- un `mode` : `ban` (crée un auto-ban dès dépassement du seuil) ou `track` (journalise seulement, sans bannir).

Les templates globaux (`owner_scope IS NULL`) sont inclus par défaut pour tout tenant (modèle opt-out). Une assignation agent ou groupe peut surcharger `threshold_override`, `window_seconds_override`, le chemin de log ou l'état actif/inactif — la résolution suit la hiérarchie **agent > groupe > valeur par défaut du template** (`serviceTemplate.service.ts`, résolution des overrides autour de la ligne 419).

## Ban auto vs ban manuel

Table `ip_bans`, colonne `ban_type` :

- **`auto`** — créé par le Ban Engine quand un seuil de service template est dépassé (`ban.service.ts`, autour de la ligne 424, événement Socket.io `ban:auto`).
- **`manual`** — créé explicitement par un administrateur depuis l'UI ou l'API (`ban.service.ts`, méthode de création manuelle vers la ligne 104/134).

Les deux types partagent le même cycle de vie (levée, promotion en ban global, TTL optionnel avec auto-désactivation).

## Scoping (portée) des bans, whitelist, et assignations

Un même mécanisme de portée hiérarchique s'applique aux bans, à la whitelist et aux assignations de templates, via les colonnes `scope` / `scope_id` :

| Scope | Effet |
|---|---|
| `global` | S'applique à tous les tenants et tous les agents de l'instance. Réservé aux administrateurs plateforme (`ban.service.ts` : « Only platform admins can create non-tenant-scoped bans »). |
| `tenant` | S'applique à tous les agents d'un tenant donné. C'est le scope par défaut pour un utilisateur non-admin. |
| `group` | S'applique à un groupe et à ses descendants (résolu via `group_closure`, table de fermeture transitive gérée par `server/src/services/group.service.ts`). |
| `agent` | S'applique à un seul agent (`scope_id` = id de l'agent). |

Les bans globaux peuvent être exclus pour un tenant précis via la table `ip_ban_exclusions` (exemption per-tenant sur un ban global), gérée par `ban.service.ts` (« Only global bans can be excluded per-tenant »).

## Whitelist

Liste d'IP/CIDR jamais bannies, gérée par `server/src/services/whitelist.service.ts`. Supporte la notation CIDR et la même hiérarchie de scoping que les bans (global / tenant / group / agent). Le Ban Engine vérifie systématiquement la whitelist avant de créer un auto-ban ; les vérifications globales sont prioritaires, avec surcharge possible par tenant au moment du push de configuration à l'agent.

## IP Reputation

Agrégat d'intelligence par IP, calculé par `server/src/services/ipReputation.service.ts` (table `ip_reputation`) : compteurs d'échecs/succès, agents affectés, services ciblés, noms d'utilisateur tentés, GeoIP (pays, ville, ASN). Chaque IP a un statut :

- **`clean`** — aucune activité suspecte notable ;
- **`suspicious`** — total d'échecs supérieur à un seuil de référence (`baseline_failures`), calculé côté tenant sauf pour les administrateurs plateforme ;
- **`banned`** — IP actuellement sous un ban actif (dans ce cas la requête pilote depuis `ip_bans` plutôt que `ip_reputation`, pour que les IP bannies sans historique d'événements apparaissent quand même).

Le passage « suspicious → clean » se fait par soft-delete via la table `ip_reputation_clears`, avec visibilité par tenant (`ipReputation.service.ts`, méthode autour de la ligne 487-504).

## Remote Blocklist

Liste de blocage externe (URL texte brut, une IP par ligne) ou flux `guard.obli.tools`, gérée par `server/src/services/remoteBlocklist.service.ts`. Deux mécanismes :

- **synchronisation entrante** : parsing d'URL personnalisées, ou pull en delta depuis obli.tools — importe des IP en `banned` ou `suspicious` avec la raison `obli.tools: <reason> (<reports> reports)` ;
- **contribution sortante** : moteur de push (« Push engine (obli.tools contribution) ») qui envoie les auto-bans de l'instance vers `https://guard.obli.tools/blocklist/api/push`, activable/configurable (clé API, nom d'instance) depuis la page Settings.

## NetMap

Visualisation temps réel de la topologie (agents, IP attaquantes, liens pairs), en deux modes :

- **2D** (`client/src/netmap/`) — Canvas 2D avec simulation de forces pour le placement des agents (`physics.ts`, `ForceSimulation`), système orbital pour les IP (espacement en angle d'or, vitesse képlérienne), anneaux d'orbite, minimap, recherche, filtre « menaces uniquement ».
- **3D** (`client/src/netmap3d/`) — Three.js avec post-traitement bloom (les objets émissifs créent le glow, pas de mesh de bulle additive), `InstancedMesh` pour les points IP, `CSS2DRenderer` pour les labels, `OrbitControls`.

Les deux modes lisent les mêmes refs de données (`agentsRef`, `ipsRef`, `agentLinksRef`) ; le tick physique (simulation de forces, mouvement orbital, arrivée/expiration des IP) tourne dans la boucle d'animation quel que soit le mode actif — seul le rendu Canvas 2D est court-circuité en mode 3D. Les types de base sont définis dans `client/src/netmap/types.ts` : `AgentNode`, `IpNode`, `AgentPeerLink` (liens entre agents détectés via les IP LAN remontées par chaque agent).

## Tenant

Unité d'isolation multi-locataire. Chaque tenant a ses propres agents, bans (scope `tenant`), utilisateurs et paramètres, mais peut être affecté par des objets de scope `global` (bans globaux, templates globaux). Le tenant « master » (`isMasterTenant`) a des privilèges élargis, notamment pour créer/lever des bans globaux.

## Groupe hiérarchique

Structure d'organisation des agents en arborescence de profondeur illimitée, gérée par `server/src/services/group.service.ts` via une **table de fermeture transitive** (`group_closure`) qui matérialise toutes les relations ancêtre/descendant. Cette structure sert à :

- la résolution des paramètres par héritage (global → groupe → agent), y compris les seuils de service templates et le mode `evaluate_only` (« un device est evaluate-only si son propre flag est true OU si le flag de n'importe quel groupe ancêtre est true ») ;
- le scoping `group` des bans et de la whitelist, qui s'applique au groupe **et à tous ses descendants** (`ban.service.ts` : `scope_id` filtré via `whereIn('scope_id', groupIds)`, `groupIds` étant résolu depuis la fermeture transitive).
