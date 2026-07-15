La réputation IP est un module d'intelligence agrégée : pour chaque adresse IP ayant généré au moins un événement d'authentification (échec ou succès), Obliguard maintient une ligne récapitulative dans la table `ip_reputation`, indépendamment des bans actifs. C'est cette table qui alimente l'onglet **Local** de la page `IPReputationPage.tsx`, ainsi que les info-bulles de la NetMap.

Toute la logique vit dans `server/src/services/ipReputation.service.ts` (classe `IpReputationService`, singleton exporté `ipReputationService`).

## Table `ip_reputation`

Définie dans `server/src/db/migrations/001_obliguard_schema.ts` (section "ip_reputation — aggregated per-IP stats") :

| Colonne | Type | Rôle |
|---|---|---|
| `ip` | `inet` (PK) | Adresse IP (clé primaire, une ligne par IP) |
| `total_failures` | `bigint` | Compteur cumulé d'échecs d'authentification |
| `total_successes` | `bigint` | Compteur cumulé d'authentifications réussies |
| `affected_agents_count` | `integer` | Nombre d'agents distincts ayant vu cette IP |
| `affected_device_ids` | `integer[]` | Ensemble des `device_id` ayant vu l'IP (ajouté en migration 024, remplace un `COUNT(DISTINCT)` coûteux) |
| `affected_services` | `text[]` | Services ciblés (`ssh`, `rdp`, `nginx`, `custom:42`, …) |
| `attempted_usernames` | `text[]` | Noms d'utilisateur tentés sur cette IP |
| `first_seen` / `last_seen` | `timestamptz` | Bornes temporelles de l'activité connue |
| `last_event_device_id` | `integer` | Dernier agent ayant rapporté un événement pour cette IP |
| `geo_country_code`, `geo_city`, `asn` | `string` | Champs GeoIP (voir plus bas) |
| `updated_at` | `timestamptz` | Horodatage de la dernière mise à jour |

Deux tables complémentaires :
- `ip_events` (créée dans la même migration) : le flux brut d'événements (`ip`, `username`, `service`, `event_type`, `timestamp`, `raw_log`, `device_id`, `tenant_id`) poussé par les agents. `ip_reputation` en est l'agrégat, pas une simple vue — il est maintenu de manière incrémentale (voir plus bas), justement pour éviter de scanner `ip_events` à chaque mise à jour.
- `ip_reputation_tenant_clears` (migration `008_ip_reputation_clears.ts`) : baselines de "clear" par tenant (voir section Statuts).

## Agrégation incrémentale : `upsertFromEvents()`

`upsertFromEvents(events)` est appelée en lot à chaque flush d'événements agent (débounce 500 ms côté hub WS). Elle groupe d'abord les événements reçus par IP en mémoire (`Map<string, {...}>`), puis exécute **un seul `INSERT ... ON CONFLICT DO UPDATE`** par IP via `db.raw()`.

Règles d'agrégation par IP :
- `event_type = 'auth_failure'` → incrémente `total_failures`
- `event_type = 'auth_success'` → incrémente `total_successes`
- `service` est ajouté à l'ensemble `affected_services` (union dédupliquée)
- `username` (si non vide) est ajouté à `attempted_usernames`
- `first_seen` = `LEAST(ancien, nouveau)`, `last_seen` = `GREATEST(ancien, nouveau)`

Les colonnes `text[]` (`affected_services`, `attempted_usernames`) et `int[]` (`affected_device_ids`) sont fusionnées côté SQL avec `array_agg(DISTINCT val) FROM unnest(ancien || nouveau)`, pas en JS — cela évite de charger la ligne existante avant de la réécrire.

Un commentaire du fichier (issu de la migration de perf `024_ip_reputation_perf.ts`) documente pourquoi `affected_agents_count` n'est plus recalculé par une sous-requête corrélée sur `ip_events` :

```
The per-event ip_reputation upsert recomputed `affected_agents_count` with a
correlated subquery: SELECT COUNT(DISTINCT device_id) FROM ip_events WHERE ip_events.ip = ?
That is O(rows-for-that-ip) on EVERY event... Under an active brute force
it degrades to O(n²) and pins Postgres, starving the connection pool.
```

Résolution : `affected_device_ids` (colonne `int[]`, migration 024) est maintenue de façon incrémentale par union d'ensembles, exactement comme `affected_services`/`attempted_usernames`, et `affected_agents_count` est dérivé de `COUNT(DISTINCT val)` sur cet ensemble — sans jamais retoucher `ip_events`. La migration 024 ajoute aussi un index composite `idx_ip_events_ban_eval (device_id, service, event_type, "timestamp")` utilisé par `BanEngine.evaluateThresholds()` (le cycle d'évaluation 30 s du service de bans).

## Autres opérations d'écriture

- **`ensureExists(ip)`** : insère une ligne minimale (`ON CONFLICT DO NOTHING`) pour garantir qu'une IP bannie manuellement (sans événement préalable) soit tout de même visible dans le module réputation.
- **`markSuspicious(ip)`** : force `total_failures` à au moins 1 (`GREATEST(total_failures, 1)`) et purge les baselines de clear par tenant qui masqueraient ce statut.
- **`clearGlobal(ip)`** (admin) : remet `total_failures` à 0 et supprime toutes les baselines `ip_reputation_tenant_clears` associées.
- **`clearForTenant(ip, tenantId, userId)`** : n'affecte pas le compteur global ; enregistre une baseline (`baseline_failures = total_failures` courant) dans `ip_reputation_tenant_clears` (upsert sur `[ip, tenant_id]`).
- **`markClean(ip, tenantId, isAdmin, userId)`** : point d'entrée unique — appelle `clearGlobal` pour un admin, `clearForTenant` sinon.

## Calcul du statut (`IpStatus`)

Le statut n'est **pas stocké** ; il est calculé à la lecture (`clean` | `suspicious` | `banned` | `whitelisted`, type `IpStatus` dans `shared/src/types.ts`) :

1. `banned` si une ligne `ip_bans` active existe pour cette IP (`is_active = true`, `expires_at` nul ou futur)
2. sinon `whitelisted` si l'IP matche une entrée `ip_whitelist` (`ip <<= whitelist.ip`, comparaison CIDR)
3. sinon `suspicious` si `total_failures > 0` — mais avec une nuance multi-tenant :
   - Admin ou tenant maître (`isMasterTenant`) : seuil brut `total_failures > 0`
   - Tenant classique ayant déjà "clear" cette IP : `total_failures > baseline_failures` (la valeur au moment du clear) — donc l'IP redevient `suspicious` uniquement si de **nouveaux** échecs arrivent après le clear
4. sinon `clean`

Dans `list()`, ce calcul est exprimé en SQL via un `CASE` (`STATUS_CASE`) avec jointures `LEFT JOIN ip_bans`, `LEFT JOIN ip_whitelist`, et `LEFT JOIN ip_reputation_tenant_clears` (jointure conditionnelle, seulement pour les tenants non-admin/non-maîtres). `getByIp()` et `getIpDetail()` répliquent la même logique en JS avec des requêtes séparées.

Particularité de `list({ status: 'banned' })` : la requête part de `ip_bans` comme table pilote (`LEFT JOIN ip_reputation`), avec `COALESCE(r.*, 0/'{}'/b.banned_at)` — pour que les IP bannies manuellement sans jamais avoir généré d'événement (donc sans ligne `ip_reputation`) restent visibles dans l'onglet Banni.

Pour les tenants non-admin, `list()` restreint aussi le résultat aux IP ayant au moins un `ip_events` rattaché au tenant (`whereExists` sur `ip_events.tenant_id`), pour qu'un tenant ne voie pas la réputation d'IP qui n'ont jamais touché ses agents.

## GeoIP : pays, ville, ASN

Le schéma prévoit trois champs GeoIP par IP : `geo_country_code` (ISO 2 lettres), `geo_city`, `asn`. Le type `IpReputation` (`shared/src/types.ts`) expose `geoCountryCode`, `geoCity`, `asn`, et l'UI (`IPReputationPage.tsx`) les affiche avec un drapeau émoji (`countryCodeToFlag(ip.geoCountryCode)`) et le format `Ville, CC · ASN`.

Dans `ipReputation.service.ts`, ces trois colonnes sont **toujours insérées à `NULL`** lors des upserts (`upsertFromEvents`, `ensureExists`, `markSuspicious`) — aucune méthode du service n'écrit de valeur GeoIP dans `ip_reputation`. La résolution géographique existante dans le code n'est pas un enrichissement serveur persistant : `server/src/routes/geo.routes.ts` expose `POST /api/geo/batch`, un simple proxy vers `ip-api.com/batch` (max 100 IP par appel, timeout 6 s, `fields=query,countryCode`), consommé côté client par `NetMapPage.tsx` pour colorer la carte à la volée. Les colonnes `geo_country_code`/`geo_city`/`asn` de `ip_reputation` restent donc le point d'extension prévu pour un futur enrichissement persistant (ex. un job qui appellerait ce même service et écrirait le résultat en base), mais ne sont pas alimentées aujourd'hui par le pipeline d'agrégation.

## Détail d'une IP : `getIpDetail()`

Utilisé par le tiroir de détail de `IPReputationPage.tsx`, `getIpDetail(ip, tenantId, isAdmin)` retourne :
- `reputation` : la ligne `ip_reputation` enrichie du statut calculé (ou `null` si l'IP n'a pas de ligne)
- `recentEvents` : les 50 derniers `ip_events` pour cette IP (`ORDER BY timestamp DESC`), avec jointure `agent_devices` pour le `hostname`, filtrés par `tenant_id` pour les tenants non-admin

Si ni réputation ni événement n'existent pour l'IP, la méthode retourne `null` (404 côté contrôleur).

## Points d'appel

- `ban.service.ts` appelle `ensureExists()` lors de la création d'un ban pour garantir la visibilité dans le module réputation, même sans événement préalable.
- Le hub agent (`obliguardHub.service.ts`) déclenche `upsertFromEvents()` à chaque flush d'événements (débounce 500 ms), donc l'agrégat reste quasi temps réel sans lecture de `ip_events`.
- Les routes `/ip-reputation` exposent `list`, `getByIp`, `getIpDetail`, ainsi que les actions `clearForTenant`/`clearGlobal`/`markSuspicious`/`markClean` pour l'UI (boutons "Marquer suspect" / "Marquer propre" dans `IPReputationPage.tsx`).
