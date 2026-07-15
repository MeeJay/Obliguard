L'agent Obliguard (`agent/`) est un binaire Go unique, compilé pour Windows/Linux/macOS/FreeBSD, qui tourne sur chaque machine surveillée. Il détecte les services exposés, parse leurs logs pour repérer les échecs d'authentification, remonte les événements au serveur via un canal WebSocket persistant, et applique localement les bans décidés par le moteur serveur (`server/src/services/ban.service.ts`) au niveau du pare-feu natif de l'OS. Le code est organisé en un seul `package main`, avec des fichiers `_windows.go` / `_linux.go` / `_darwin.go` / `_freebsd.go` / `_stub.go` sélectionnés par build tags Go (`//go:build windows`, etc.) pour isoler tout ce qui dépend de l'OS.

## main.go — configuration, cycle de vie, auto-update

`main.go` gère :

- **La configuration** (`Config` struct) : `serverUrl`, `apiKey`, `deviceUuid`, `checkIntervalSeconds`, `agentVersion`, `serviceConfigs` (cache des configs de service reçues du serveur). Persistée en JSON dans `config.json`, sous `%PROGRAMDATA%\ObliguardAgent\` sur Windows ou `/etc/obliguard-agent/` ailleurs.
- **`setupConfig()`** : au premier lancement, exige `--url` et `--key` en CLI ; sinon recharge `config.json`, ou en dernier recours la clé de registre Windows (`loadConfigFromRegistry()`, voir `registry_windows.go`). Résout ensuite l'UUID de la machine via `resolveDeviceUUID()` (cascade SMBIOS → disque → UUID stocké → aléatoire, voir `machine_uuid.go`).
- **`mainLoop()`** : détecte le pare-feu local (`DetectFirewall()`), instancie le `LogWatcher` avec les configs de service mises en cache, démarre le poller Windows Event Log (`startPlatformEventLogWatcher`, no-op ailleurs) et le moniteur de connexions TCP (`startNetConnMonitor`), puis lance `runCmdWS()` — la boucle WebSocket qui remplace l'ancien mécanisme de push HTTP périodique.
- **Auto-update** : `checkForUpdate()` interroge `GET /api/agent/version` au démarrage ; `applyUpdateIfNewer()` compare les versions via `parseSemver`/`isStrictlyNewer` et déclenche le téléchargement si une version plus récente existe (le check est aussi piggy-backé sur chaque réponse `config` du serveur). Sur Windows, l'agent télécharge le MSI complet (`obliguard-agent.msi`) et lance un script batch détaché qui appelle `msiexec /i ... /quiet /norestart` — le script doit survivre à l'arrêt du service, donc l'agent appelle `restartWithNewBinary("")` puis `os.Exit(0)` juste après avoir lancé le script (`applyWindowsMSIUpdate`). Sur les autres OS, le nouveau binaire est écrit à côté de l'exécutable courant (`exePath + ".new"`) puis renommé de façon atomique par-dessus, et l'agent se remplace en place via `syscall.Exec` (`restart_unix.go`) — important sur les systèmes sans superviseur de service (Unraid, `rc.local`).
- **Backoff** : `applyBackoff()` (dans `push.go`) implémente un backoff exponentiel non-persisté (`backoffSteps = [5m, 10m, 30m, 60m]`) en cas d'échec d'authentification HTTP — volontairement gardé en mémoire uniquement pour éviter qu'un agent reste bloqué après un redémarrage serveur.

## cmd_ws.go — canal de commande WebSocket persistant

C'est le cœur du protocole agent ↔ serveur actuel (remplace `push.go`, conservé pour l'enregistrement initial legacy). `runCmdWS()` boucle indéfiniment sur `cmdWSSession()`, avec reconnexion à backoff exponentiel (`cmdWSReconnectBase = 2s`, `cmdWSReconnectMax = 60s`, facteur ×1.5).

Une session (`cmdWSSession`) :

1. Se connecte à `wss://<server>/api/agent/ws?uuid=<deviceUuid>` (en-tête `X-API-Key`) via le client WebSocket maison de `websocket.go`.
2. Envoie immédiatement un premier **heartbeat** (`sendOGHeartbeat`) — enregistre/actualise l'appareil côté serveur et reçoit la config courante.
3. Démarre un ticker de heartbeat à `cmdWSHeartbeatInterval = 30s` (constante en dur, doit rester synchronisée avec la logique de grace period du hub serveur, `server/src/services/obliguardHub.service.ts`).
4. Écoute en parallèle (goroutine) les frames entrantes du serveur via un `frameCh`, et le canal `lw.FlushCh()` du `LogWatcher` pour déclencher un flush d'événements **débouncé à 500 ms** (`cmdWSEventDebounce`) — les événements d'auth remontent donc quasiment en temps réel, indépendamment du heartbeat.

Messages envoyés par l'agent :
- `cmdHeartbeatMsg` (`type: "heartbeat"`) : hostname, version, `OSInfo`, services détectés, IPs actuellement bannies localement, nom du backend firewall, IPs LAN (pour les liens pairs sur la NetMap).
- `cmdEventsMsg` (`type: "events"`) : liste d'`AgentIpEvent` accumulés par le `LogWatcher`.

Messages reçus, dispatchés par `handleOGServerFrame()` :
- `type: "config"` (`cmdConfigMsg`) → `applyOGConfig()` : applique le delta de bans (`BanList.Add`/`Remove`) en arrière-plan (goroutine, car `Flush()` peut être lent sous Windows avec beaucoup de règles), les règles de rate-limiting (`ApplyRateLimits`), met à jour les configs de service du `LogWatcher`, déclenche l'auto-update si `LatestVersion` est fourni, et traite les commandes one-shot (`Command: "uninstall"`).
- `firewall_list` / `firewall_add` / `firewall_delete` / `firewall_toggle` → délégués à `handleFirewallCommand()` (`firewall_rules.go`) via `DetectFirewallRuleManager()`, exécutés dans une goroutine, réponse renvoyée via `ws.SendText()` avec le même ID de corrélation (pattern request-response utilisé par `pushAndWait()` côté serveur).

Le protocole WS bas niveau (frames, masking, handshake HTTP Upgrade) est implémenté **à la main** dans `websocket.go` (pas de dépendance externe) : `wsConnect()` fait le handshake RFC 6455, `ReadFrame`/`WriteFrame` gèrent l'encodage/décodage des frames binaires avec masking XOR côté client, `SendPong` répond aux pings serveur (le serveur ping toutes les 15s ; 4 pings manqués = timeout de lecture à `cmdWSReadTimeout = 60s`).

## push.go — canal HTTP legacy

`push()` reste utilisé pour l'enregistrement HTTP initial et sert de filet de secours. Il POST un `pushBody` complet (hostname, OS, services, événements drainés, IPs bannies, échantillons de logs, IPs LAN) vers `/api/agent/push` avec les en-têtes `X-API-Key` et `X-Device-UUID`, et traite la `pushResponse` (delta de bans, whitelist, configs de service, rate limits, commande one-shot, version la plus récente) de façon quasi identique à `applyOGConfig`. Les codes de retour gérés : `200` (OK), `202` (device en attente d'approbation), `401` (échec d'auth → backoff).

## services.go — détection automatique des services

`detectServices()` scanne les ports en écoute (`getListeningPorts()`, implémentation par OS : `ss -tlnp`/`netstat -tlnp` sur Linux, `netstat -anp TCP` sur Windows, `netstat -anp tcp` sur macOS, `sockstat -4l -P tcp` sur FreeBSD) puis résout chaque port vers un type de service connu via la table `knownServices` :

| Service | Ports |
|---|---|
| ssh | 22 |
| rdp | 3389 |
| ftp | 21 |
| mail | 25, 587, 465, 143, 993, 110, 995 |
| mysql | 3306 |
| nginx / apache / iis | 80, 443, 8080, 8443 (dédupliqués) |
| opnsense | 443, 4443, 8443 (FreeBSD uniquement, si `isOPNsenseAgent()`) |

Sur FreeBSD, si `/usr/local/opnsense/version/core` existe, les ports 443/4443/8443 détectés comme nginx/apache sont reclassés `opnsense`, et un service virtuel `opnsense_filter` (sans port, surveille le log pf) est toujours ajouté. `getHostname()` utilise `os.Hostname()` directement plutôt qu'une résolution DNS, pour éviter des artefacts Docker Desktop (`kubernetes.docker.internal`) sous Windows.

## logwatcher.go — tail de logs et extraction d'événements

`LogWatcher` est le composant central qui transforme des lignes de log brutes en `AgentIpEvent` (IP, username, service, `eventType` = `auth_failure`/`auth_success`/`port_scan`, timestamp RFC3339, raw log). Fonctionnement :

- **`watchLoop()`** tourne toutes les 10s et appelle `startWatchers()`, qui pour chaque config de service activée (`cfg.Enabled`) résout le chemin de log (`resolveLogPath()` → `logpaths.go`) et lance une goroutine de tail si ce fichier n'est pas déjà surveillé.
- Trois modes de tail selon le préfixe du chemin résolu :
  - **fichier classique** (`tailFile`) : poll toutes les secondes, suit un offset persistant entre itérations (le commentaire dans le code souligne un bug historique corrigé — l'ancienne version faisait `Seek(0, io.SeekEnd)` à chaque itération et ne lisait donc jamais rien) ; détecte la rotation/troncature en comparant la taille du fichier à l'offset stocké.
  - **`journald:UNIT`** (`tailJournald`) : lance `journalctl -fu UNIT --output=short-traditional -n 0` en sous-processus, produit des lignes au format syslog classique compatibles avec les parsers existants — utilisé sur les systèmes purement journald sans rsyslog (Debian 9+/Ubuntu 20.04+ détectés via la présence de `ssh.service` dans les unités systemd).
  - **`clog:/path`** (`tailClog`) : suit un journal circulaire BSD via `clog -f FILE` (OPNsense < 22.1). La détection du format clog se fait par magic bytes (`0x49 0xEE`) dans `logpaths.go` (`isClogFile`).
- **`addEvent()`** stocke l'événement et envoie un signal non-bloquant sur `flushCh` — consommé par `cmd_ws.go` pour le flush débouncé à 500ms.
- **`DrainEvents()` / `DrainSamples()`** vident et retournent le buffer (utilisés à la fois par le heartbeat WS et par `push()` legacy).

### Parsers (`LogParser` interface)

Chaque type de service a un parser regex dédié, mappé dans `NewLogWatcher()` :

| Parser | Détection |
|---|---|
| `SSHParser` | `Failed password/publickey for ... from IP` / `Accepted password/publickey for ... from IP` |
| `RDPParser` | Lignes Windows Event Log pré-formatées `EventID:4625 ... Account Name ... Source Network Address` (voir `eventlog_windows.go`) |
| `NginxParser` / `ApacheParser` | Ligne de log d'accès avec statut HTTP `401` |
| `IISParser` | Format W3C, colonne `c-ip` + statut `401` |
| `FTPParser` | `FAIL LOGIN: Client "IP"` (vsftpd/proftpd) ou `FAILED LOGIN`/`authentication failure` |
| `MailParser` | Dovecot (`auth failed ... rip=IP`) et Postfix (`SASL ... authentication failed ... [IP]`) |
| `MySQLParser` | `Access denied for user 'user'@'IP'` |
| `OPNsenseParser` | Échecs Web GUI, erreurs d'auth génériques, SSH (réutilise `sshFailRe`), utilisateurs invalides |
| `OPNsenseFilterParser` | Parse le CSV `filterlog` de pf (blocages entrants → `auth_failure`, NAT `pass` sur ports connus → `auth_success`) |
| `CustomRegexParser` | Regex fournie par le serveur avec groupes nommés `?P<ip>` et `?P<username>` |

`resolveLogPath()` distingue les services custom (clé `custom:/chemin`) des services intégrés, pour lesquels `defaultLogPath()` (`logpaths.go`) fournit les chemins par défaut par OS — ex. Linux SSH essaie `/var/log/auth.log` puis `/var/log/secure`, puis retombe sur `journald:ssh.service`/`journald:sshd.service` selon la distro ; FreeBSD/OPNsense SSH et Web UI pointent vers `/var/log/audit/latest.log`.

## firewall.go — application des bans au niveau pare-feu

`FirewallManager` est l'interface commune (`BanIP`, `UnbanIP`, `GetBannedIPs`, `Flush`, `IsAvailable`, `Name`, `IsRateLimitSupported`, `ApplyRateLimits`). `DetectFirewall()` sélectionne le backend selon l'OS :

- **Linux** : ordre de priorité `NftablesFirewall` → `FirewalldFirewall` → `UFWFirewall` → `IptablesFirewall`, sinon `NoOpFirewall`.
- **Windows** : `WindowsFirewall` (netsh), sinon `NoOpFirewall`.
- **macOS** : `PFFirewall`, sinon `NoOpFirewall`.
- **FreeBSD** : `FreeBSDPFFirewall`, sinon `NoOpFirewall`.

Stratégies notables, toutes conçues pour rester à un nombre de règles **constant** quel que soit le nombre d'IPs bannies :

- **nftables** : une table `obliguard`, un set `obliguard_ips` (`type ipv4_addr`), deux chaînes (`blocklist` en hook `input`, `blocklist_out` en hook `output`, priorité `-10`) avec une seule règle chacune qui matche le set. Ban/unban = ajout/suppression d'éléments dans le set, batché via `Flush()`.
- **firewalld** : ipset natif `obliguard` référencé par deux rich-rules ; migration automatique des anciennes rich-rules par-IP vers l'ipset au premier `init()` (`migrateLegacyRichRules`).
- **ufw** : ufw ne supporte pas les ipsets nativement — l'agent crée un ipset `obliguard` et injecte directement des règles `iptables -I INPUT/OUTPUT -m set --match-set obliguard ...` en contournant ufw, avec migration des anciennes règles `ufw deny from IP`.
- **iptables** : chaînes dédiées `OBLIGUARD`/`OBLIGUARD_OUT` hookées dans `INPUT`/`OUTPUT` ; utilise un ipset si disponible, sinon règles individuelles par IP en fallback.
- **Windows** : stratégie « 2 règles groupées » — `Obliguard-Block-in`/`-out`, avec la liste d'IPs en `remoteip` séparée par virgules. `obliguard-banlist.txt` (à côté de l'exécutable) sert de source de vérité persistante. Au-delà de `maxIPsPerRule = 500`, les IPs sont réparties en règles numérotées (`Obliguard-Block-in-2`, etc.) car `netsh` peut échouer silencieusement sur de très longues listes `remoteip`. Un nettoyage des anciennes règles par-IP legacy (`Obliguard-Block-A-B-C-D-*`) est fait une fois au premier `Flush()`.
- **macOS/FreeBSD (pf)** : une table `obliguard_blocklist` gérée via `pfctl -t ... -T add/delete/show` ; sur FreeBSD, `ensureTable()` initialise un ancrage pf nommé `obliguard` avec les règles `block in/out quick from/to <obliguard_blocklist>` (compatible OPNsense).

### Rate-limiting par IP

`IsRateLimitSupported()`/`ApplyRateLimits(rules []RateLimitRule)` implémentent une limitation de débit par IP indépendante du système de ban, avec deux types de règles (`connection` = connexions concurrentes, `rate` = nouvelles connexions/s, `volume` = octets/s en mode `drop`) et une escalade optionnelle vers un ban temporisé (`BanMultiplier` × `MaxValue` déclenche l'ajout à un set/ipset séparé avec TTL, `BanTTLSeconds`) :

- **nftables** : chaînes `ratelimit_in`/`ratelimit_fwd` (priorité `-15`, avant les chaînes de ban à `-10`), meters déclaratifs reconstruits à chaque appel, set `obliguard_rl_bans` avec `flags timeout`.
- **iptables/ufw** : chaîne `OBLIGUARD_RL` hookée sur `INPUT` + soit `DOCKER-USER` (si présent) soit `FORWARD`, `connlimit`/`hashlimit` pour les seuils, `ipset` avec target `SET --add-set ... --timeout` pour l'escalade.
- **Windows** : implémentation réelle basée sur le driver **WinDivert** (`firewall_ratelimit_windows.go`), désactivée tant que `WinDivert.dll` n'est pas présent à côté du binaire ; deux modes de capture (SYN-only pour `rate`, tous paquets pour `volume`). Sur les autres OS, `firewall_ratelimit_other.go` fournit un no-op pour `WindowsFirewall`.
- **firewalld / pf (macOS, FreeBSD)** : non implémenté (`IsRateLimitSupported() → false`) — nécessiterait respectivement une approche nft-direct/native et un anchor pf dédié (`keep-state max-src-conn` / dummynet).

## firewall_rules.go et fichiers `firewall_rules_*.go` — gestion des règles système

Distinct du `FirewallManager` (qui ne gère que les bans Obliguard) : `FirewallRuleManager` expose la gestion **complète** des règles pare-feu de la machine (`ListRules`, `AddRule`, `DeleteRule`, `ToggleRule`), utilisée par la page `AgentDetailPage.tsx` côté client pour piloter le pare-feu à distance. `DetectFirewallRuleManager()` retourne l'implémentation enregistrée par le `init()` du fichier `firewall_rules_<os>.go` correspondant :

- `firewall_rules_windows.go` → `WindowsRuleManager` (parse `netsh advfirewall firewall show rule name=all verbose`, filtre les règles de ban Obliguard qui contiennent des milliers d'IPs).
- `firewall_rules_linux.go` → `detectLinuxRuleManager()` choisit entre `NftRuleManager`, `FirewalldRuleManager`, `UfwRuleManager`, `IptablesRuleManager` selon ce qui est disponible.
- `firewall_rules_darwin.go` / `firewall_rules_freebsd.go` → `DarwinRuleManager`/`FreeBSDRuleManager`, tous deux basés sur `pfctl -sr` et le parseur commun `parsePfRules()` (partagé dans `firewall_rules.go`).

`handleFirewallCommand()` (appelé depuis `cmd_ws.go`) désérialise le payload de la commande WS, appelle la méthode correspondante sur le `FirewallRuleManager`, et répond avec un `FwResponse` incluant l'ID de corrélation d'origine (mécanisme `pushAndWait()` côté serveur, timeout 30s).

## websocket.go — client WebSocket sans dépendance externe

Implémentation manuelle du protocole RFC 6455 côté client (pas de bibliothèque tierce) : handshake HTTP `Upgrade`, encodage/décodage de frames binaires avec masking XOR obligatoire côté client (`WriteFrame`), lecture de frames avec gestion des tailles étendues (126/127, payloads > 65535 octets), réponse automatique aux pings serveur (`SendPong`). `wsConn.wmu` (mutex) protège `WriteFrame` contre les écritures concurrentes, car plusieurs goroutines (heartbeat, flush d'événements, réponses aux commandes firewall) peuvent écrire sur la même connexion.

## logpaths.go — résolution des chemins de log par OS

`defaultLogPath(serviceType)` centralise les emplacements par défaut, avec des variantes `defaultLogPathLinux/Darwin/Windows/FreeBSD`. Particularités :
- Linux SSH : préfère les fichiers (`auth.log`/`secure`) et ne bascule sur `journald:` que si aucun fichier n'existe, en détectant le nom d'unité systemd correct (`ssh.service` Debian/Ubuntu vs `sshd.service` RHEL/CentOS/Arch).
- FreeBSD/OPNsense : gère à la fois les logs texte modernes (syslog-ng, 22.x+) et les anciens logs circulaires `clog` (< 22.1), avec détection automatique du format par magic bytes.
- Windows : ne fournit de chemin que pour IIS et MySQL — SSH/RDP passent exclusivement par le poller Windows Event Log (pas de tail de fichier).

## osinfo.go — identification de la plateforme

`getOSInfo()` construit un `OSInfo{Platform, Distro, Release, Arch}` envoyé à chaque heartbeat/push, avec des sous-fonctions par OS : parsing de `/etc/os-release` (`PRETTY_NAME`/`VERSION_ID`) sur Linux, `sw_vers -productVersion` sur macOS, `cmd /c ver` sur Windows, `freebsd-version` (fallback `uname -r`) sur FreeBSD.

## uninstall.go — désinstallation à distance

`handleUninstallCommand()` est déclenché par une commande one-shot du serveur (`Command: "uninstall"` dans la réponse `config`/`pushResponse`) et délègue à une fonction par OS, qui écrit un script détaché puis `os.Exit(0)` pour que le script survive à l'arrêt du process/service :

- **Windows** (`handleWindowsUninstall`) : télécharge le MSI (`/api/agent/download/obliguard-agent.msi`) puis lance un `.bat` détaché qui exécute `msiexec /x ... /quiet /norestart`.
- **Linux** (`handleLinuxUninstall`) : script shell qui arrête/désactive le service (`systemctl`/`service`, compatible systemd et SysV), supprime les objets de rate-limiting nftables/iptables (chaînes `ratelimit_in`/`ratelimit_fwd`, `OBLIGUARD_RL`, sets `obliguard_rl_bans`) pour ne pas laisser du trafic bloqué orphelin, puis supprime `/opt/obliguard-agent/` (la config sous `/etc/obliguard-agent/` est conservée).
- **macOS** (`handleDarwinUninstall`) : `launchctl unload` du daemon puis suppression du plist et du binaire.
- **FreeBSD** (`handleFreeBSDUninstall`) : arrête le service rc.d, désactive `sysrc`, vide/détruit la table et l'ancre pf, supprime les hooks OPNsense (`filter/obliguard_reload.sh`, `actions_obliguard.conf`, `pf.opnsense.d/obliguard.conf`) et le script rc.d.

## Fichiers spécifiques par plateforme

Regroupés par paire `<feature>.go` (commun) + `<feature>_<os>.go`/`<feature>_stub.go` (implémentation ou no-op), sélectionnés à la compilation via build tags :

| Fichier commun | Rôle | Implémentations OS |
|---|---|---|
| `machine_uuid.go` | UUID stable de la machine, cascade SMBIOS → disque → stocké → aléatoire. **Fichier partagé verbatim entre tous les agents Obli\*** — toute modification doit être répercutée partout | `machine_uuid_windows.go` (CIM/wmic), `machine_uuid_linux.go` (`/etc/machine-id` en priorité — ne jamais changer l'ordre, casserait l'identité des agents déjà déployés), `machine_uuid_darwin.go` (`ioreg IOPlatformUUID`), `machine_uuid_freebsd.go` (`kenv smbios.system.uuid` puis `/etc/hostid`), `machine_uuid_stub.go` |
| `netconn.go` | Table `servicePorts` (port → nom de service) et logique commune du moniteur de connexions TCP entrantes (émet des `auth_success` pour le NetMap) | `netconn_windows.go` (API `GetExtendedTcpTable` d'`iphlpapi.dll`, remplace un ancien appel PowerShell coûteux en CPU), `netconn_linux.go` (`/proc/net/tcp`/`tcp6`), `netconn_freebsd.go` (`sockstat`), `netconn_stub.go` (no-op sur les autres OS) |
| — | Poller Windows Event Log (EventID 4625/4624) pour RDP/auth | `eventlog_windows.go` (poll toutes les 15s à partir d'un curseur `RecordId`, injecte directement dans le `LogWatcher`), `eventlog_stub.go` (no-op — Linux/macOS utilisent le tail de fichiers) |
| — | Détection/lancement en tant que service OS | `service_windows.go` (implémente `svc.Handler` du SCM Windows, redirige les logs vers `agent.log` en mode service), `service_darwin.go` (installe/désinstalle un `launchd` daemon), `service_freebsd.go` (script rc.d), `service_stub.go` (no-op sur Linux — géré par systemd via l'unit fournie à l'installation, hors du binaire agent) |
| — | Lecture de config depuis le registre Windows (fallback si `config.json` absent) | `registry_windows.go` (`SOFTWARE\ObliguardAgent`), `registry_stub.go` (erreur sur les autres OS) |
| — | Redémarrage après auto-update | `restart_windows.go` (`os.Exit(0)`, le redémarrage réel est géré par le script batch `msiexec`), `restart_unix.go` (`syscall.Exec` en place — remplace le process sans changer de PID, essentiel sur les systèmes sans superviseur comme Unraid) |
| `firewall_rules.go` | Interface `FirewallRuleManager`, dispatch des commandes WS `firewall_*`, parseur pf partagé (`parsePfRules`) | `firewall_rules_windows.go`, `firewall_rules_linux.go` (choix dynamique nft/firewalld/ufw/iptables), `firewall_rules_darwin.go`, `firewall_rules_freebsd.go` |
| — | Rate-limiting par IP sous Windows (WinDivert) | `firewall_ratelimit_windows.go` (implémentation réelle, conditionnée à la présence de `WinDivert.dll`), `firewall_ratelimit_other.go` (no-op sur les autres OS, car l'implémentation réelle de `WindowsFirewall` n'est pertinente que sous Windows) |

## Flux de données résumé

```
Log système (auth.log, journald, Event Log, filter.log...)
        │  tail / poll
        ▼
LogWatcher (logwatcher.go) — parsers regex par service
        │  AgentIpEvent{ip, username, service, eventType, timestamp}
        ▼
cmd_ws.go — flush débouncé 500ms (événements) + heartbeat 30s (état complet)
        │  WebSocket wss://.../api/agent/ws?uuid=...
        ▼
server/src/services/obliguardHub.service.ts (hub WS serveur)
        │  ban.service.ts évalue les seuils toutes les 30s
        ▼
cmdConfigMsg{banList, whitelist, services, rateLimits, command}
        │  frame "config"
        ▼
firewall.go (FirewallManager) — BanIP/UnbanIP/Flush sur le backend natif
```
