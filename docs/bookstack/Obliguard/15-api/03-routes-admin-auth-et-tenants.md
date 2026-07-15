Ces groupes de routes couvrent tout ce qui n'est pas propre à la détection/au blocage d'intrusions : authentification, gestion des comptes, hiérarchie de groupes, permissions, multi-tenant, notifications et configuration serveur. Le montage complet se trouve dans `server/src/routes/index.ts`, qui distingue les routes globales (pas de tenant requis) des routes tenant-scopées montées sur un sous-routeur `tenantRouter` (`requireAuth` + `requireTenant`).

## Montage global (`server/src/routes/index.ts`)

```ts
router.use('/auth', authRoutes);
router.use('/auth', obligateCallbackRoutes);   // callback SSO Obligate
router.use('/admin/config', appConfigRoutes);
router.use('/system', systemRoutes);
router.use('/profile/2fa', twoFactorRoutes);   // doit précéder /profile
router.use('/live-alerts', liveAlertRouter);
router.use('/tenants', tenantRoutes);
router.use('/tenant', tenantRoutes);

const tenantRouter = Router();
tenantRouter.use(requireAuth, requireTenant);
tenantRouter.use('/groups', groupsRoutes);
tenantRouter.use('/settings', settingsRoutes);
tenantRouter.use('/notifications', notificationsRoutes);
tenantRouter.use('/users', usersRoutes);
tenantRouter.use('/profile', profileRoutes);
tenantRouter.use('/teams', teamsRoutes);
tenantRouter.use('/admin/smtp-servers', smtpServerRoutes);
```

Le préfixe API global est `/api` (`app.use('/api', routes)` dans `server/src/app.ts`).

## `/auth` — Authentification (`auth.routes.ts`)

Routes publiques ou semi-publiques, non tenant-scopées :

| Méthode | Route | Middleware | Rôle |
|---|---|---|---|
| POST | `/auth/login` | `authLimiter`, `validate(loginSchema)` | Connexion (déclenche le flux 2FA si activé) |
| POST | `/auth/logout` | `requireAuth` | Destruction de session |
| GET | `/auth/me` | `requireAuth` | Utilisateur courant |
| GET | `/auth/permissions` | `requireAuth` | Permissions effectives (RBAC résolu) |
| POST | `/auth/enrollment` | `requireAuth` | Finalise l'assistant d'enrôlement (langue, profil, alertes, apparence, mot de passe, 2FA) |
| POST | `/auth/forgot-password` | `authLimiter` | Déclenche `passwordReset.controller` |
| POST | `/auth/reset-password/validate` | — | Valide un token de réinitialisation |
| POST | `/auth/reset-password` | — | Applique le nouveau mot de passe |

`obligateCallbackRoutes` est également monté sous `/auth` (callback SSO Obligate, `sso-config`, `connected-apps`).

## `/profile/2fa` puis `/auth/verify` — Double authentification (`twoFactor.routes.ts`)

Monté sous `/profile/2fa` (donc `/api/profile/2fa/...`) pour la gestion, avec deux routes de vérification qui vivent hors session authentifiée (session porte un `pendingMfaUserId` pendant le login) :

- `GET /status`, `POST /totp/setup`, `POST /totp/enable`, `DELETE /totp` — TOTP
- `POST /email/setup`, `POST /email/enable`, `DELETE /email` — OTP par e-mail
- `POST /verify`, `POST /resend-email` — `authLimiter`, appelées pendant le login avant que la session soit pleinement authentifiée

## `/users` — Gestion des comptes (`users.routes.ts`)

Entièrement réservé aux admins : `router.use(requireRole('admin'))`.

- CRUD standard : `GET /`, `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id`
- `PUT /:id/password` — changement de mot de passe côté admin (`changePasswordSchema`)
- `GET /:id/teams` — équipes dont l'utilisateur est membre
- `GET /:id/tenants` / `PUT /:id/tenants` — affectation multi-tenant d'un utilisateur

## `/groups` — Hiérarchie de groupes (`groups.routes.ts`)

Table de fermeture (closure table) avec profondeur illimitée. Lecture ouverte à tout utilisateur authentifié (filtrage de visibilité fait dans le contrôleur), écriture conditionnée par `requireGroupWrite()` / `requireCanCreate()` (admin OU équipe en read-write sur le groupe) :

- `GET /`, `GET /tree`, `GET /stats`, `GET /:id`
- `GET /:id/monitors`, `GET /:id/heartbeats`, `GET /:id/detail-stats`
- `POST /` (`requireCanCreate`), `PUT /:id` (`requireGroupWrite`)
- `POST /reorder` (`requireRole('admin')`)
- `POST /:id/move` (`requireGroupWrite`)
- `DELETE /:id`, `DELETE /:id/heartbeats` (`requireGroupWrite`)
- `PATCH /:id/agent-config` (`requireRole('admin')`) — config agent héritée par le groupe

## `/notifications` — Plugins et bindings (`notifications.routes.ts`)

Réservé admin. Deux sous-domaines :

- Canaux (`channels`) : `GET /plugins` (liste les 10 plugins disponibles — Telegram, Discord, Slack, Teams, SMTP, Webhook, Gotify, Ntfy, Pushover, Free Mobile), CRUD `channels/:id`, `POST /channels/:id/test`, gestion de la visibilité tenant via `GET/PUT /channels/:id/tenants`
- Liaisons (`bindings`) : `GET /bindings/resolved` (résolution hiérarchique), `GET /bindings`, `POST /bindings`, `DELETE /bindings`

## `/teams` — RBAC (`teams.routes.ts`)

Réservé admin. CRUD `/`, `/:id`, plus deux sous-ressources :

- `GET/PUT /:id/members` — composition de l'équipe
- `GET/PUT /:id/permissions`, `DELETE /:id/permissions/:permId` — permissions read-only / read-write par groupe (`setTeamPermissionsSchema`)

## `/tenants` et `/tenant` — Multi-tenant (`tenant.routes.ts`)

Les deux préfixes pointent vers le même routeur. Toutes les routes exigent `requireAuth` ; certaines sont limitées à `role === 'admin'` (admin plateforme), les autres vérifient l'appartenance via `tenantService.userHasAccess`.

- `POST /tenant/switch` — change `req.session.currentTenantId` (admin : accès libre à tout tenant ; sinon vérifié via `userHasAccess`)
- `GET /tenants` — liste tous les tenants (admin) ou uniquement ceux de l'utilisateur (`getTenantsForUser`)
- `POST /tenants` (`requireRole('admin')`) — création (`name`, `slug`)
- `GET /tenants/:id`, `PUT /tenants/:id`, `DELETE /tenants/:id` — le tenant `id === 1` (tenant par défaut) ne peut pas être supprimé
- `GET/POST /tenants/:id/members`, `PUT/DELETE /tenants/:id/members/:uid` — rôle `admin`/`member` par tenant

## `/settings` — Paramètres hiérarchiques (`settings.routes.ts`)

Résolution en cascade global → groupe → agent, réservée admin en lecture comme en écriture :

- `GET /global/resolved`, `GET /group/:scopeId/resolved`, `GET /monitor/:scopeId/resolved`
- `PUT /:scope/:scopeId` (`setSettingSchema`), `PUT /:scope/:scopeId/bulk` (`setSettingsBulkSchema`)
- `DELETE /:scope/:scopeId/:key`

## `/profile` — Profil utilisateur courant (`profile.routes.ts`)

Ouvert à tout utilisateur authentifié (pas de contrainte de rôle) :

- `GET /` — profil courant
- `PUT /` (`updateProfileSchema`) — mise à jour (langue, apparence, alertes, etc.)
- `PUT /password` (`changePasswordSchema`) — changement de son propre mot de passe

## `/admin/config` — Configuration applicative globale (`appConfig.routes.ts`)

- `GET /` — accessible à tout utilisateur authentifié (nécessaire pour que la page profil vérifie `allow_2fa`)
- `GET/PATCH /agent-global` (`requireRole('admin')`) — valeurs par défaut agent au niveau plateforme
- `GET/PUT /obligate` (`requireRole('admin')`) — configuration de la passerelle SSO Obligate
- `PUT /:key` (`requireRole('admin')`) — setter générique clé/valeur ; **doit rester la dernière route déclarée** car `:key` capture tout le reste

## `/admin/smtp-servers` — Serveurs SMTP (`smtpServer.routes.ts`)

Monté sous le `tenantRouter` (donc tenant-scopé), réservé admin :

- `GET /`, `POST /`, `PUT /:id`, `DELETE /:id`
- `POST /:id/test` — envoi d'un e-mail de test via `smtpServer.service.ts`, utilisé par le plugin de notification SMTP (`server/src/notifications/plugins/smtp.ts`)

## `/live-alerts` — Alertes temps réel (`liveAlert.routes.ts`)

Toasts Socket.io persistés pour affichage UI, avec un mode cross-tenant explicite :

- `GET /live-alerts/all` (`requireAuth` seul, sans `requireTenant`) — alertes de tous les tenants accessibles à l'utilisateur
- `GET /live-alerts`, `POST /live-alerts/read-all`, `DELETE /live-alerts` (`requireAuth` + `requireTenant`) — scopées au tenant courant
- `PATCH /live-alerts/:id/read`, `DELETE /live-alerts/:id` (`requireAuth` seul) — l'appartenance de l'alerte à l'utilisateur est vérifiée dans le contrôleur, pas dans le routeur

## Points d'architecture à retenir

- La distinction entre routes "globales" et routes du `tenantRouter` détermine si `requireTenant` s'applique : un tenant courant doit être résolu (`req.session.currentTenantId`) avant d'atteindre `groups`, `settings`, `notifications`, `users`, `profile`, `teams`, `admin/smtp-servers`.
- Le contrôle d'accès repose sur trois briques de `server/src/middleware/rbac.ts` : `requireRole('admin')` (rôle plateforme strict), `requireGroupWrite()`/`requireCanCreate()` (admin OU permission d'équipe read-write sur le groupe ciblé).
- `POST /auth/login` et `POST /auth/forgot-password` passent par `authLimiter` (rate limiting dédié) pour limiter le brute-force sur l'authentification elle-même — cohérent avec le rôle d'IPS d'Obliguard côté agents.
