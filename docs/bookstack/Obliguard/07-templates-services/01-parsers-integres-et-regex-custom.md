Les templates de services définissent **quoi surveiller** (chemin de log ou source), **comment détecter un échec d'authentification** (parseur intégré ou regex personnalisée), et **le seuil de déclenchement** (nombre d'échecs / fenêtre de temps). La logique serveur vit dans `server/src/services/serviceTemplate.service.ts` ; le parsing effectif des lignes de log s'exécute côté agent dans `agent/logwatcher.go`.

### Modèle de données

Deux tables (migration `server/src/db/migrations/001_obliguard_schema.ts`, section 10) :

- **`service_templates`** — définition du parseur : `name`, `service_type`, `is_builtin`, `default_log_path`, `custom_regex`, `threshold`, `window_seconds`, `enabled`, `mode` (`ban`/`track`), `tenant_id` (`NULL` = template plateforme, sinon template tenant), `owner_scope`/`owner_scope_id` (template local rattaché à un agent ou un groupe).
- **`service_template_assignments`** — liaison template ↔ groupe/agent avec surcharges optionnelles : `log_path_override`, `threshold_override`, `window_seconds_override`, `enabled_override`, `sample_requested` (booléen : demande d'échantillon de log au prochain push). Contrainte unique `['template_id', 'scope', 'scope_id']`.

Le champ `custom_regex` porte la doc inline suivante dans la migration :

```
// Named groups: (?P<ip>...) (?P<username>...)
// NULL for built-in templates (agent handles parsing internally)
```

8 templates intégrés sont insérés au seed de la migration 001 :

| name | service_type | threshold | window_seconds |
|---|---|---|---|
| SSH | `ssh` | 5 | 300 |
| RDP | `rdp` | 3 | 300 |
| Nginx | `nginx` | 20 | 60 |
| Apache | `apache` | 20 | 60 |
| IIS | `iis` | 20 | 60 |
| FTP | `ftp` | 5 | 300 |
| Mail (SMTP/IMAP) | `mail` | 5 | 300 |
| MySQL | `mysql` | 5 | 300 |

(La migration 016 `016_opnsense_templates.ts` ajoute par ailleurs `opnsense` et `opnsense_filter` pour l'intégration OPNsense/pfSense — voir la page dédiée MikroTik/OPNsense.)

### Parseurs intégrés (agent Go)

Pour les templates `is_builtin = true`, `custom_regex` reste `NULL` : le parsing n'est **pas** piloté par une regex venant du serveur, il est câblé en dur dans le binaire agent. `NewLogWatcher()` (`agent/logwatcher.go`) enregistre une map `serviceType → LogParser` :

```go
lw.parsers = map[string]LogParser{
    "ssh":             &SSHParser{},
    "rdp":             &RDPParser{},
    "nginx":           &NginxParser{},
    "apache":          &ApacheParser{},
    "iis":             &IISParser{},
    "ftp":             &FTPParser{},
    "mail":            &MailParser{},
    "mysql":           &MySQLParser{},
    "opnsense":        &OPNsenseParser{},
    "opnsense_filter": &OPNsenseFilterParser{},
}
```

Chaque parseur implémente l'interface `LogParser { Parse(line, svcKey string) []AgentIpEvent }`. Extraits des regex effectivement utilisées :

- **SSH** (`sshFailRe`) : `Failed (password|publickey) for (invalid user )?(\S+) from (\d+\.\d+\.\d+\.\d+|[0-9a-f:]+)` — capture IPv4 et IPv6, avec ou sans « invalid user ». Un second motif (`sshAcceptRe`) capture les connexions réussies.
- **RDP** : `EventID:4625.*?Account Name:\s+(\S+).*?Source Network Address:\s+([\d.]+)` — les lignes RDP sont en réalité pré-formatées par le poller Windows Event Log (EventID 4625 = échec) avant d'atteindre ce parseur.
- **Nginx / Apache** (`http401Re`, fonction commune `parseHTTPAuthLine`) : `^(\d+\.\d+\.\d+\.\d+|[0-9a-f:]+) .* " [^"]*" 401 ` — recherche des lignes de log d'accès avec un statut HTTP 401.
- **IIS** (`iis401Re`) : parseur au format W3C extended log, capture `c-ip` suivi d'un `sc-status` 401.
- **FTP** : `FAIL LOGIN: Client "([\d.]+)"` (Pure-FTPd), avec repli sur une détection générique `FAILED LOGIN` / `authentication failure` (vsftpd/proftpd) suivie d'une extraction IP brute.
- **Mail** : deux motifs distincts — `auth failed .* rip=([\d.]+)` (Dovecot) et `SASL .* authentication failed.* \[([\d.]+)\]` (Postfix).
- **MySQL** (`mysqlFailRe`) : `Access denied for user '([^']+)'@'([\d.]+)'` — capture à la fois le nom d'utilisateur et l'IP.

Tous les parseurs produisent un `AgentIpEvent` via le helper `makeEvent(ip, username, service, eventType, rawLog)`, avec `eventType` = `auth_failure` ou `auth_success`.

### Regex personnalisées (templates custom)

Quand un template n'est pas `is_builtin`, l'agent instancie un `CustomRegexParser{Regex: cfg.CustomRegex, ServiceKey: svcKey}` (sélection faite dans `getParser()`) :

```go
func (lw *LogWatcher) getParser(svcKey string, customRegex *string) LogParser {
    if customRegex != nil && *customRegex != "" {
        return &CustomRegexParser{Regex: *customRegex, ServiceKey: svcKey}
    }
    if p, ok := lw.parsers[svcKey]; ok {
        return p
    }
    return nil
}
```

`CustomRegexParser.Parse()` compile la regex Go (syntaxe RE2, mise en cache dans `compiled` après la première ligne) puis extrait les groupes nommés via `SubexpNames()` :

```go
for i, name := range names {
    if i == 0 || i >= len(m) {
        continue
    }
    switch name {
    case "ip":
        ip = m[i]
    case "username":
        username = m[i]
    }
}
if ip == "" {
    return nil
}
```

Seuls les groupes nommés `(?P<ip>...)` et `(?P<username>...)` sont reconnus — `ip` est obligatoire (sans lui, la ligne est ignorée), `username` est optionnel. L'événement généré est toujours de type `auth_failure`. Côté serveur, `update()` empêche de définir `custom_regex` sur un template `is_builtin` (`Cannot set custom regex on a built-in template`).

### Résolution du chemin de log

`resolveLogPath()` (`agent/logwatcher.go`) distingue deux cas :

- Clé de service préfixée `custom:` → le chemin est extrait directement de la clé (`custom:/chemin/vers/fichier.log`).
- Sinon → `defaultLogPath(svcKey)` (`agent/logpaths.go`), qui dispatch par OS (`defaultLogPathLinux`, `defaultLogPathDarwin`, `defaultLogPathWindows`, `defaultLogPathFreeBSD`). Exemples Linux : SSH essaie `/var/log/auth.log` puis `/var/log/secure`, puis bascule sur `journald:ssh.service` ou `journald:sshd.service` si aucun fichier n'existe (systèmes purement journald, ex. Ubuntu 20.04+/Debian 9+ sans rsyslog). Windows n'a de chemin par défaut que pour `iis` et `mysql` — SSH/RDP passent par le lecteur d'Event Log dédié, pas par le tailer de fichier.

Trois modes de lecture sont supportés selon le préfixe du chemin résolu : fichier plat (`tailFile`, poll 1s avec suivi d'offset et détection de rotation), `journald:UNIT` (`tailJournald`, via `journalctl -fu`), et `clog:FICHIER` (`tailClog`, logs circulaires BSD/OPNsense via l'utilitaire `clog -f`).

### Résolution hiérarchique (agent > groupe > template)

`serviceTemplateService.resolveForAgent(deviceId, groupIds)` calcule la configuration effective envoyée à un agent donné :

1. Récupère **tous** les templates globaux (`owner_scope IS NULL`) — modèle opt-out : chaque template global s'applique par défaut, sauf `enabled_override=false` explicite.
2. Récupère les templates possédés par le groupe direct de l'agent (`owner_scope = 'group'`).
3. Résout, pour chaque template, la priorité `assignment agent > assignment groupe le plus proche > valeur par défaut du template`, champ par champ (`log_path_override`, `threshold_override`, `window_seconds_override`, `enabled_override`).
4. Trie le résultat (activés en premier, puis alphabétique) et renvoie un tableau de `ResolvedServiceConfig`.

`getResolvedForDevice(deviceId)` remonte l'ascendance de groupes via `group_closure` (triée par `depth`) avant de déléguer à `resolveForAgent`. `getResolvedForGroup(groupId)` fait la même résolution mais sans tenir compte des surcharges au niveau agent — utile pour afficher l'état effectif au niveau d'un groupe dans l'UI.

### Échantillon de log (`sample_requested`)

`requestLogSample(templateId, deviceId)` positionne `sample_requested = true` sur l'assignment agent (le crée si absent). L'agent lit ce flag dans sa config (`cfg.SampleRequested`) et déclenche `collectSample`/`collectJournaldSample`/`collectClogSample` selon le type de source, qui renvoie les 50 dernières lignes au prochain push — utile pour valider une regex personnalisée sans accès SSH direct à la machine.

### Routes API (`server/src/routes/serviceTemplates.routes.ts`)

| Méthode | Route | Rôle requis |
|---|---|---|
| GET | `/service-templates` | authentifié |
| GET | `/service-templates/:id` | authentifié |
| GET | `/service-templates/local/:scope/:scopeId` | authentifié |
| GET | `/service-templates/resolved/group/:groupId` | authentifié |
| POST | `/service-templates` | admin |
| PUT | `/service-templates/:id` | admin |
| DELETE | `/service-templates/:id` | admin |
| PUT | `/service-templates/:id/assign/:scope/:scopeId` | admin |
| DELETE | `/service-templates/:id/assign/:scope/:scopeId` | admin |
| POST | `/service-templates/:id/sample/:deviceId` | admin |

### Mode `ban` vs `track`

Le champ `mode` (`ServiceTemplateMode`) détermine le comportement du moteur de ban (`server/src/services/ban.service.ts`) une fois le seuil dépassé : `ban` déclenche un bannissement automatique (`auto`), `track` se contente de journaliser les événements dans `ip_events` sans créer de ban — utile pour observer un nouveau service avant activation réelle.
