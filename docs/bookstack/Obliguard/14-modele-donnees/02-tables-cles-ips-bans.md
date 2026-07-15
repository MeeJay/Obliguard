Ces tables forment le cœur du moteur IPS d'Obliguard. Elles sont toutes créées dans la migration consolidée `server/src/db/migrations/001_obliguard_schema.ts` (section 10 — "Obliguard IPS core"), puis étendues par des migrations ultérieures (006, 008, 012, 024). Les noms de tables réels diffèrent parfois du nom fonctionnel employé dans le code/UI — ils sont précisés ci-dessous.

## agent_devices

Table des agents enregistrés (`server/src/db/migrations/001_obliguard_schema.ts:330`). Colonnes clés :

| Colonne | Type | Rôle |
|---|---|---|
| `uuid` | string(64), unique | Identifiant machine généré par l'agent au premier lancement |
| `hostname` / `name` | string | Nom réseau / libellé personnalisé affiché à la place du hostname |
| `status` | string(16) | `pending` \| `approved` \| `refused` |
| `check_interval_seconds` | int | Intervalle de push poussé à l'agent à chaque réponse |
| `group_id` | FK → `monitor_groups` | Rattachement hiérarchique optionnel |
| `heartbeat_monitoring` | bool | Si `false`, un agent hors-ligne passe en état "inactive" sans notification |
| `agent_max_missed_pushes` | int nullable | Override du nombre de battements manqués avant offline (sinon hérité du groupe) |
| `display_config` | jsonb | Préférences d'affichage UI par agent |
| `pending_command` | string(50) | Commande admin en attente de livraison au prochain push/WS (ex. désinstallation) |
| `updating_since` | timestamp | Marqueur d'auto-mise à jour en cours, effacé à la reconnexion |
| `notification_types` | jsonb nullable | Override des types de notifications par agent (NULL = hérite du groupe) |
| `tenant_id` | FK → `tenants` | Isolation multi-tenant |

Table liée : `agent_services` — services auto-détectés par scan de ports (`service_type`, `port`, `active`, `last_seen_at`), unique sur `(device_id, service_type)`.

## service_templates

Définitions de parseurs de logs, globales ou par tenant (`001_obliguard_schema.ts:525`).

| Colonne | Rôle |
|---|---|
| `service_type` | `ssh`, `rdp`, `nginx`, `apache`, `iis`, `ftp`, `mail`, `mysql`, `custom` |
| `is_builtin` | `true` = regex codée en dur dans le binaire agent ; `false` = `custom_regex` obligatoire |
| `custom_regex` | Regex à groupes nommés `(?P<ip>...)`, `(?P<username>...)` — NULL pour les templates built-in |
| `threshold` / `window_seconds` | Seuil d'échecs / fenêtre glissante (ex. 5 échecs en 300s) |
| `enabled` | Mode `ban` implicite si actif — la logique ban/track est gérée par ailleurs (migration 002) |
| `tenant_id` | NULL = template plateforme (tous tenants), non-NULL = template personnalisé tenant |

8 templates built-in sont insérés en seed data à la fin de la migration 001 (un par service supporté hors MikroTik).

Table liée : `service_template_assignments` — overrides par groupe ou par agent (`scope` = `group`\|`agent`, `scope_id`), avec colonnes `*_override` nullable (héritage : NULL = hérite du template ou du groupe parent), et `sample_requested` (l'agent joint les 50 dernières lignes du log au prochain push).

## ip_events

Événements bruts d'échec/succès d'authentification poussés par les agents. Colonnes : `device_id` (FK, nullable), `ip` (type Postgres `inet`), `username`, `service`, `event_type` (`auth_failure` \| `auth_success` \| `port_scan`), `timestamp`, `raw_log`, `tenant_id`. Indexée sur `ip`, `device_id`, `timestamp DESC`, `tenant_id`, `event_type`.

La migration `024_ip_reputation_perf.ts` ajoute un index composite `idx_ip_events_ban_eval` sur `(device_id, service, event_type, timestamp)`, utilisé directement par le cycle de seuil du moteur de bannissement (`BanEngine.evaluateThresholds()` dans `server/src/services/ban.service.ts`).

## ip_reputation

Agrégats par IP, mis à jour en continu par le moteur de bannissement (`001_obliguard_schema.ts:591`). Clé primaire = `ip` (type `inet`), pas d'`id` séparé.

| Colonne | Rôle |
|---|---|
| `total_failures` / `total_successes` | Compteurs cumulés |
| `affected_agents_count` | Nombre d'agents distincts ayant vu cette IP |
| `affected_device_ids` | int[] — set incrémental des `device_id`, ajouté par la migration 024 pour remplacer un `COUNT(DISTINCT device_id)` corrélé sur `ip_events` (coût O(n²) sous forte charge, cause de saturation Postgres) |
| `affected_services` / `attempted_usernames` | text[] — union incrémentale, même logique |
| `first_seen` / `last_seen` | Bornes temporelles |
| `geo_country_code`, `geo_city`, `asn` | Données GeoIP |

Le statut `clean` → `suspicious` → `banned` affiché côté UI (`ipReputation.service.ts`) est dérivé au moment de la lecture, pas stocké en colonne : il combine `total_failures`, la présence d'un ban actif dans `ip_bans`, et — le cas échéant — la ligne de baseline dans `ip_reputation_tenant_clears`.

### ip_reputation_tenant_clears

Nom réel de la table de "clear" par tenant (migration `008_ip_reputation_clears.ts`), correspondant à la notion `ip_reputation_clears`. Une IP "clean" pour un admin tenant reste visible comme suspecte pour un autre tant qu'elle n'a pas été effacée dans son propre scope.

| Colonne | Rôle |
|---|---|
| `ip` (text) + `tenant_id` (FK) | UNIQUE — une baseline par (IP, tenant) |
| `baseline_failures` | Snapshot de `ip_reputation.total_failures` au moment du clear |
| `cleared_at` / `cleared_by` | Audit |

Logique : une IP redevient suspecte pour ce tenant seulement quand `ip_reputation.total_failures > baseline_failures` (nouvelles attaques après le clear). Un admin global peut à la place remettre `total_failures = 0` sur `ip_reputation` et supprimer toutes les lignes de clear pour cette IP (reset global "table rase").

## ip_bans

Bannissements actifs ou expirés, auto ou manuels, globaux ou scopés (`001_obliguard_schema.ts:608`).

| Colonne | Rôle |
|---|---|
| `ip` (inet) + `cidr_prefix` (int nullable) | Bannissement d'une IP unique ou d'un sous-réseau entier (ex. `/24`) |
| `ban_type` | `auto` (créé par le BanEngine) \| `manual` (action admin) |
| `scope` / `scope_id` | `global` \| `tenant` \| `group` \| `agent` — `scope_id` NULL uniquement pour `global` |
| `tenant_id` | Tenant propriétaire (bans scopés tenant) |
| `origin_tenant_id` | Tenant dont l'agent a déclenché le ban auto en premier (traçabilité sur ban promu global) |
| `banned_by_user_id` | Auteur si ban manuel |
| `expires_at` | NULL = permanent, sinon TTL avec auto-désactivation |
| `is_active` | Flag logique (pas de suppression physique) |

Index partiels : `idx_ip_bans_active` (sur `ip` où `is_active = true`), `idx_ip_bans_scope` (sur `scope, scope_id`), `idx_ip_bans_expires` (sur `expires_at` où actif et non permanent). Le service `server/src/services/ban.service.ts` vérifie systématiquement la whitelist et l'absence de doublon actif avant insertion (409 si l'IP est déjà bannie sur ce scope).

### ip_ban_exclusions

Table d'exemption tenant sur les bans globaux (migration `006_ban_exclusions.ts`).

| Colonne | Rôle |
|---|---|
| `ban_id` | FK → `ip_bans` (le ban global concerné) |
| `tenant_id` | FK → `tenants` — le tenant qui refuse d'appliquer ce ban |
| `created_by` | Admin ayant créé l'exclusion |

UNIQUE `(ban_id, tenant_id)` — un tenant ne peut exclure un même ban qu'une fois. Le ban reste appliqué globalement pour les autres tenants ; seuls les agents du tenant exclu ne le reçoivent pas dans leur delta de bannissement. Index `idx_ip_ban_exclusions_tenant` pour accélérer le calcul du delta par tenant.

## ip_whitelist

Nom réel de la table "whitelist" (`001_obliguard_schema.ts:638`), gérée par `server/src/services/whitelist.service.ts`.

| Colonne | Rôle |
|---|---|
| `ip` | Type Postgres `cidr` — accepte IP unique (`1.2.3.4/32`) ou plage (`192.168.0.0/24`) |
| `label` | Libellé optionnel |
| `scope` / `scope_id` | Même hiérarchie que `ip_bans` : `global` \| `tenant` \| `group` \| `agent` |
| `tenant_id` | Isolation tenant |
| `created_by` | FK → `users` |

Index unique `idx_ip_whitelist_uniq` sur `(ip, scope, COALESCE(scope_id, 0))`. Le moteur de bannissement consulte cette table avant toute création de ban auto ou manuel — une IP whitelistée n'est jamais bannie, quel que soit le seuil dépassé.

## ip_display_names

Libellés personnalisés pour des IP connues, affichés sur la NetMap, `BansPage` et `IPReputationPage` (migration `012_ip_display_names.ts`, service `server/src/services/ipDisplayNames.service.ts`).

| Colonne | Rôle |
|---|---|
| `ip` (text) | Adresse concernée |
| `label` | Nom affiché |
| `tenant_id` | NULL = label global posé par un admin plateforme (visible de tous) ; non-NULL = label tenant, prioritaire sur le global pour ce tenant |
| `created_by` | Auteur |

UNIQUE `(ip, tenant_id)` — au plus un label par (IP, tenant). Index sur `ip` et `tenant_id` pour la résolution rapide côté UI.

## Relations d'ensemble

```
tenants ──< agent_devices ──< agent_services
   │             │
   │             └──< ip_events >── ip_reputation (agrégation par ip)
   │                                     │
   │                                     └──< ip_reputation_tenant_clears
   │
   ├──< ip_bans ──< ip_ban_exclusions
   ├──< ip_whitelist
   ├──< ip_display_names
   └──< service_templates ──< service_template_assignments (scope: group | agent)
```

Toutes les tables scopées (`ip_bans`, `ip_whitelist`, `service_template_assignments`) partagent le même modèle `(scope, scope_id)` avec résolution hiérarchique agent > groupe > tenant/global, appliquée côté service (`ban.service.ts`, `whitelist.service.ts`, `serviceTemplate.service.ts`) plutôt qu'en contrainte SQL.
