## Modèle RBAC

Obliguard distingue deux niveaux de contrôle d'accès :

1. **Rôle global** — `admin` ou `user`, stocké dans `users.role` (`server/src/db/migrations/001_obliguard_schema.ts`). Un admin a un accès total (`rw` implicite) à toutes les ressources de tous les tenants ; le middleware `requireRole('admin')` (`server/src/middleware/rbac.ts`) protège les routes réservées (ex: `teams.routes.ts`, `admin/*`).
2. **Permissions fines par équipe (Teams)** — pour les utilisateurs `user`, l'accès aux groupes et aux agents est déterminé par les **équipes** (`user_teams`) auxquelles ils appartiennent, et par les **permissions** attachées à ces équipes (`team_permissions`).

### Tables

| Table | Rôle |
|---|---|
| `user_teams` | Équipe : `name`, `can_create` (droit de créer des groupes/agents), `tenant_id` |
| `team_memberships` | Association `team_id` ↔ `user_id` (clé primaire composite) |
| `team_permissions` | `team_id`, `scope` (`group` ou `monitor`, ce dernier nom hérité d'Obliview désignant en réalité les agents), `scope_id`, `level` (`ro` ou `rw`) |

Une équipe peut recevoir une permission sur un **groupe** (`scope = 'group'`) — auquel cas elle s'applique en cascade à tous les descendants via la table de fermeture transitive `group_closure` — ou directement sur un **agent** (`scope = 'monitor'`, `scope_id` = id de l'agent).

Le service `server/src/services/team.service.ts` gère le CRUD des équipes, l'affectation des membres et des permissions (`setPermissions`, `addPermission`), avec une contrainte d'unicité `['team_id', 'scope', 'scope_id']` (une seule ligne de permission par couple équipe/ressource, mise à jour via `onConflict().merge()`).

### Résolution des permissions effectives

Toute la logique de résolution vit dans `server/src/services/permission.service.ts`. Fonctions clés :

- `getUserTeamIds(userId)` — liste des équipes de l'utilisateur.
- `getMonitorPermission(userId, monitorId, isAdmin)` — combine :
  - la permission directe sur l'agent (`_getHighestPermission('monitor', id)`) ;
  - la permission héritée du groupe parent, résolue à travers `group_closure` (`_getGroupPermissionViaClosureForMonitor`) ;
  - le cas particulier des **groupes généraux** (`monitor_groups.is_general = true`) : lecture garantie (`ro` minimum) pour tout utilisateur, même sans permission explicite, et `rw` si une équipe possède un droit d'écriture.
  - Règle de combinaison : `rw` > `ro` > `null` (`_highest`).
- `getGroupPermission(userId, groupId, isAdmin)` — même logique pour un groupe, en remontant les ancêtres via `group_closure` (jointure `ancestor_id`/`descendant_id`).
- `canReadMonitor` / `canWriteMonitor` / `canReadGroup` / `canWriteGroup` — booléens dérivés.
- `getVisibleMonitorIds` / `getVisibleGroupIds` — listes utilisées pour filtrer les vues (agents/groupes visibles dans l'UI), retournent la chaîne `'all'` pour un admin.
- `canCreate(userId, isAdmin)` — vérifie le flag `user_teams.can_create` sur au moins une des équipes de l'utilisateur ; contrôle la création de nouveaux groupes/agents.
- `getUserPermissions(userId, isAdmin)` — construit l'objet `UserPermissions` envoyé au client à la connexion (`{ canCreate, teams, permissions }`, `permissions` étant une map `"scope:scopeId" -> level`) pour que l'UI adapte les actions disponibles sans redemander le serveur à chaque interaction.
- `getUsersWithMonitorAccess(monitorId)` — utilisé pour cibler les diffusions Socket.io (n'envoyer les événements temps réel qu'aux utilisateurs ayant accès à l'agent concerné).

### Middleware d'application

`server/src/middleware/rbac.ts` expose :

- `requireRole(...roles)` — vérifie `req.session.role` contre une liste de rôles autorisés (401 si non authentifié, 403 sinon).
- `requireMonitorWrite()` — admin toujours autorisé ; sinon appelle `permissionService.canWriteMonitor(userId, req.params.id, false)`.
- `requireGroupWrite()` — équivalent pour `req.params.id` de groupe.
- `requireCanCreate()` — protège les endpoints de création (nouveaux groupes, nouveaux agents).

Ces middlewares sont branchés sur les routes sensibles (ex: `groups.routes.ts`, agents) en complément de `requireAuth` (`server/src/middleware/auth.ts`), qui vérifie simplement `req.session.userId`.

## Héritage des paramètres (Settings)

Le moteur de résolution vit dans `server/src/services/settings.service.ts`. La table `settings` stocke des overrides sous forme `(scope, scope_id, key, value)` avec contrainte d'unicité `['scope', 'scope_id', 'key']` (upsert via `onConflict().merge()`), `scope` valant `'global'`, `'group'` ou `'monitor'` (agent).

### Chaîne de résolution

`resolveForMonitor(monitorId, groupId)` construit un objet `ResolvedSettings` en appliquant successivement, dans cet ordre (chaque étape peut écraser la précédente) :

1. **`HARDCODED_DEFAULTS`** (`shared/`) — valeurs par défaut codées en dur, source `'default'`.
2. **Overrides globaux** — `settings` où `scope = 'global'`, source `'global'`.
3. **Chaîne des groupes ancestraux, de la racine vers le parent direct** — requête sur `group_closure` triée par `depth DESC` afin d'appliquer d'abord l'ancêtre le plus éloigné puis les plus proches (le groupe le plus proche l'emporte), source `'group'` avec `sourceId`/`sourceName` du groupe qui a fourni la valeur.
4. **Overrides propres à l'agent** (`scope = 'monitor'`, `scope_id = monitorId`) — dernière étape, priorité maximale, source `'monitor'`.

Chaque clé résolue conserve sa **source** (`default` / `global` / `group` / `monitor`) et l'identifiant/nom de l'entité qui l'a définie — c'est ce qui alimente l'affichage "hérité de X" dans l'UI (`AgentDetailPage.tsx`, `GroupDetailPage.tsx`).

Deux variantes existent pour l'affichage à d'autres niveaux :

- `resolveForGroup(groupId)` — même chaîne (defaults → global → ancêtres, hors le groupe lui-même), et retourne séparément les `overrides` propres au groupe (pour les afficher éditables sans les fondre dans les valeurs résolues).
- `resolveGlobal()` — juste `HARDCODED_DEFAULTS` + overrides globaux.

`set(scope, scopeId, key, value)` valide la clé contre `SETTINGS_DEFINITIONS` (bornes `min`/`max`) et applique des planchers imposés par l'administrateur serveur via les variables d'environnement `MIN_CHECK_INTERVAL` / `MIN_RETRY_INTERVAL` (politique globale non contournable par les tenants).

Cette architecture est directement héritée d'Obliview (d'où la persistance du terme `monitor` dans le schéma/scope alors qu'il désigne un agent Obliguard) ; les groupes portent en plus `agent_thresholds` et `agent_group_config` (colonnes JSON sur `monitor_groups`) pour les réglages spécifiques à l'IPS (seuils de bannissement, mode track/ban) au niveau groupe.

## Authentification

### Login classique

`POST /api/auth/login` (`server/src/routes/auth.routes.ts`, rate-limité via `authLimiter`) → `authController.login` :

1. `authService.authenticate(username, password)` (`server/src/services/auth.service.ts`) charge l'utilisateur actif, compare le hash bcrypt (`comparePassword`). Si le compte n'a pas de `password_hash` (utilisateur provisionné uniquement via SSO), une `SsoOnlyError` est levée et le contrôleur répond `401` avec `code: 'SSO_ONLY'` et `foreignSource` pour que le client propose la redirection SSO.
2. Si l'utilisateur n'a **aucun** facteur 2FA actif (`totpEnabled`/`emailOtpEnabled` faux), la session est complétée immédiatement (`req.session.userId/username/role`) et `setSessionTenant()` fixe `req.session.currentTenantId` sur le premier tenant accessible (`tenantService.getFirstTenantForUser`).
3. Si un facteur 2FA est actif, la session **n'est pas** créée : seul `req.session.pendingMfaUserId` est posé, et si l'OTP e-mail est activé (et qu'un serveur SMTP est configuré pour l'OTP via `app_config.otp_smtp_server_id`), un code à 6 chiffres est généré et envoyé (`twoFactorService.generateEmailOtp` / `sendEmailOtp`) puis stocké dans `req.session.pendingEmailOtp` avec une expiration de 10 minutes.

### Vérification 2FA

`POST /api/2fa/verify` (`twoFactor.controller.ts`, pas de `requireAuth` car la session n'est pas encore établie — repose sur `pendingMfaUserId`) :

- Méthode `totp` : `twoFactorService.verifyTotp(secret, code)` utilise la lib `otpauth` (SHA1, 6 chiffres, période 30s, fenêtre de tolérance `±2` périodes soit ±60s pour absorber la dérive d'horloge).
- Méthode `email` : compare le code au `pendingEmailOtp` en session (code + expiration).
- En cas de succès : la session est complétée exactement comme dans le flux sans 2FA, et les champs `pendingMfaUserId`/`pendingEmailOtp` sont nettoyés.
- `POST /api/2fa/resend-email` régénère un code si nécessaire.

Le TOTP se configure en 2 temps (`totpSetup` génère secret + QR code via la lib `qrcode`, stocké temporairement en session sous `pendingTotpSecret` ; `totpEnable` vérifie un premier code puis persiste `totp_secret`/`totp_enabled = true` en base). L'OTP e-mail suit le même schéma en deux étapes avec `pendingEmailOtpSetup`.

Une politique globale `force_2fa` (`app_config`) peut être activée par l'admin : `authController.me` calcule `requires2faSetup = true` si l'utilisateur n'a aucun facteur actif et que la politique est active (sauf si `config.disable2faForce` désactive globalement la contrainte côté serveur), ce qui redirige l'UI vers l'assistant de configuration.

### Sessions

Les sessions sont persistées en PostgreSQL via `connect-pg-simple` (table `session`, colonnes `sid`/`sess`/`expire`, index `idx_session_expire`), montées dans `server/src/app.ts` **avant** le rate-limiter global (`apiLimiter`) pour que les utilisateurs authentifiés puissent être exemptés du rate limiting par IP partagée (utile derrière un reverse proxy). Cookie : `httpOnly`, `sameSite: lax`, `secure` piloté par `config.forceHttps`, durée `config.sessionMaxAge`.

### Obligate SSO

Obliguard s'intègre au SSO **Obligate** (écosystème `obli.tools`) via `server/src/services/obligate.service.ts` et `server/src/routes/obligateCallback.routes.ts`, monté hors `/api` sur `/auth` pour recevoir directement la redirection d'Obligate.

Flux `GET /auth/callback?code=&state=` :

1. Validation du paramètre `state` contre `req.session.oauthState` (protection CSRF conforme RFC 6749 §10.12) — en cas de mismatch, redirection vers `/login?error=sso_failed` avec log d'avertissement.
2. `obligateService.exchangeCode(code, redirectUri)` échange le code contre une assertion utilisateur (`ObligateUserAssertion` : `obligateUserId`, `username`, `email`, `displayName`, `role`, éventuel `linkedLocalUserId`).
3. Résolution du compte local, dans cet ordre :
   - si `linkedLocalUserId` est fourni et existe encore → mise à jour du compte local (`role`, `email`, `display_name`) ;
   - sinon recherche dans `sso_foreign_users` (table de liaison `foreign_source = 'obligate'` + `foreign_user_id`) ;
   - sinon auto-provisionnement d'un nouveau compte local (sans mot de passe local — d'où `SsoOnlyError` si l'utilisateur tente ensuite un login classique).
4. La session est établie comme pour un login classique.

Le compte SSO n'a pas de `password_hash` : toute tentative de connexion locale échoue avec `SsoOnlyError`, exposant `foreignSource` pour orienter l'utilisateur vers la connexion Obligate. `authController.me` synchronise en plus, de façon throttlée (60s), les préférences utilisateur depuis Obligate pour les comptes liés (`obligateService.syncUserPreferences`).

Le endpoint `GET /api/oblitools/manifest` (`server/src/routes/oblitools.routes.ts`) expose aux autres applications de l'écosystème obli.tools les métadonnées d'Obliguard (nom, couleur, `ssoPath: /auth/sso-redirect`) et la liste des applications liées via `obligateService.getConnectedApps()`, permettant un sélecteur d'applications inter-produits dans l'UI.
