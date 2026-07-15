En plus du blocage automatique des IP attaquantes (géré par `FirewallManager`, voir la page dédiée à l'exécution des bans), l'agent expose une deuxième API de gestion du pare-feu : la lecture et l'édition des règles **système** existantes (celles créées manuellement par l'admin ou par d'autres logiciels). Cette fonctionnalité alimente l'onglet "Règles pare-feu" de `AgentDetailPage.tsx`.

Le code vit dans `agent/firewall_rules.go` (interface commune) et ses implémentations par plateforme `agent/firewall_rules_windows.go` et `agent/firewall_rules_linux.go`.

## Interface `FirewallRuleManager`

```go
type FirewallRuleManager interface {
    ListRules() ([]FwRule, error)
    AddRule(req FwAddRequest) error
    DeleteRule(ruleID string) error
    ToggleRule(ruleID string, enabled bool) error
    PlatformName() string
}
```

Chaque règle est normalisée dans une structure unique `FwRule` (`agent/firewall_rules.go:16-27`), indépendamment du backend natif :

| Champ | Valeurs | Rôle |
|---|---|---|
| `ID` | format spécifique au backend | identifiant utilisé pour delete/toggle |
| `Direction` | `in`, `out`, `both` | sens du trafic |
| `Action` | `allow`, `block` | effet de la règle |
| `Protocol` | `tcp`, `udp`, `any`, `icmp` | protocole |
| `LocalPort` | `"80"`, `"80,443"`, `"any"` | port(s) local/locaux |
| `RemoteIP` | IP/CIDR ou `"any"` | source distante filtrée |
| `Source` | `system` ou `obliguard` | origine de la règle |

Le champ `Source` sert à distinguer les règles créées manuellement (`system`) des règles gérées par Obliguard (`obliguard`), pour éviter que l'UI ne permette de modifier par erreur une règle de ban automatique.

La sélection de l'implémentation se fait via une variable globale `platformRuleManager`, positionnée par le `init()` du fichier `firewall_rules_<os>.go` compilé (build tags `//go:build windows` / `//go:build linux`). `DetectFirewallRuleManager()` retourne cette instance, ou un `NoOpRuleManager` (toutes méthodes renvoient `"unsupported platform"`) si aucune n'a été enregistrée — cas des plateformes sans implémentation dédiée à ce jour (macOS/FreeBSD ne gèrent que le parsing pf en lecture via `parsePfRules`, partagé entre darwin et freebsd, sans add/delete/toggle).

## Commandes WebSocket

Les 4 commandes sont dispatchées depuis `handleOGServerFrame` dans `agent/cmd_ws.go:221-225` :

```go
case "firewall_list", "firewall_add", "firewall_delete", "firewall_toggle":
    frm := DetectFirewallRuleManager()
    go handleFirewallCommand(frm, env.Type, env.ID, payload, func(data []byte) {
        ws.SendText(data)
    })
```

`handleFirewallCommand` (`agent/firewall_rules.go:77`) est le point d'entrée commun : il désenveloppe le champ `payload` du message WS, route vers la bonne méthode de l'interface, puis construit une `FwResponse` renvoyée sur le canal WS :

```go
type FwResponse struct {
    Type     string   `json:"type"` // "firewall_response"
    ID       string   `json:"id"`   // correlation ID
    Success  bool     `json:"success"`
    Error    string   `json:"error,omitempty"`
    Rules    []FwRule `json:"rules,omitempty"`
    Platform string   `json:"platform,omitempty"`
}
```

Après un `add`, `delete` ou `toggle` réussi, l'agent rappelle systématiquement `ListRules()` et renvoie la liste à jour dans `resp.Rules`, évitant un aller-retour supplémentaire côté serveur.

Côté serveur, `server/src/controllers/firewall.controller.ts` envoie ces commandes via `obliguardHub.pushAndWait(uuid, { type, id, payload })` (mécanisme request-response par ID de corrélation, timeout 30s décrit dans `obliguardHub.service.ts`) et les expose sur :

| Route | Contrôleur | Commande WS |
|---|---|---|
| `GET /agent/devices/:id/firewall/rules` | `getFirewallRules` | `firewall_list` |
| `POST /agent/devices/:id/firewall/rules` | `addFirewallRule` | `firewall_add` |
| `DELETE /agent/devices/:id/firewall/rules/:ruleId` | `deleteFirewallRule` | `firewall_delete` |
| `PATCH /agent/devices/:id/firewall/rules/:ruleId` | `toggleFirewallRule` | `firewall_toggle` |

Ces 4 routes sont déclarées dans `server/src/routes/agent.routes.ts:107-111`, protégées par `requireAuth`, `requireRole('admin')` et `requireTenant`. Si l'agent n'est pas connecté, `pushAndWait` lève une erreur contenant `"not connected"`, traduite en HTTP 503.

## Windows : parseur `netsh` multi-locale

`WindowsRuleManager` (`agent/firewall_rules_windows.go`) pilote le pare-feu Windows Defender via `netsh advfirewall firewall`.

- **Liste** : `netsh advfirewall firewall show rule name=all verbose`. La sortie est découpée en blocs par `splitNetshBlocks` (séparateur = ligne vide, les lignes `---` sont ignorées), puis chaque bloc est parsé par `parseNetshVerbose`. Les règles `Obliguard-Block-*` (règles de ban en masse, gérées par `firewall.go`) sont filtrées de la liste pour ne montrer que les règles "custom" pertinentes.
- **Ajout** : `netsh advfirewall firewall add rule name=... dir=... action=... protocol=... localport=... remoteip=...`. Si aucun nom n'est fourni, un nom est généré : `Obliguard-Custom-<direction>-<protocol>-<port>`.
- **Suppression / activation** : l'`ID` composite `RuleName::in` ou `RuleName::out` (généré au parsing) est décomposé par `parseRuleID` pour reconstruire les arguments `name=` et `dir=` de `netsh delete rule` / `netsh set rule ... new enable=yes|no`.

Le point notable est la **gestion locale-indépendante** des labels retournés par `netsh` : la sortie verbose change de langue selon la locale Windows de l'agent (français, allemand, espagnol...). Plutôt que de parser un format figé, `parseNetshVerbose` matche les clés de champ par sous-chaînes via une série de fonctions `isFieldXxx` :

```go
func isFieldDir(k string) bool {
    return strings.Contains(k, "direction") || strings.Contains(k, "richtung") || strings.Contains(k, "dirección")
}
func isFieldAction(k string) bool {
    return strings.Contains(k, "action") || strings.Contains(k, "aktion") || strings.Contains(k, "acción")
}
```

Pour les *valeurs* en français, la reconnaissance couvre notamment :

- Direction : `Actif` (entrant), `Sortie` (sortant) — en plus de `In`/`Out`, `Eingehend`/`Ausgehend`, `Entrante`
- Action : `Bloquer` → `block`, sinon → `allow`
- Activé : `Oui` → `true`
- Valeurs "tout"/"quelconque" (protocole ou IP distante non filtrés) sont normalisées vers `"any"` (`tout`, `alle`, `todos`, `quelconque`)

Cette approche évite de dépendre de la locale exacte du serveur Windows, contrainte réelle rencontrée en prod multi-langue (18 langues supportées côté UI, cf. `CLAUDE.md`).

## Linux : 4 backends avec détection automatique

`agent/firewall_rules_linux.go` détecte le pare-feu actif au démarrage via `detectLinuxRuleManager()`, dans cet ordre de priorité :

1. **nftables** (`NftRuleManager`) — si le binaire `nft` est présent (`exec.LookPath("nft")`)
2. **firewalld** (`FirewalldRuleManager`) — si `firewall-cmd --state` retourne `running`
3. **ufw** (`UfwRuleManager`) — si `ufw status` contient `Status: active`
4. **iptables** (`IptablesRuleManager`) — si le binaire `iptables` est présent
5. `NoOpRuleManager` si rien de tout ça n'est disponible

Cette hiérarchie reflète l'ordre de préférence utilisé aussi par `firewall.go` pour l'enforcement des bans (nftables > firewalld > ufw > iptables), garantissant que l'agent gère les règles custom avec le même backend que celui utilisé pour les bans automatiques.

Particularités par backend :

- **nftables** : `nft -a list ruleset` avec l'option `-a` pour obtenir les `handle` numériques indispensables à la suppression ciblée. L'ID de règle est composite : `family:table:chain:handle` (ex. `inet:filter:input:42`). L'ajout tente d'abord la famille `inet`, puis retombe sur `ip` en cas d'échec. `ToggleRule` n'est **pas supporté** (nftables n'a pas de notion d'activer/désactiver une règle unitaire) — retourne une erreur explicite.
- **firewalld** : distingue les ports simples (`firewall-cmd --list-ports`, ID `port:<port/proto>`) des rich rules (`firewall-cmd --list-rich-rules`, ID `rich:<index>`). L'ajout d'un port utilise `--add-port` en permanent ; toute règle avec IP source ou action `block` passe par une rich rule (`--add-rich-rule`), suivie d'un `--reload`. La suppression d'une rich rule par index n'est **pas implémentée** (erreur retournée invitant à une action manuelle), seule la suppression de port est supportée. `ToggleRule` non supporté.
- **ufw** : `ufw status numbered` parsé ligne à ligne (format `[ 1] 80/tcp ALLOW IN Anywhere`), l'ID est `ufw:<numéro>`. Suppression via `ufw --force delete <numéro>`. `ToggleRule` non supporté.
- **iptables** : parcourt les chaînes `INPUT` et `OUTPUT` via `iptables -L <chain> -n --line-numbers`, ID `ipt:<chain>:<numéro de ligne>`. Détecte les règles Obliguard via la présence de `OBLIGUARD`/`obliguard` dans la ligne. Suppression via `iptables -D <chain> <numéro>`. `ToggleRule` non supporté.

Sur les 4 backends Linux, **seul nftables tolère bien les suppressions concurrentes** grâce aux handles stables ; pour ufw/iptables, la suppression par numéro de ligne est sensible aux races si une autre règle est ajoutée/supprimée entre le `list` et le `delete` affiché côté UI — l'agent re-liste après chaque opération pour limiter ce risque côté client, mais l'action elle-même n'est pas atomique côté OS.

## macOS / FreeBSD

Ces plateformes ne disposent pas de fichier `firewall_rules_darwin.go` / `firewall_rules_freebsd.go` dédié à la gestion CRUD : seul un parseur de lecture `parsePfRules` (`agent/firewall_rules.go:157-205`), partagé entre les deux OS via build tags, transforme la sortie de `pf` (règles `block`/`pass`, direction `in`/`out`, `proto tcp|udp`, port, IP) en `FwRule`. Sans `init()` positionnant `platformRuleManager`, ces plateformes retombent sur `NoOpRuleManager` pour les commandes `firewall_list/add/delete/toggle` tant qu'aucune implémentation pf complète (`AddRule`/`DeleteRule`/`ToggleRule`) n'est ajoutée.
