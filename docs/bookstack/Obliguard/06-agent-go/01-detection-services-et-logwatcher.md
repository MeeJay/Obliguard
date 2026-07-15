L'agent Go d'Obliguard détecte automatiquement les services exposés sur la machine hôte, puis suit (« tail ») leurs fichiers de log pour en extraire les événements d'authentification (échecs/succès de connexion). Ces deux mécanismes sont implémentés respectivement dans `agent/services.go` et `agent/logwatcher.go`.

## Détection automatique des services (`agent/services.go`)

### Principe

`detectServices()` scanne les ports TCP en état `LISTEN` sur la machine, puis les met en correspondance avec une table de services connus (`knownServices`) :

| Service   | Ports                                   |
|-----------|------------------------------------------|
| ssh       | 22                                        |
| rdp       | 3389                                      |
| ftp       | 21                                        |
| mail      | 25, 587, 465, 143, 993, 110, 995          |
| mysql     | 3306                                      |
| nginx     | 80, 443, 8080, 8443                       |
| apache    | 80, 443, 8080, 8443                       |
| iis       | 80, 443, 8080                             |
| opnsense  | 443, 4443, 8443 (uniquement sur FreeBSD)  |

Le scan de ports est spécifique à chaque OS, via `getListeningPorts()` :

- **Linux** : `ss -tlnp`, avec repli sur `netstat -tlnp` si `ss` est absent (`getListeningPortsLinux`, parsing dans `parseSSOutput`).
- **Windows** : `netstat -anp TCP`, filtré sur les lignes contenant `LISTENING` (`parseNetstatWindows`).
- **macOS** : `netstat -anp tcp` (`parseNetstatDarwin`).
- **FreeBSD** : `sockstat -4l -P tcp`, avec repli sur `netstat -anp tcp` (`getListeningPortsFreeBSD`, `parseSockstatListening`).

Chaque parseur extrait le port de l'adresse locale via `extractPort()`, qui gère les formats `[::]:22`, `*:22`, `0.0.0.0:22` et IPv6 entre crochets.

### Résolution port → service

`resolvePortsToServices()` mappe chaque port ouvert détecté vers un type de service. Comme nginx, apache et iis partagent les mêmes ports (80/443/8080/8443), un mécanisme de déduplication (`svcFirst` / `deduped`) ne retient qu'une seule correspondance par type de service — le premier port matché l'emporte.

### Cas particulier OPNsense

Sur FreeBSD, si `isOPNsenseAgent()` détecte la présence d'OPNsense (test d'existence de `/usr/local/opnsense/version/core`), `detectServices()` :

1. Remplace `nginx`/`apache` par `opnsense` sur les ports 443/4443/8443 (l'UI web OPNsense tourne sur nginx en interne, mais doit être traitée par le parseur OPNsense).
2. Ajoute systématiquement un service virtuel `opnsense_filter` (sans port associé, `Port: nil`) qui surveille le log `filterlog` de `pf` plutôt qu'un port réseau.

### Résultat

`detectServices()` retourne `[]AgentDetectedService` (définie dans `agent/push.go`) :

```go
type AgentDetectedService struct {
    Type   string `json:"type"`
    Port   *int   `json:"port,omitempty"`
    Active bool   `json:"active"`
}
```

Cette liste est envoyée au serveur dans le payload de heartbeat (`Services` dans `pushBody`), ce qui permet à l'interface d'admin de proposer automatiquement les services détectés lors de la configuration des templates (`server/src/services/serviceTemplate.service.ts`).

Une fonction `probePort()` (dial TCP avec timeout 500 ms) existe comme sonde ponctuelle de secours mais n'est pas utilisée par le flux principal de détection.

## Logwatcher : tailing et parsing (`agent/logwatcher.go`)

### Structure `LogWatcher`

`LogWatcher` (créé par `NewLogWatcher`) maintient :

- `events []AgentIpEvent` — buffer d'événements accumulés depuis le dernier drain.
- `configs map[string]AgentServiceConfig` — configuration par service, poussée par le serveur (seuil, fenêtre temporelle, activation, regex personnalisée).
- `parsers map[string]LogParser` — un parseur par type de service (`ssh`, `rdp`, `nginx`, `apache`, `iis`, `ftp`, `mail`, `mysql`, `opnsense`, `opnsense_filter`).
- `watchedFiles map[string]struct{}` — fichiers/unités actuellement suivis, pour éviter de lancer deux goroutines de tail sur la même source.
- `flushCh chan struct{}` — canal de signalisation non-bloquant utilisé par la boucle WebSocket (`agent/cmd_ws.go`) pour déclencher un flush des événements avec un debounce de 500 ms.

### Boucle de surveillance

`Start()` lance `watchLoop()` dans une goroutine, qui appelle `startWatchers()` immédiatement puis toutes les 10 secondes (`time.NewTicker(10 * time.Second)`). À chaque itération, pour chaque service dont `cfg.Enabled` est vrai :

1. `resolveLogPath(svcKey, cfg)` détermine le chemin du log : soit un chemin personnalisé (clé préfixée `custom:`), soit le chemin par défaut de la plateforme via `defaultLogPath()` (`agent/logpaths.go`).
2. Si le fichier n'est pas déjà suivi (`watchedFiles`), une goroutine de tail est lancée selon le type de source :
   - Préfixe `journald:` → `tailJournald()` (suit une unité systemd via `journalctl -fu UNIT --output=short-traditional -n 0`).
   - Préfixe `clog:` → `tailClog()` (logs circulaires BSD/OPNsense, via `clog -f FICHIER`).
   - Sinon → `tailFile()` (tail classique par polling de fichier).
3. Si `cfg.SampleRequested` est vrai (demande d'échantillon depuis l'UI), une goroutine de collecte des 50 dernières lignes est lancée en parallèle (`collectSample`, `collectJournaldSample`, `collectClogSample`).

### `tailFile` : suivi par polling

`tailFile()` ouvre le fichier, stat sa taille à chaque itération (poll toutes les secondes) et lit uniquement les octets ajoutés depuis le dernier offset connu :

- Au premier passage, l'offset est positionné en fin de fichier (`offset = size`) : seul le contenu écrit après le démarrage de l'agent est traité, pas l'historique.
- Si la taille du fichier chute sous l'offset stocké, cela signale une rotation/troncature du log ; l'offset est réinitialisé à 0.
- Chaque nouvelle ligne complète (découpée sur `\n`, `\r` retiré) est passée au parseur du service (`parser.Parse(line, svcKey)`), et chaque `AgentIpEvent` produit est ajouté via `addEvent()`.
- Si la config du service est désactivée en cours de route (détecté à chaque ligne), le tail s'arrête et se retire de `watchedFiles`.

Le commentaire dans le code (lignes 233-239) documente explicitement un bug corrigé : l'implémentation initiale appelait `Seek(0, io.SeekEnd)` à chaque itération, ce qui plaçait systématiquement le curseur en fin de fichier et empêchait toute lecture de nouvelle ligne.

### `tailJournald` et `tailClog`

Pour les systèmes sans fichier de log plat (systemd journal, OPNsense clog), l'agent délègue au binaire externe :

- `tailJournald` exécute `journalctl -fu <unit> --output=short-traditional -n 0` et lit sa sortie ligne à ligne via un `bufio.Scanner` sur le stdout du process. Le format `short-traditional` produit des lignes identiques au syslog classique, donc réutilisables telles quelles par les parseurs existants (SSHParser, etc.). Si la commande se termine, elle est relancée après 5 secondes.
- `tailClog` fait de même avec `clog -f <fichier>`, utilisé sur OPNsense pour les logs circulaires antérieurs à la 22.1.

### Résolution des chemins de log par défaut (`agent/logpaths.go`)

`defaultLogPath(serviceType)` dispatche par OS (`defaultLogPathLinux`, `defaultLogPathDarwin`, `defaultLogPathWindows`, `defaultLogPathFreeBSD`). Exemples notables :

- **SSH sur Linux** : tente `/var/log/auth.log` puis `/var/log/secure` ; si aucun n'existe (système journald pur), détecte l'unité systemd (`ssh.service` sur Debian/Ubuntu vs `sshd.service` sur RHEL/CentOS/Arch) et retourne `journald:ssh.service`.
- **SSH/OPNsense sur FreeBSD** : `firstExistingFreeBSD()` teste `/var/log/audit/latest.log` (syslog-ng, OPNsense 22.x+), sinon `/var/log/auth.log`, et détecte automatiquement les fichiers clog via leur en-tête magique (`0x49 0xEE`, fonction `isClogFile`) pour les préfixer `clog:`.
- **Windows** : SSH/RDP ne passent pas par un fichier — ils sont traités par un poller séparé du journal d'événements Windows (`agent/eventlog_windows.go`, EventID 4625/4624). Seuls `iis` (`C:\inetpub\logs\LogFiles\W3SVC1\u_ex*.log`) et `mysql` ont un chemin par défaut ici.
- **OPNsense filterlog** : `/var/log/filter/latest.log` (22.x+) ou `/var/log/filter.log` (clog, <22.1).

### Parseurs regex par service

Chaque service dispose d'un parseur implémentant l'interface `LogParser` :

```go
type LogParser interface {
    Parse(line, svcKey string) []AgentIpEvent
}
```

| Parseur | Regex clé | Extrait |
|---|---|---|
| `SSHParser` | `Failed (password\|publickey) for (invalid user )?(\S+) from (IP)` / `Accepted ...` | IP, username, `auth_failure`/`auth_success` |
| `RDPParser` | `EventID:4625.*?Account Name:\s+(\S+).*?Source Network Address:\s+([\d.]+)` | IP, username, `auth_failure` (lignes déjà pré-formatées par le poller Windows Event Log) |
| `NginxParser` / `ApacheParser` | `^(IP) .* " [^"]*" 401 ` | IP, `auth_failure` sur code HTTP 401 (fonction commune `parseHTTPAuthLine`) |
| `IISParser` | format W3C, champ `c-ip` + code `401` | IP, `auth_failure` |
| `FTPParser` | `FAIL LOGIN: Client "([\d.]+)"` + repli `FAILED LOGIN`/`authentication failure` (vsftpd/proftpd) | IP, `auth_failure` |
| `MailParser` | Dovecot `auth failed .* rip=([\d.]+)` / Postfix `SASL .* authentication failed.* \[([\d.]+)\]` | IP, `auth_failure` |
| `MySQLParser` | `Access denied for user '([^']+)'@'([\d.]+)'` | username, IP, `auth_failure` |
| `OPNsenseParser` | plusieurs regex combinées (Web GUI, `Authentication error for`, SSH `Failed password`, `Invalid`/`Illegal user`, succès) | IP, username, `auth_failure`/`auth_success` |
| `OPNsenseFilterParser` | parsing CSV du champ `filterlog` de `pf` (rulenr, action, dir, ipver, proto, src_ip, dst_ip, ports…) | IP source, `auth_failure` pour `block`, `auth_success` pour `pass` sur port connu |
| `CustomRegexParser` | regex utilisateur avec groupes nommés `(?P<ip>...)` et `(?P<username>...)` | IP (obligatoire), username, `auth_failure` |

`getParser()` privilégie `CustomRegexParser` si `cfg.CustomRegex` est renseigné (templates personnalisés côté serveur), sinon utilise le parseur intégré correspondant à `svcKey`.

### Génération des événements

Chaque ligne matchée produit un `AgentIpEvent` via `makeEvent()` :

```go
type AgentIpEvent struct {
    ID        string `json:"id"`
    IP        string `json:"ip"`
    Username  string `json:"username,omitempty"`
    Service   string `json:"service"`
    EventType string `json:"eventType"` // "auth_failure" | "auth_success" | "port_scan"
    Timestamp string `json:"timestamp"` // RFC3339
    RawLog    string `json:"rawLog,omitempty"`
}
```

L'`ID` combine un UUID v4 et un timestamp nanoseconde (`uuid.New().String()-UnixNano()`) pour garantir l'unicité même en cas d'événements simultanés. `addEvent()` ajoute l'événement au buffer (protégé par mutex) puis envoie un signal non-bloquant sur `flushCh` — la boucle WebSocket (`agent/cmd_ws.go`, `sendOGEvents`) draine ce buffer et pousse les événements au serveur avec un debounce de 500 ms, offrant une latence quasi temps réel côté ban engine (`server/src/services/ban.service.ts`).

### Activation conditionnelle

`IsServiceEnabled(svc)` et `IsAnyEnabled(svcs)` exposent l'état d'activation des configs reçues du serveur. Ils sont utilisés par les pollers qui ne passent pas par `tailFile` (poller Windows Event Log, moniteur de connexions TCP) afin qu'ils respectent la même règle d'opt-in que le tail de fichier : aucun événement n'est émis pour un service sans template actif côté serveur.
