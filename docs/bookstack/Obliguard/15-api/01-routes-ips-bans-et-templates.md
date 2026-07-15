Toutes les routes ci-dessous sont montées sous le préfixe `/api` (voir `server/src/routes/index.ts`) et passent par le `tenantRouter` : `requireAuth` (session valide) + `requireTenant` (résolution du tenant courant) sont donc appliqués systématiquement, en plus des middlewares indiqués route par route. Le rôle `admin` est vérifié via `requireRole('admin')` (`server/src/middleware/rbac.ts`).

Le filtrage multi-tenant est géré au niveau service : les tenants ne voient que les enregistrements `scope='global'` + ceux de leur propre `tenant_id` (sauf pour le tenant maître, voir `isMasterTenant()` dans `shared/src/types.ts`). Les admins plateforme voient tout.

## /bans

Contrôleur : `server/src/controllers/bans.controller.ts` — Route : `server/src/routes/bans.routes.ts`
Logique métier : `server/src/services/ban.service.ts` (cycle d'évaluation 30s, création/levée, promotion globale, exclusions par tenant).

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/bans/stats` | auth | Compte `active` (bans actifs non expirés) et `today` (bans du jour), filtré par tenant sauf admin. |
| POST | `/api/bans/wipe-bans` | admin | Passe tous les bans actifs à `is_active=false` (pas de suppression physique) pour que les agents reçoivent le delta "remove". |
| POST | `/api/bans/wipe-reputation` | admin | Supprime tout `ip_events` et `ip_reputation` (reset complet de l'intelligence IP). |
| POST | `/api/bans/bulk-ban` | admin | Body `{ ips: string[] }`. Crée un ban `manual`/`global` par IP absente des bans actifs ; retourne `{ created }`. |
| POST | `/api/bans/bulk-whitelist` | admin | Body `{ ips: string[], label?: string }`. Insère dans `ip_whitelist` (scope `global`, `tenant_id` courant) les IP absentes ; retourne `{ created }`. |
| GET | `/api/bans` | auth | Query : `active` (`true`/`false`), `search`, `page` (déf. 1), `pageSize` (déf. 25). Retourne `{ data, total }` via `banService.list()`. |
| GET | `/api/bans/:id` | auth | Détail d'un ban (`ip_bans`), résout `bannedByUsername` si ban manuel. 404 si absent. |
| POST | `/api/bans` | admin | Body `CreateBanRequest` (`shared/src/types.ts`) : `ip` (obligatoire), `cidrPrefix?`, `reason?`, `banType?` (`auto`\|`manual`), `scope?` (`global`\|`tenant`\|`group`\|`agent`), `scopeId?`, `expiresAt?`. 409 si l'IP est déjà bannie (`This IP is already banned`). |
| DELETE | `/api/bans/:id` | admin | Lève le ban (`banService.lift`). |
| POST | `/api/bans/:id/promote-global` | admin | Promeut un ban tenant/agent/group en ban `global` (`banService.promoteToGlobal`). 404 si introuvable. |
| POST | `/api/bans/:id/exclude` | admin | Crée une exclusion pour le tenant courant : ses agents n'appliqueront pas ce ban global (`ip_ban_exclusions`). |
| DELETE | `/api/bans/:id/exclude` | admin | Supprime l'exclusion tenant (le ban redevient appliqué). |

Notes d'implémentation : les routes `/stats`, `/wipe-*`, `/bulk-*` sont déclarées **avant** `/:id` dans `bans.routes.ts` pour éviter que `/:id` (paramètre numérique) ne les intercepte — commentaire explicite dans le fichier (`⚠️ /stats et /wipe-* must be before /:id`).

## /whitelist

Contrôleur : `server/src/controllers/whitelist.controller.ts` — Service : `server/src/services/whitelist.service.ts`.
Support CIDR (`CreateWhitelistRequest.ip` peut être une IP unique ou un préfixe), même hiérarchie de scoping que les bans (`global`/`tenant`/`group`/`agent`).

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/whitelist` | auth | Query : `scope` (`global`\|`tenant`\|`group`\|`agent`), `scopeId` (numérique, optionnel). |
| POST | `/api/whitelist` | admin | Body `CreateWhitelistRequest` : `ip` (obligatoire, CIDR accepté), `label?`, `scope?`, `scopeId?`. 201 en cas de succès. |
| DELETE | `/api/whitelist/:id` | admin | Supprime l'entrée de whitelist par id. |

Le pré-check de whitelist (avant tout ban auto) est effectué dans `ban.service.ts` avant la création d'un ban.

## /ip-events

Contrôleur : `server/src/controllers/ipEvents.controller.ts`. Interroge la table `ip_events` (jointe à `agent_devices` pour le `hostname`).

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/ip-events` | auth | Query : `ip` (recherche `ILIKE` partielle), `service`, `eventType` (`auth_failure`\|`auth_success`\|`port_scan`), `deviceId`, `from`, `to` (bornes ISO sur `timestamp`), `page` (déf. 1), `pageSize` (déf. 50). Retourne `{ data, total, page, pageSize }`, triés par `timestamp desc`. Filtré par `tenant_id` sauf tenant maître. |
| GET | `/api/ip-events/:ip` | auth | Les 200 derniers événements pour une IP exacte (`e.ip::text = ip`), triés `timestamp desc`. |

Le paramètre `:ip` peut contenir des points (`1.2.3.4`) : Express le route correctement car `/:ip` est déclaré après `/` sans conflit de segments.

## /ip-reputation

Contrôleur : `server/src/controllers/ipReputation.controller.ts` — Service : `server/src/services/ipReputation.service.ts`.
Agrège par IP : compteurs succès/échec, agents affectés, services ciblés, noms d'utilisateur tentés, GeoIP (pays/ville/ASN), statut (`clean` → `suspicious` → `banned`, type `IpStatus`).

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/ip-reputation` | auth | Query : `status` (`IpStatus`), `search`, `limit` (déf. 50), `offset` (déf. 0). |
| POST | `/api/ip-reputation` | admin | Body `AddIpReputationRequest` : `ip`, `status` (`banned`\|`whitelisted`\|`suspicious`\|`clean`), `label?` (si `whitelisted`), `reason?` (si `banned`), `scope?`, `scopeId?`, `expiresAt?` (si `banned`). Entrées tenant nécessitent un admin tenant ; entrées globales nécessitent un admin plateforme. |
| POST | `/api/ip-reputation/:ip/clear` | admin | Efface le statut "suspicious" pour le tenant appelant (ou globalement pour un admin) — insertion soft-delete dans `ip_reputation_clears`, snapshot de `total_failures` comme nouvelle baseline. Déclarée **avant** le `GET /:ip` pour éviter un conflit de route. |
| GET | `/api/ip-reputation/:ip` | auth | Détail complet d'une IP (`ip` décodé via `decodeURIComponent`). |

Le statut `suspicious` réapparaît si de nouveaux échecs surviennent après un `clear` — c'est un effacement par tenant, pas une remise à zéro globale des compteurs.

## /ip-labels

Contrôleur : `server/src/controllers/ipDisplayNames.controller.ts` — Service : `server/src/services/ipDisplayNames.service.ts`.
Labels personnalisés affichés sur la NetMap, `BansPage` et `IPReputationPage`.

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/ip-labels` | auth | Liste des labels (global/tenant). |
| POST | `/api/ip-labels` | admin | Body `{ ip: string, label: string }` (les deux requis, sinon 400). Upsert (`listLabels`/`upsertLabel`). |
| DELETE | `/api/ip-labels/:ip` | admin | Supprime le label pour l'IP donnée (`ip` décodé via `decodeURIComponent`). |

## /service-templates

Contrôleur : `server/src/controllers/serviceTemplates.controller.ts` — Service : `server/src/services/serviceTemplate.service.ts`.
Templates intégrés pour 8 services (SSH, RDP, Nginx, Apache, IIS, FTP, Mail, MySQL) + regex custom avec groupes nommés (`?P<ip>`, `?P<username>`). Assignation hiérarchique : agent > groupe > défaut du template.

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/service-templates/local/:scope/:scopeId` | auth | Templates locaux (overrides spécifiques agent/groupe) — `scope` ∈ `agent`\|`group`. |
| GET | `/api/service-templates/resolved/group/:groupId` | auth | Résolution effective des templates pour un groupe (hérite des overrides). |
| GET | `/api/service-templates` | auth | Liste des templates plateforme + tenant. |
| GET | `/api/service-templates/:id` | auth | Détail d'un template. |
| POST | `/api/service-templates` | admin | Body `CreateServiceTemplateRequest` : `name`, `serviceType`, `defaultLogPath?`, `customRegex?`, `threshold?`, `windowSeconds?`, `enabled?`, `mode?` (`ban`\|`track`), `ownerScope?` (`agent`\|`group`, crée un template local si renseigné), `ownerScopeId?`. |
| PUT | `/api/service-templates/:id` | admin | Body `UpdateServiceTemplateRequest` (champs partiels : `name`, `defaultLogPath`, `customRegex`, `threshold`, `windowSeconds`, `enabled`, `mode`). |
| DELETE | `/api/service-templates/:id` | admin | Supprime le template. |
| PUT | `/api/service-templates/:id/assign/:scope/:scopeId` | admin | Body `UpsertServiceAssignmentRequest` : `logPathOverride?`, `thresholdOverride?`, `windowSecondsOverride?`, `enabledOverride?`, `sampleRequested?`. Crée/met à jour l'assignation d'un template à un agent ou groupe donné. |
| DELETE | `/api/service-templates/:id/assign/:scope/:scopeId` | admin | Supprime l'assignation (retour aux valeurs par défaut du template). |
| POST | `/api/service-templates/:id/sample/:deviceId` | admin | Demande à un agent un échantillon de logs correspondant au template (`requestSample`, via le hub WS). |

Les routes statiques (`/local/...`, `/resolved/...`) sont déclarées avant `/:id` pour la même raison que `/bans` — éviter le shadowing par le paramètre générique.

## /remote-blocklists

Contrôleur : `server/src/controllers/remoteBlocklist.controller.ts` — Service : `server/src/services/remoteBlocklist.service.ts`.
Gère les listes de blocage externes (URL texte brut, une IP par ligne) et l'intégration guard.obli.tools (push des auto-bans, pull du blocklist delta).

> À la différence des autres routes de ce document, `remoteBlocklist.routes.ts` ne déclare **aucun** middleware `requireAuth`/`requireRole` par route — la protection provient uniquement du montage sous `tenantRouter` (`requireAuth` + `requireTenant` globaux). Il n'y a pas de restriction `admin` explicite sur ces endpoints.

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/remote-blocklists` | Liste des blocklists configurées pour le tenant. |
| POST | `/api/remote-blocklists` | Body `{ name, sourceType, url, apiKey?, syncInterval? }`. Crée une blocklist. 201 en cas de succès. |
| PUT | `/api/remote-blocklists/:id` | Met à jour une blocklist (body libre transmis à `remoteBlocklistService.update`). |
| DELETE | `/api/remote-blocklists/:id` | Supprime une blocklist. |
| POST | `/api/remote-blocklists/:id/sync` | Force une synchronisation immédiate (parse l'URL / pull delta obli.tools). Retourne 502 si la synchro distante échoue. |
| GET | `/api/remote-blocklists/ips` | Liste les IP importées. Query : `blocklistId?`, `search?`, `enabled?` (`true`/`false`), `limit?` (déf. 50), `offset?` (déf. 0). |
| PUT | `/api/remote-blocklists/ips/:id/toggle` | Body `{ enabled: boolean }`. Active/désactive une IP importée sans la supprimer. |
| GET | `/api/remote-blocklists/stats` | Statistiques globales (nombre de listes, d'IP actives, etc.). |
| POST | `/api/remote-blocklists/push-now` | Force un push immédiat des auto-bans locaux vers guard.obli.tools. |

## Format de réponse commun

L'ensemble de ces contrôleurs répond en JSON avec une enveloppe `{ success: boolean, data?, message?, total?, page?, pageSize? }`. Les erreurs métier passent par `AppError(status, message)` (`server/src/middleware/errorHandler.ts`) et sont relayées via `next(err)` — codes utilisés dans ce périmètre : `400` (paramètre manquant/invalide), `404` (ressource introuvable), `409` (conflit, ex. ban déjà actif), `502` (échec de synchro distante).
