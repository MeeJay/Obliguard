L'agent Go d'Obliguard est capable de se mettre à jour lui-même et de se désinstaller entièrement à distance, sans aucune intervention manuelle sur la machine hôte. Ces deux mécanismes reposent sur le même principe : écrire un script détaché (batch sous Windows, shell sur Unix) qui survit à l'arrêt du process agent, puis quitter immédiatement (`os.Exit(0)`) pour libérer le binaire/l'exécutable avant que le script n'agisse dessus.

## Auto-update

### Déclenchement

La version distante attendue arrive de deux façons :

- **Au démarrage** : `checkForUpdate()` (`agent/main.go`) appelle `GET /api/agent/version` une seule fois et délègue à `applyUpdateIfNewer()`. Depuis C17-1, cet appel (sans session) reçoit `{ "version": "" }` : toutes les versions de l'agent sortent immédiatement sur une version vide (`main.go`, et `agent/src/index.js` pour l'ancien agent Node). Le démarrage ne déclenche donc plus aucune mise à jour.
- **En fonctionnement normal** : la version cible peut être jointe à la réponse serveur, aussi bien sur l'ancien canal HTTP push (`push.go`, champ `LatestVersion`) que sur le canal WebSocket persistant (`cmd_ws.go`, champ `LatestVersion` du message de config). Dans `applyOGConfig()` (`agent/cmd_ws.go`), dès que `msg.LatestVersion != ""`, `applyUpdateIfNewer(cfg, msg.LatestVersion)` est appelé. Le serveur n'envoie `latestVersion` **que si la politique de mise à jour le permet** (voir ci-dessous).

Le serveur lit la version servie dans `agent/VERSION` (repli : littéral `agentVersion` de `agent/main.go`, sauf `dev`), en cherchant le dossier `agent/` dans la disposition dist (`server/dist/src/services` → `/app/agent` en Docker) puis dans la disposition src (serveur lancé avec `tsx` en dev). Une valeur invalide (plus de 64 caractères, pas au format `X.Y.Z`) n'est jamais annoncée. La route de téléchargement utilise le même dossier.

### Politique de mise à jour (C17-1)

Le serveur décide quand un agent se met à jour. Trois niveaux, chacun `auto` | `manual` | `off` (absent = hériter) :

- **global** : `app_config.agent_global_config.updatePolicy` (Paramètres → Réglages agents par défaut). Modifiable uniquement par un admin plateforme **depuis le tenant Default**. Non défini = défaut intégré **`manual`** (valeur de toutes les installations existantes au déploiement).
- **groupe** : `monitor_groups.agent_group_config.updatePolicy`, hérité par les sous-groupes (`group_closure`). Admin plateforme, uniquement sur un groupe du tenant courant. Seuls les groupes **du tenant de l'agent** comptent dans la chaîne (un ancêtre d'un autre tenant est ignoré).
- **agent** : colonne `agent_devices.update_policy` (migration 027). Membres du tenant courant ayant `monitor_rw`.

Résolution : `off` à n'importe quel niveau est **absolu** (gèle tout le sous-arbre ; `off` global = arrêt d'urgence de toute la flotte). Sinon la valeur explicite la plus proche l'emporte (agent → groupe le plus proche → global → `manual`). Si la lecture de la chaîne de groupes échoue, l'agent est résolu `off` avec la source `unresolved` : pas de mise à jour, mais les bans et la whitelist continuent d'être livrés.

`latestVersion` est envoyé (HTTP push et hub WS, via `handlePush`) seulement si :

1. la version servie est strictement plus récente que celle remontée par l'agent (même comparaison que `isStrictlyNewer` en Go) ;
2. la politique est `auto`, **ou** une demande explicite « Mettre à jour » est active.

`auto` suit chaque nouvelle version dès que le serveur la sert (pas de plafond) : pour étager un déploiement, laisser le global en `manual`, passer un groupe pilote en `auto` (ou cliquer « Mettre à jour les agents en retard » sur ce groupe), vérifier, puis élargir.

**Demande explicite** (`POST /api/agent/devices/:id/agent-update`, `/devices/bulk-request-update`, `/groups/:groupId/agent-update`, ou la commande `update`) : colonnes `update_requested_at` / `update_requested_version` / `update_requested_by`. Elle vise la version servie au moment du clic et devient caduque si le serveur en sert une autre, après **24 h**, ou si l'agent est suspendu, refusé ou passé en `off`. Elle est close dès que l'agent remonte la version visée.

**Limitation** : au plus une offre par agent toutes les **10 minutes** (en `auto` comme sur demande) ; une demande est abandonnée après **3 offres** sans que l'agent remonte la nouvelle version. Recliquer redonne 3 offres mais ne raccourcit pas l'intervalle de 10 minutes (pas de boucle téléchargement/redémarrage). Cet état est en mémoire : un redémarrage du serveur peut permettre une offre de plus.

Un import (Import/Export) ne réactive jamais la mise à jour automatique : le contrôleur d'import passe `agent_group_config` par `sanitizeImportedAgentGroupConfig`, qui ignore une politique `auto` et ne garde que `manual` / `off` (et les clés connues). Les routes d'import ne sont pas montées actuellement ; la protection est déjà câblée pour leur remise en service.

### Comparaison de version

`isStrictlyNewer(remote, current)` (`agent/main.go:175`) fait une comparaison sémantique stricte (major.minor.patch) via `parseSemver()`. Toute version malformée est traitée comme `0.0.0`, donc toujours inférieure — évite qu'une réponse serveur corrompue ne déclenche une mise à jour ou une régression.

### Séquence `applyUpdateIfNewer()` (`agent/main.go:217`)

1. Vérifie `isStrictlyNewer(remoteVersion, agentVersion)` — sort immédiatement si déjà à jour.
2. Appelle `notifyServerUpdating(cfg)` (`agent/update_notify.go`) : `POST /api/agent/notifying-update` fire-and-forget (timeout 10 s). Le serveur bascule le device en badge « UPDATING » et suspend les alertes offline pendant 10 minutes, pour éviter de spammer les admins pendant le redémarrage du service.
3. Détermine le nom de fichier à télécharger :
   - Windows : `obliguard-agent.msi` (l'installeur gère l'enregistrement du service, etc.)
   - Autres OS : `obliguard-agent-<GOOS>-<GOARCH>` (binaire nu)
4. `GET /api/agent/download/<filename>` avec un timeout de 120 s (taille MSI). Toute erreur réseau ou statut ≠ 200 abandonne la mise à jour silencieusement — le prochain cycle réessaiera.

### Côté serveur : `/api/agent/download/:filename`

`agentDownload()` (`server/src/controllers/agent.controller.ts:100`) whitelist strictement les noms de fichiers autorisés via la map `ALLOWED_AGENT_BINARIES` :

```ts
const ALLOWED_AGENT_BINARIES: Record<string, string> = {
  'obliguard-agent.msi':            'obliguard-agent.msi',
  'obliguard-agent.exe':            'obliguard-agent.exe',
  'obliguard-agent-linux-amd64':    'obliguard-agent-linux-amd64',
  'obliguard-agent-linux-arm64':    'obliguard-agent-linux-arm64',
  'obliguard-agent-darwin-amd64':   'obliguard-agent-darwin-amd64',
  'obliguard-agent-darwin-arm64':   'obliguard-agent-darwin-arm64',
  'obliguard-agent-freebsd-amd64':  'obliguard-agent-freebsd-amd64',
};
```

Tout nom hors de cette liste renvoie 404. Le fichier est résolu depuis `agent/dist/` sur le disque du serveur (dossier `agent/` résolu par `resolveAgentRoot()`, dispositions dist puis src) et servi via `res.sendFile()`.

### Application de la mise à jour

**Unix (Linux/macOS/FreeBSD)** — pas de script détaché ici, mise à jour en place :

1. Le nouveau binaire est écrit dans `<exePath>.new`.
2. `os.Rename(tmpPath, exePath)` — remplacement atomique du binaire en cours d'exécution (possible sous Unix car le système garde l'inode ouvert par le process en cours).
3. `restartWithNewBinary(exePath)` — ré-exécute le process en place (même PID côté OS, `exec` syscall), fonctionne sans dépendre d'un service manager.

**Windows** — passage obligatoire par `msiexec`, car le binaire en cours d'exécution est verrouillé par l'OS :

`applyWindowsMSIUpdate()` (`agent/main.go:323`) écrit un batch détaché dans `%TEMP%\obliguard-msi-update.bat` :

```bat
@echo off
timeout /t 2 /nobreak >nul
msiexec /i "<msiPath>" /quiet /norestart SERVERURL="<url>" APIKEY="<key>" /l*v "<logPath>"
del /q "<msiPath>"
del /q "%~f0"
```

Le script est lancé via `exec.Command("cmd", "/c", scriptPath).Start()` (non bloquant), puis l'agent appelle `restartWithNewBinary("")` qui, sous Windows, ignore l'argument et fait directement `os.Exit(0)` — l'exécutable doit être déverrouillé avant que `msiexec` ne tente de l'écraser. `SERVERURL`/`APIKEY` sont repassés en propriétés MSI en belt-and-suspenders, au cas où `config.json` serait absent. Le `/l*v` journalise l'installation dans `obliguard-update.log` pour diagnostic.

L'ordre `Stop service → overwrite files → restart service` est géré nativement par le `<ServiceControl Stop="both">` défini dans le WiX (`agent/installer/product.wxs`), pas par le script lui-même.

## Désinstallation à distance

### Déclenchement

La désinstallation est une commande one-shot, comme les commandes firewall. Le contrôleur `sendDeviceCommand` / `bulkDeviceCommand` (`server/src/controllers/agent.controller.ts:477`,`:491`) écrit `pending_command = 'uninstall'` en base sur `agent_devices` via `agentService.sendCommand()` / `bulkSendCommand()` (`server/src/services/agent.service.ts:533`).

Cette commande est délivrée à l'agent soit immédiatement via le canal WebSocket (`obliguardHub.service.ts`), soit récupérée lors du prochain heartbeat HTTP push si l'agent est hors ligne au moment de l'émission. Côté serveur, dès que la commande est consommée par l'agent (`server/src/services/agent.service.ts:1032`), `pending_command` est remis à `null` et `uninstall_commanded_at` est horodaté :

```ts
if (pendingCommand === 'uninstall') {
  commandUpdate.uninstall_commanded_at = new Date();
}
```

Un job de nettoyage périodique, `cleanupUninstalledDevices()` (`server/src/services/agent.service.ts:553`), supprime automatiquement l'entrée `agent_devices` **10 minutes** après l'horodatage `uninstall_commanded_at` — laissant à l'agent le temps d'exécuter son script de désinstallation avant que le serveur n'efface la fiche.

### Réception côté agent

Dans `applyOGConfig()` (`agent/cmd_ws.go:230`), la commande est traitée en priorité, avant tout le reste du traitement de config (bans, rate-limits, templates, auto-update) :

```go
if msg.Command != "" {
    if msg.Command == "uninstall" {
        handleUninstallCommand(cfg)
        return
    }
}
```

`handleUninstallCommand()` (`agent/uninstall.go:21`) dispatche vers une implémentation par plateforme (`runtime.GOOS`), écrit un script détaché, le lance, puis `os.Exit(0)` immédiatement — le script continue à s'exécuter après la mort du process (et de son superviseur de service).

### Nettoyage par plateforme

**Windows** (`handleWindowsUninstall`, `agent/uninstall.go:52`) : télécharge le MSI depuis `/api/agent/download/obliguard-agent.msi`, puis lance un batch qui exécute `msiexec /x <msi> /quiet /norestart` — la désinstallation MSI standard stoppe le service et supprime tous les fichiers installés.

**Linux** (`handleLinuxUninstall`, `agent/uninstall.go:82`) : script shell dans `/tmp/obliguard-uninstall.sh` qui :
- stoppe/désactive le service (`systemctl` ou fallback `service`/init.d),
- supprime l'unité systemd / le script init.d,
- **démonte les objets de rate-limiting du firewall en direct** — nftables (`nft flush/delete chain ratelimit_in/ratelimit_fwd`, set `obliguard_rl_bans`) et iptables (chaîne `OBLIGUARD_RL`, ipset `obliguard_rl_bans`) : ce nettoyage est nécessaire pour ne pas laisser du trafic bloqué après le départ de l'agent,
- supprime `/opt/obliguard-agent/` (le binaire et le répertoire d'installation),
- **préserve** la config sous `/etc/obliguard-agent/`,
- s'auto-supprime (`rm -f "$0"`).

**macOS** (`handleDarwinUninstall`, `agent/uninstall.go:125`) : décharge le daemon launchd (`launchctl unload /Library/LaunchDaemons/com.obliguard.agent.plist`), supprime le plist et le binaire `/usr/local/bin/obliguard-agent`. Config et logs préservés — comportement identique à `obliguard-agent uninstall` en CLI locale.

**FreeBSD** (`handleFreeBSDUninstall`, `agent/uninstall.go:151`) : arrête le service rc.d (`service obliguard_agent stop`), désactive `obliguard_agent_enable` via `sysrc`, flush la table pf `obliguard_blocklist` et l'ancre `obliguard` (`pfctl -a obliguard -F all`), supprime les hooks OPNsense éventuels (`obliguard_reload.sh`, `actions_obliguard.conf`, `obliguard.conf` sous `/usr/local/etc/pf.opnsense.d/`), puis le script rc.d, le binaire, et le fichier PID.

Tous les scripts appliquent un `sleep 2` initial (ou `timeout /t 2` sous Windows) avant d'agir, laissant le temps au process agent de terminer proprement sa sortie et libérer ses handles/ports.

## Poller Windows Event Log (RDP / auth Windows)

Sous Windows, les échecs/succès d'authentification RDP ne passent pas par un fichier de log tail comme sur Linux (`/var/log/auth.log`) : ils sont capturés en interrogeant le journal d'événements Sécurité Windows.

### Démarrage

`startPlatformEventLogWatcher(lw)` (`agent/eventlog_windows.go:22`) est appelé une seule fois depuis `mainLoop` (`agent/main.go:363`). Sur les autres OS, la version stub (`agent/eventlog_stub.go`) ne fait rien — les événements Linux/macOS passent par le `LogWatcher` classique basé fichiers.

### Initialisation du curseur

`initWindowsEventCursor()` récupère le `RecordId` du tout dernier événement 4625/4624 via PowerShell (`Get-WinEvent -FilterHashtable @{LogName='Security';Id=4625,4624} -MaxEvents 1`) et l'enregistre dans `lastWinSecRecordId` (variable atomique `int64`). Objectif : ne remonter que les événements survenus **après** le démarrage de l'agent, pour éviter un déluge d'échecs historiques au premier lancement.

### Boucle de polling

Un ticker de **15 secondes** interroge le journal :

```go
if !lw.IsServiceEnabled("rdp") {
    continue
}
for _, e := range pollWindowsSecurityEvents() {
    lw.addEvent(e)
}
```

Le poll entier est court-circuité tant qu'aucun template RDP actif n'a été poussé par le serveur (`IsServiceEnabled("rdp")`, `agent/logwatcher.go:87`) — évite d'exécuter PowerShell (coûteux) inutilement quand RDP n'est pas surveillé sur cet agent.

### Requête et filtrage (`pollWindowsSecurityEvents`)

Un script PowerShell interroge jusqu'à 500 événements dont le `RecordId` est supérieur au curseur, filtre sur les EventID :

- **4625** — échec de logon (tout type confondu : capture RDP, SMB, logons réseau)
- **4624** — logon réussi, **uniquement type 10** (`RemoteInteractive` = session RDP) ; les autres types (interactif local, service, etc.) sont ignorés côté script

Filtres additionnels appliqués côté PowerShell :
- adresses loopback exclues (`-`, `::1`, `127.0.0.1`)
- comptes machine exclus (`TargetUserName` se terminant par `$`) — trafic domaine normal, pas une tentative d'intrusion

Le script XML-parse chaque événement (`[xml]$e.ToXml()`) pour extraire `IpAddress`, `TargetUserName`, `LogonType`, et retourne des lignes `RecordId|EventID|IP|Username` triées par `RecordId` croissant.

### Conversion en événements agent

Côté Go, chaque ligne est parsée et transformée via `makeEvent(ip, username, "rdp", evType, rawLog)` :
- `4625` → `evType = "auth_failure"`
- `4624` (type 10) → `evType = "auth_success"`
- `rawLog` reconstruit un format lisible : `EventID:<id> Account Name: <user> Source Network Address: <ip>`

Le curseur `lastWinSecRecordId` est mis à jour au `RecordId` maximum observé à chaque cycle, garantissant qu'aucun événement n'est retraité (idempotence du poll) même en cas de redémarrage de l'agent, tant que les événements Windows restent dans la fenêtre de rétention du journal Sécurité.

Ces événements `rdp` alimentent ensuite le même pipeline que les logs fichier classiques : agrégation par IP dans `ip_reputation`, évaluation par le moteur de bannissement (`ban.service.ts`, cycle 30 s) selon le seuil/fenêtre configuré sur le template RDP.
