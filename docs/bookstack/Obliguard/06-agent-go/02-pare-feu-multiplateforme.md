Toute l'application des bans au niveau réseau vit dans `agent/firewall.go` (1376 lignes). Le serveur ne fait que calculer *quelles* IP doivent être bannies (`server/src/services/ban.service.ts`) ; c'est l'agent qui traduit cette liste en règles pare-feu locales, sur chaque OS avec le backend le plus adapté disponible.

## Interface `FirewallManager`

Toutes les implémentations respectent la même interface (`agent/firewall.go:18-39`) :

```go
type FirewallManager interface {
    BanIP(ip string) error
    UnbanIP(ip string) error
    GetBannedIPs() ([]string, error)
    Flush() error
    IsAvailable() bool
    Name() string
    IsRateLimitSupported() bool
    ApplyRateLimits(rules []RateLimitRule) error
}
```

`BanIP`/`UnbanIP` sont en général non bloquants (ils empilent dans `pendingAdd`/`pendingDel`) ; `Flush()` committe le lot en une seule fois pour minimiser les appels système — important quand une synchronisation delta touche des centaines d'IP d'un coup.

## Détection automatique — `DetectFirewall()`

`DetectFirewall()` (`agent/firewall.go:47-88`) sonde les backends disponibles selon l'OS (`runtime.GOOS`) et retourne le premier qui répond `IsAvailable() == true` :

| OS | Ordre de priorité |
|---|---|
| Linux | `nftables` → `firewalld` → `ufw` → `iptables` |
| Windows | Windows Defender Firewall (`netsh`) |
| macOS | `pf` |
| FreeBSD | `pf` (variante OPNsense-friendly) |

Si aucun backend n'est disponible, l'agent retombe sur `NoOpFirewall` (`agent/firewall.go:1331-1338`) : les bans sont toujours détectés et remontés au serveur, mais rien n'est appliqué localement — l'agent log un avertissement (`"bans will not be enforced locally"`).

## Linux

### nftables (priorité 1)

Stratégie déclarative à base de **set** (`agent/firewall.go:90-193`) : une table `inet obliguard`, un set `obliguard_ips` (type `ipv4_addr`), et deux chaînes hookées en priorité `-10` :

- `blocklist` (hook `input`) : `ip saddr @obliguard_ips drop`
- `blocklist_out` (hook `output`) : `ip daddr @obliguard_ips drop`

Résultat : **2 règles fixes**, quel que soit le nombre d'IP bannies — le ban/unban n'est qu'un ajout/retrait dans le set. `Flush()` (`agent/firewall.go:150-177`) fait un `add element` / `delete element` en lot (`{ ip1, ip2, ip3 }`), avec repli en un-par-un si le lot échoue.

nftables gère aussi le **rate limiting** par IP (`ApplyRateLimits`, `agent/firewall.go:215-326`) : deux chaînes séparées (`ratelimit_in`, `ratelimit_fwd`, priorité `-15`, donc évaluées avant les chaînes de ban) avec des meters `ct count`/`limit rate` pour les types `connection`/`rate`/`volume`, plus un set `obliguard_rl_bans` à *timeout* pour l'escalade (bannissement temporaire si un seuil × `banMultiplier` est dépassé). Ce set est volontairement exclu de `GetBannedIPs()` pour ne jamais entrer en conflit avec la synchronisation delta pilotée par le serveur (voir plus bas).

### firewalld (priorité 2)

Utilise un **ipset firewalld** natif (`agent/firewall.go:328-489`) : création de l'ipset `obliguard` (`--new-ipset=obliguard --type=hash:ip`), puis deux rich-rules qui le référencent (`source ipset=obliguard drop` / `destination ipset=obliguard drop`). `init()` migre aussi automatiquement les anciennes rich-rules individuelles (`migrateLegacyRichRules`) vers l'ipset. Le rate limiting n'est **pas** supporté sur ce backend (`IsRateLimitSupported() → false`, `agent/firewall.go:1350-1351`) : les rich-rules ne peuvent pas exprimer un `connlimit` par source, et les règles iptables brutes seraient effacées à chaque `firewall-cmd --reload`.

### UFW (priorité 3)

UFW ne supporte pas nativement les ipsets. Si `ipset` est disponible sur le système, l'agent le contourne : création d'un ipset `obliguard`, injection directe de règles `iptables -I INPUT/OUTPUT -m set --match-set obliguard ...` (`agent/firewall.go:491-582`), avec migration des anciennes règles `ufw deny from X` vers l'ipset (`migrateLegacyUfwRules`). Sans `ipset`, repli sur des règles `ufw insert 1 deny from/to` individuelles — lent au-delà de quelques milliers d'IP. Le rate limiting réutilise le chemin iptables partagé (`applyIptablesRateLimits`).

### iptables (dernier recours)

Même logique ipset-first que UFW (`agent/firewall.go:660-948`) : chaînes dédiées `OBLIGUARD`/`OBLIGUARD_OUT` hookées en tête d'`INPUT`/`OUTPUT`, matchant un ipset `obliguard` si disponible, sinon des règles par IP. Le rate limiting (`applyIptablesRateLimits`) installe une chaîne `OBLIGUARD_RL` hookée sur `INPUT` + soit `DOCKER-USER` (si Docker est présent) soit `FORWARD` — jamais les deux, pour ne pas compter un paquet deux fois. `connlimit` pour les limites de connexions concurrentes, `hashlimit` (mode `srcip`) pour les limites de débit ; l'escalade vers un ban temporaire utilise la cible `SET --add-set obliguard_rl_bans src --timeout N`.

## Windows — règles groupées `netsh`

Stratégie radicalement différente de Linux : Windows Firewall n'a pas d'équivalent d'un ipset natif utilisable ici, donc l'agent regroupe les IP en **listes `remoteip` séparées par des virgules** dans un nombre minimal de règles (`WindowsFirewall`, `agent/firewall.go:950-1226`).

- Deux règles de base : `Obliguard-Block-in` (dir=in, action=block) et `Obliguard-Block-out` (dir=out, action=block).
- **Limite de 500 IP par règle** (`maxIPsPerRule`, `agent/firewall.go:1087`) — netsh peut échouer silencieusement avec des listes `remoteip` trop longues. Au-delà, l'agent découpe en règles numérotées `Obliguard-Block-in-1`, `-2`, `-3`… (`Obliguard-Block-N`), chacune couvrant jusqu'à 500 IP.
- Fichier `obliguard-banlist.txt` (à côté du binaire de l'agent, `banlistPath()`) : **source de vérité persistante**. À chaque `Flush()`, l'état complet du cache est réécrit dans ce fichier *avant* d'appeler `netsh`, ce qui permet de survivre à un crash ou redémarrage sans perdre la liste des bans en attente de ré-application.
- `loadCache()` relit ce fichier au démarrage, puis importe aussi les éventuelles anciennes règles per-IP (`getLegacyIPs()`, format `Obliguard-Block-A-B-C-D-*`) issues de versions antérieures de l'agent — elles sont fusionnées dans le cache puis nettoyées (`cleanupLegacyRules()`) au premier `Flush()`.
- `syncRules()` ne réémet que les chunks dont le contenu a changé (comparaison de `appliedChunks[i]` avec la liste jointe), et supprime les chunks numérotés devenus superflus si le nombre d'IP bannies diminue.
- Le rate limiting Windows (WinDivert) vit dans des fichiers séparés : `firewall_ratelimit_windows.go` (implémentation réelle) et `firewall_ratelimit_other.go` (no-op sur les autres OS).

## macOS et FreeBSD — `pf`

Deux implémentations quasi symétriques basées sur des **tables pf** (`agent/firewall.go:1228-1327`) :

- **macOS** (`PFFirewall`) : table `obliguard_blocklist`, ban/unban via `pfctl -t obliguard_blocklist -T add/delete <ip>`. `Flush()` est un no-op — chaque opération pf est déjà atomique en soi.
- **FreeBSD** (`FreeBSDPFFirewall`, pensé pour être compatible OPNsense) : même table, mais avec `ensureTable()` qui initialise un ancre `obliguard` via `pfctl -a obliguard -f -` si la table n'existe pas encore, injectant `table <obliguard_blocklist> persist` + `block in/out quick from/to <obliguard_blocklist>`. `IsAvailable()` vérifie en plus que `pf` est réellement activé (`pfctl -si` contient `Status: Enabled`).

Le rate limiting n'est implémenté sur aucune des deux plateformes (`IsRateLimitSupported() → false`) — nécessiterait une ancre pf dédiée (`keep-state max-src-conn` / `dummynet`).

## Report de l'état pare-feu pour la synchronisation delta

À chaque cycle (heartbeat WS via `agent/cmd_ws.go`, ou push HTTP legacy via `agent/push.go`), l'agent interroge son backend actif :

```go
banned, _ := fw.GetBannedIPs()
```

et remonte ce résultat au serveur dans le champ `firewallBanned []string` du payload (`agent/cmd_ws.go:43`, `agent/push.go:35`), accompagné de `firewallName` (identifiant du backend actif, ex. `"nftables"`, `"windows"`, `"macos_pf"`).

Côté serveur, `banService.computeBanDelta()` (`server/src/services/ban.service.ts:229-273`) compare :

1. l'ensemble des bans actifs applicables à cet agent (`ip_bans` avec scope `global`/`tenant`/`group`/`agent`, en excluant les `ip_ban_exclusions` du tenant et les IP whitelistées),
2. contre `agentCurrentBans` (= le `firewallBanned[]` reçu de l'agent),

et retourne un delta `{ add: string[], remove: string[] }` — uniquement les IP à ajouter ou retirer, jamais l'état complet. Ce delta est renvoyé à l'agent dans la réponse de configuration (`banList.add[]` / `banList.remove[]`), qui appelle alors `BanIP`/`UnbanIP` puis `Flush()`. Ce mécanisme rend la synchronisation idempotente et tolérante aux pertes de connexion : même si l'agent a raté plusieurs cycles, le prochain report de `firewallBanned[]` permet au serveur de recalculer l'écart exact.

Note : les IP bannies par l'escalade de rate limiting (sets `obliguard_rl_bans` / `obliguard_rl_bans` nftables/iptables) sont **volontairement exclues** de `GetBannedIPs()` sur ces backends, pour que le serveur ne tente pas de les « débannir » lors du calcul du delta — elles expirent d'elles-mêmes via leur propre TTL.

## Report des IP LAN pour les peer links NetMap

`getLanIPs()` (`agent/netinfo.go`) énumère toutes les interfaces réseau actives (non loopback, `FlagUp`) et retient les adresses IPv4 privées RFC-1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), en excluant loopback et link-local (`169.254.x.x`). Cette liste est envoyée dans le champ `lanIPs []string` du payload de push/heartbeat.

Côté serveur (`server/src/services/agent.service.ts`), à chaque push, la table `agent_ips` (IP → agent_id, par tenant) est **entièrement reconstruite** pour l'agent concerné : suppression puis réinsertion des IP dédupliquées (`[...new Set(body.lanIPs)]`), avec `onConflict.ignore()` pour rester safe en cas de push concurrent (HTTP legacy + heartbeat WS simultanés). Cette table permet au serveur de détecter que deux agents partagent le même réseau local sans dépendre de la résolution de hostname (peu fiable entre tenants/VLAN différents), et d'afficher les **peer links** correspondants sur la NetMap (`client/src/netmap/` et `client/src/netmap3d/`).
