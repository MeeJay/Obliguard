Le schéma PostgreSQL d'Obliguard est géré par Knex, avec les migrations stockées dans `server/src/db/migrations/`. Le fichier `knexfile.ts` charge `server/src/env.ts` en premier pour lire la configuration `.env` avant toute connexion.

Le dépôt compte aujourd'hui 24 migrations numérotées `001` à `024`. Cette page documente leur rôle exact ; les migrations 021-024, ajoutées après la vue d'ensemble initiale (rate limiting, correctifs de sécurité, mode observation, performance), sont incluses par souci d'exhaustivité.

## 001 — Schéma consolidé (`001_obliguard_schema.ts`)

Migration fondatrice : elle recrée en une seule fois l'état final des ~44 migrations originales du produit historique Obliview, dont Obliguard est issu, plus les tables IPS ajoutées ensuite (ex-migration 043 « Obliguard IPS core »). Les tables `monitors`, `heartbeats`, `heartbeat_stats`, `incidents` et `maintenance_windows` (spécifiques à l'ancien monitoring uptime) sont volontairement exclues.

Sections créées, dans l'ordre de dépendance :

| Section | Tables |
|---|---|
| Auth core | `users`, `session` (connect-pg-simple), `password_reset_tokens` |
| Multi-tenant | `tenants` (tenant `Default` seedé avec `id=1`), `user_tenants` |
| Groupes | `monitor_groups` (hiérarchie agents/monitors, colonne `kind`), `group_closure` (table de fermeture transitive pour requêtes d'ascendance/descendance en O(1)) |
| Teams / RBAC | `user_teams`, `team_memberships`, `team_permissions` (`scope`: `group`/`monitor`, `level`: `ro`/`rw`) |
| Settings | `settings` — store clé/valeur avec héritage `scope` (`global`/`group`) + `scope_id` |
| Notifications | `notification_channels`, `notification_bindings`, `notification_log`, `notification_channel_tenants` |
| Agents | `agent_api_keys`, `agent_devices` (statut `pending`/`approved`/`refused`, `check_interval_seconds`, `pending_command`), `agent_services` (services auto-détectés par port) |
| Remédiations | `remediation_actions`, `remediation_bindings`, `remediation_runs` |
| Infra | `smtp_servers`, `app_config` (clé/valeur plateforme, seedé avec `allow_2fa`, `force_2fa`, `otp_smtp_server_id`), `live_alerts` |
| **Cœur IPS** | `service_templates`, `service_template_assignments`, `ip_events`, `ip_reputation`, `ip_bans`, `ip_whitelist` |

Points structurants du cœur IPS :

- `service_templates` : `service_type` (`ssh`, `rdp`, `nginx`, `apache`, `iis`, `ftp`, `mail`, `mysql`, `custom`…), `is_builtin`, `custom_regex` (groupes nommés `?P<ip>` / `?P<username>`), `threshold` / `window_seconds`, `tenant_id` nullable (`NULL` = template plateforme partagé par tous les tenants).
- `service_template_assignments` : overrides par `scope` (`group`/`agent`) avec unicité `(template_id, scope, scope_id)`.
- `ip_events` : table brute des échecs d'authentification remontés par les agents, indexée sur `ip`, `device_id`, `timestamp DESC`, `tenant_id`, `event_type`.
- `ip_reputation` : agrégats par IP (`total_failures`, `total_successes`, `affected_agents_count`, tableaux `affected_services`/`attempted_usernames`, champs GeoIP), mise à jour par `ban.service.ts`.
- `ip_bans` : `ban_type` (`auto`/`manual`), `scope` (`global`/`tenant`/`group`/`agent`), `cidr_prefix` optionnel, `expires_at` nullable (permanent si `NULL`), index partiel `WHERE is_active = true`.
- `ip_whitelist` : CIDR (type `cidr` Postgres), même modèle de scope que les bans, contrainte d'unicité `(ip, scope, COALESCE(scope_id, 0))`.
- 8 templates intégrés sont seedés (SSH seuil 5/300s, RDP 3/300s, Nginx/Apache/IIS 20/60s, FTP/Mail/MySQL 5/300s).

## 002 — Mode des templates (`002_service_template_mode.ts`)

Ajoute `service_templates.mode` (`ban` par défaut, ou `track`) et `ip_events.track_only` (booléen). Un template en mode `track` journalise les événements pour la réputation IP sans jamais déclencher de ban : le moteur (`ban.service.ts`) ignore les lignes `track_only = true` grâce à un index partiel dédié.

## 003 — Templates locaux (`003_local_templates.ts`)

Ajoute `service_templates.owner_scope` (`agent` | `group` | `NULL`) et `owner_scope_id`. Permet de créer des templates de service propres à un agent ou un groupe, invisibles dans la liste globale et auto-assignés à leur propriétaire à la création.

## 004 — Timestamps menace/attaque (`004_threat_attack.ts`)

Ajoute `agent_devices.last_threat_at` et `last_attack_at` (timestamptz nullable). Utilisés côté client pour afficher un indicateur visuel qui s'efface après 3 min (menace) ou 10 min (attaque) sans nouvel événement.

## 005 — Liens entre pairs d'agents (`005_agent_peer_links.ts`)

Support de la détection de liaisons agent-à-agent sur la NetMap :

- Nouvelle table `agent_ips` : toutes les IP LAN RFC-1918 rapportées par un agent, reconstruite à chaque push (DELETE + INSERT), unique sur `(agent_id, ip_address)`.
- `ip_events` enrichi de `source_agent_id` (FK `agent_devices`) et `source_ip_type` (`lan`/`wan`) : quand l'IP source d'un événement appartient à un autre agent connu du même tenant, l'événement est rattaché à cet agent.
- `agent_devices.wan_matching_enabled` (défaut `false`) : opt-in permettant d'utiliser aussi l'IP WAN de l'agent comme identifiant de liaison, pour les IP publiques statiques/dédiées.

## 006 — Exclusions de bans (`006_ban_exclusions.ts`)

Table `ip_ban_exclusions` : un admin de tenant peut exclure un ban global (`ip_bans`) pour son propre tenant sans révoquer la protection ailleurs — le ban reste actif globalement, mais les agents du tenant excluant ne l'appliquent plus. Unicité `(ban_id, tenant_id)`.

## 007 — Templates désactivés par défaut (`007_template_inactive_default.ts`)

Bascule le modèle vers de l'opt-in : tous les templates globaux (`owner_scope IS NULL`) sont mis à `enabled = false`. Auparavant activés par défaut, ils devaient être explicitement activés par un `service_template_assignments.enabled_override = true` au niveau groupe/agent pour compter dans le moteur de ban — évite par exemple qu'un template RDP bannisse sur des agents Linux.

## 008 — Suppression logicielle de réputation IP (`008_ip_reputation_clears.ts`)

Table `ip_reputation_tenant_clears` : quand un admin de tenant « nettoie » une IP suspecte, une ligne `(ip, tenant_id, baseline_failures)` capture la valeur courante de `total_failures`. L'IP redevient suspecte pour ce tenant uniquement si `total_failures` dépasse ensuite `baseline_failures` (soft-delete par tenant). Un admin global, lui, remet `total_failures` à 0 et supprime toutes les lignes de clear pour cette IP (reset global).

## 009-011 — SSO Obligate

Trois migrations mettent en place le SSO cross-plateforme entre Obliguard et la plateforme sœur Obligate/Obliview :

- **009** (`009_foreign_sso.ts`) : `users.password_hash` devient nullable (les utilisateurs SSO n'ont pas de mot de passe local), ajout de `foreign_source`, `foreign_id`, `foreign_source_url`. Table `switch_tokens` : jetons à usage unique pour les redirections SSO (TTL 60s, `used` boolean).
- **010** (`010_sso_link_tokens.ts`) : table `sso_link_tokens` pour le flux de liaison de compte quand un nom d'utilisateur SSO entre en conflit avec un compte local existant — l'utilisateur doit prouver la propriété du compte local via son mot de passe.
- **011** (`011_sso_foreign_users.ts`) : table de jonction `sso_foreign_users` (`foreign_source`, `foreign_user_id`, `local_user_id`, unique sur `(foreign_source, foreign_user_id)`) qui remplace le modèle mono-colonne de la 009 — un utilisateur local peut désormais être lié à plusieurs sources SSO. Les lignes déjà présentes dans `users.foreign_source`/`foreign_id` sont migrées automatiquement vers la nouvelle table.

## 012 — Noms d'affichage des IP (`012_ip_display_names.ts`)

Table `ip_display_names` : labels personnalisés par IP (`ip`, `label`), avec `tenant_id` nullable (`NULL` = label global visible par tous, sinon label scopé au tenant qui prime sur le global). Unicité `(ip, tenant_id)`. Utilisé par `ipDisplayNames.service.ts` et affiché sur la NetMap, `BansPage` et `IPReputationPage`.

## 013 — Avatar utilisateur (`013_user_avatar.ts`)

Ajoute simplement `users.avatar` (text, nullable).

## 014 — Capacités d'équipe (`014_team_capabilities.ts`)

Ajoute `team_permissions.capabilities` (jsonb nullable), permettant des permissions granulaires au-delà du simple `ro`/`rw`.

## 015 — Jeux de permissions (`015_permission_sets.ts`)

Nouvelle table `permission_sets` (`name`, `slug`, `capabilities` jsonb, `is_default`), seedée avec trois rôles prédéfinis : **Admin** (toutes capacités : monitoring, groupes, agents, bans, whitelist, templates, labels IP, settings, gestion utilisateurs), **User** (monitoring, bans, whitelist) et **Viewer** (monitoring seul).

## 016 — Templates OPNsense (`016_opnsense_templates.ts`)

Ajoute deux templates intégrés idempotents (insérés seulement s'ils n'existent pas déjà) : `opnsense` (auth Web UI/API, mode `ban`, seuil 5/300s) et `opnsense_filter` (pf filterlog — connexions bloquées/NAT, mode `track`, seuil 30/60s).

## 017-019 — Support MikroTik

- **017** (`017_mikrotik_devices.ts`) : ajoute `agent_devices.device_type` (`agent` | `mikrotik`) pour distinguer les agents Go classiques des routeurs MikroTik gérés à distance. Nouvelle table `mikrotik_credentials` : hôte/port API, TLS, identifiants (mot de passe chiffré AES-256-GCM via `api_password_enc`), `syslog_identifier` (routage par IP source), `address_list_name` (défaut `obliguard_blocklist`). Seed de 3 templates intégrés : `mikrotik_ssh`, `mikrotik_winbox`, `mikrotik_web` (5/300s, mode `ban`).
- **018** (`018_mikrotik_import_lists.ts`) : ajoute `mikrotik_credentials.import_address_lists` (liste de noms séparés par virgules) pour la synchronisation bidirectionnelle — les IP d'une address-list MikroTik (ex. remplie par des règles honeypot) sont importées périodiquement comme bans globaux Obliguard.
- **019** (`019_mikrotik_ingest_token.ts`) : ajoute `mikrotik_credentials.ingest_token` (unique) pour l'authentification de l'endpoint HTTP `/api/agent/mikrotik/ingest`, alternative au syslog UDP quand celui-ci ne peut pas être exposé (reverse proxy, Docker). Génère un token pour chaque appareil existant lors de la migration.

## 020 — Blocklists distantes (`020_remote_blocklists.ts`)

Deux tables pour l'abonnement à des listes de blocage IP externes :

- `remote_blocklists` : `source_type` (`oblitools` | `url`), `url`, `api_key` nullable (bearer token pour guard.obli.tools), `sync_interval` (défaut 600s), `last_sync_at`/`last_sync_count`.
- `remote_blocked_ips` : IP importées par blocklist, avec `reports` (compteur), `sources` (tableau text[]), unique `(blocklist_id, ip)`.

Gérée par `remoteBlocklist.service.ts` et la page `SettingsPage.tsx`.

## 021 — Politiques de rate limiting (`021_rate_limit_policies.ts`)

Table `rate_limit_policies` : règles de limitation de débit appliquées au niveau pare-feu, résolues par la même hiérarchie global → tenant → group → agent que la whitelist. Deux types indépendants : `connection` (connexions concurrentes max par IP source) et `rate` (nouvelles connexions/s par IP). Action à deux paliers : au-delà de `max_value`, `action` (`drop`/`reject`) ; au-delà de `max_value * ban_multiplier`, escalade vers un ban automatique via le pipeline de ban existant (`ban_ttl_seconds` nullable = ban permanent).

## 022 — Correction des built-ins « fuités » (`022_disable_leaked_builtins.ts`)

Corrige un oubli : l'invariant opt-in posé par la migration 007 (« aucun template actif par défaut ») ne s'appliquait qu'aux 8 templates originaux. Les built-ins ajoutés ensuite par 016 (`opnsense`, `opnsense_filter`) et 017 (`mikrotik_ssh`, `mikrotik_winbox`, `mikrotik_web`) avaient été insérés avec `enabled = true` et n'avaient jamais été redésactivés — ils s'activaient donc automatiquement sur chaque installation. Cette migration force `enabled = false` uniquement pour ces 5 `service_type` au niveau global (`owner_scope IS NULL`), sans toucher aux 8 built-ins originaux ni aux assignations groupe/agent existantes.

## 023 — Mode observation seule (`023_evaluate_only.ts`)

Ajoute `evaluate_only` (booléen, défaut `false`) sur `monitor_groups` et `agent_devices` (avec vérification `hasColumn` pour idempotence). En mode évaluation, les événements continuent d'être stockés et affichés (pour l'évaluation des règles de whitelist), mais le moteur de ban ne crée aucun ban automatique et l'agent reçoit une liste de bans vide côté pare-feu — impact réseau nul. L'héritage suit le même mécanisme que le reste de la pile : un appareil est en mode évaluation si son propre flag est vrai ou si un groupe ancêtre l'est (résolu via `group_closure`).

## 024 — Performance de la réputation IP (`024_ip_reputation_perf.ts`)

Correctif de performance critique. L'upsert `ip_reputation` recalculait `affected_agents_count` via une sous-requête corrélée `SELECT COUNT(DISTINCT device_id) FROM ip_events WHERE ip = ?` à chaque événement — coût O(n) par IP sur une table `ip_events` qui grossit sans borne, dégénérant en O(n²) pendant une attaque par force brute active (précisément quand l'IPS est le plus sollicité), saturant Postgres et le pool de connexions.

Correctif : ajout de `ip_reputation.affected_device_ids` (`integer[]`, défaut `'{}'`), maintenu de façon incrémentale comme le sont déjà `affected_services`/`attempted_usernames`, évitant tout retour sur `ip_events`. Ajout aussi de l'index composite `idx_ip_events_ban_eval` sur `(device_id, service, event_type, timestamp)` pour la requête de seuil du cycle 30s du moteur de ban (`BanEngine.evaluateThresholds()` dans `ban.service.ts`). Aucun backfill n'est exécuté — la colonne s'auto-répare au fil des nouveaux événements pour ne pas alourdir une base déjà sous pression.

## Récapitulatif

| # | Fichier | Domaine |
|---|---|---|
| 001 | `001_obliguard_schema.ts` | Schéma consolidé complet |
| 002 | `002_service_template_mode.ts` | Mode ban/track des templates |
| 003 | `003_local_templates.ts` | Templates locaux agent/groupe |
| 004 | `004_threat_attack.ts` | Timestamps menace/attaque |
| 005 | `005_agent_peer_links.ts` | Liens NetMap entre agents |
| 006 | `006_ban_exclusions.ts` | Exclusions de bans par tenant |
| 007 | `007_template_inactive_default.ts` | Templates opt-in |
| 008 | `008_ip_reputation_clears.ts` | Soft-delete réputation IP |
| 009 | `009_foreign_sso.ts` | SSO Obligate — base |
| 010 | `010_sso_link_tokens.ts` | SSO — liaison de compte |
| 011 | `011_sso_foreign_users.ts` | SSO — sources multiples |
| 012 | `012_ip_display_names.ts` | Labels IP personnalisés |
| 013 | `013_user_avatar.ts` | Avatar utilisateur |
| 014 | `014_team_capabilities.ts` | Capacités d'équipe |
| 015 | `015_permission_sets.ts` | Jeux de permissions prédéfinis |
| 016 | `016_opnsense_templates.ts` | Templates OPNsense |
| 017 | `017_mikrotik_devices.ts` | Appareils MikroTik + credentials |
| 018 | `018_mikrotik_import_lists.ts` | Import bidirectionnel address-lists |
| 019 | `019_mikrotik_ingest_token.ts` | Ingest HTTP MikroTik |
| 020 | `020_remote_blocklists.ts` | Blocklists distantes / obli.tools |
| 021 | `021_rate_limit_policies.ts` | Rate limiting pare-feu |
| 022 | `022_disable_leaked_builtins.ts` | Correctif opt-in OPNsense/MikroTik |
| 023 | `023_evaluate_only.ts` | Mode observation seule |
| 024 | `024_ip_reputation_perf.ts` | Performance upsert réputation IP |
