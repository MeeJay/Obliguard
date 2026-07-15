## Stack et bootstrap

Le client (`client/`) est une SPA React 18 + Vite 5 + TypeScript, stylée avec Tailwind CSS, avec Zustand pour l'état global et `react-router-dom` v6 pour le routage. Le point d'entrée est `client/src/main.tsx`, qui monte `App.tsx`.

`client/vite.config.ts` définit deux alias de résolution :

```ts
resolve: {
  alias: {
    '@': path.resolve(__dirname, './src'),
    '@obliview/shared': path.resolve(__dirname, '../shared/src'),
  },
},
```

Le serveur de dev Vite proxifie `/api` et `/socket.io` vers `http://localhost:3001` (le serveur Express). Contrairement au serveur (qui résout `@obliview/shared` via le symlink npm workspaces vers `shared/dist/`), le client pointe directement sur `shared/src` — pas besoin de recompiler `shared/` en dev côté client.

`__APP_VERSION__` est injecté au build depuis `client/package.json` (`define` dans `vite.config.ts`) et utilisé pour l'affichage de version et la détection de mise à jour du desktop-app.

## Routage (`App.tsx`)

Toutes les pages sont importées de façon statique (pas de `React.lazy` au niveau des routes — seul le moteur 3D NetMap est lazy-loadé, voir plus bas). La structure de `App.tsx` :

- Routes publiques : `/login`, `/forgot-password`, `/reset-password`
- `ProtectedRoute` (`client/src/components/layout/ProtectedRoute.tsx`) protège tout le reste et vérifie la session via `useAuthStore`
- `/enroll` et `/sso-enroll` s'affichent hors `AppLayout` (plein écran, sans sidebar)
- `AppLayout` (`client/src/components/layout/AppLayout.tsx`) enveloppe les pages applicatives standard : `/`, `/netmap`, `/ip-reputation`, `/download`, `/profile`, `/group/:id`, `/group/:id/edit`
- Un second `ProtectedRoute` avec `requiredRole="admin"` protège les routes d'administration : `/groups`, `/notifications`, `/admin/users`, `/admin/agents`, `/admin/import-export`, `/admin/tenants`, `/admin/service-templates`, `/admin/network-limiting`, `/agents/:deviceId`, `/live-events`, `/settings`

Point notable : `BansPage.tsx` et `WhitelistPage.tsx` existent toujours dans `client/src/pages/` mais leurs routes (`/bans`, `/whitelist`) sont désormais des redirections `<Navigate to="/ip-reputation" replace />` — ces deux vues ont été fusionnées dans `IPReputationPage.tsx` (onglets Local/Remote avec actions de ban/whitelist intégrées), les anciens fichiers de page ne sont plus routés.

## Pages principales

| Page | Fichier | Lignes | Rôle |
|---|---|---|---|
| Dashboard | `pages/DashboardPage.tsx` | ~565 | Bans actifs, IP bloquées aujourd'hui, agents en ligne, événements du jour, derniers bans |
| NetMap | `pages/NetMapPage.tsx` | ~2526 | Visualisation temps réel 2D/3D des agents et IP (voir sections dédiées) |
| IP Reputation | `pages/IPReputationPage.tsx` | ~2488 | Onglets Local/Remote, tiroir de détail IP (`IPDetailDrawer`), ban/whitelist/rename/clear en masse |
| Service Templates | `pages/ServiceTemplatesPage.tsx` | ~994 | Éditeur de templates (regex, seuil, fenêtre, mode ban/track) |
| Live Events | `pages/LiveEventsPage.tsx` | ~537 | Flux d'événements d'authentification en temps réel |
| Agent Detail | `pages/AgentDetailPage.tsx` | ~1640 | Détail d'un agent : services détectés, seuils, starmap, règles pare-feu |
| Settings | `pages/SettingsPage.tsx` | ~1027 | Blocklists distantes, contribution obli.tools, zone de danger (wipe) |
| Admin Agents | `pages/AdminAgentPage.tsx` | — | Gestion des devices agents, téléchargements, actions en masse |
| Admin Users / Tenants | `pages/AdminUsersPage.tsx`, `pages/AdminTenantsPage.tsx` | — | RBAC, gestion multi-tenant |
| Groups | `pages/GroupManagePage.tsx`, `GroupDetailPage.tsx`, `GroupEditPage.tsx` | — | Hiérarchie de groupes (closure table), héritage de settings |
| Notifications | `pages/NotificationsPage.tsx` | — | Configuration des 10 plugins de notification |
| Import/Export | `pages/ImportExportPage.tsx` | — | Export/import JSON avec résolution de conflits |
| Enrollment | `pages/EnrollmentPage.tsx`, `SsoEnrollPage.tsx` | — | Assistant d'inscription (langue, profil, alertes, apparence, mot de passe, 2FA) |

Chaque page « admin » consomme les fichiers correspondants dans `client/src/api/` (ex. `serviceTemplates.api.ts`, `bans.api.ts`, `whitelist.api.ts`, `remoteBlocklist.api.ts`, `mikrotik.api.ts`, `rateLimitPolicies.api.ts`), qui encapsulent les appels HTTP faits via `client/src/api/client.ts` (instance Axios).

## État global (Zustand) et temps réel

`client/src/store/` contient les stores globaux :

- `authStore.ts` — utilisateur courant, permissions RBAC, session ; `syncPreferencesToStore()` applique thème, langue et préférences de toasts au login
- `tenantStore.ts` — tenant actif (multi-tenant workspaces)
- `groupStore.ts` — arbre de groupes
- `liveAlertsStore.ts` — état des toasts d'alerte temps réel (position, activation)
- `socketStore.ts` — statut de connexion Socket.io (`'connected' | 'disconnected' | 'reconnecting'`)
- `uiStore.ts` — état d'UI transverse (sidebar, modales)
- `monitorStore.ts` — état des moniteurs

`client/src/socket/socketClient.ts` gère la connexion Socket.io globale (`io(window.location.origin, ...)`). Elle écoute `reconnect_attempt`/`reconnect` pour piloter `socketStore`, et force un cycle déconnexion→reconnexion complet au réveil de l'onglet (au lieu d'un simple resume) pour garantir un état frais après une mise en veille de l'appareil. Les composants `client/src/components/layout/LiveAlerts.tsx` et `NotificationCenter.tsx` consomment les événements Socket.io (dont `AGENT_STATUS_CHANGED`) pour les toasts et le centre de notifications.

## `netmap/` — moteur 2D (Canvas)

`NetMapPage.tsx` implémente lui-même le rendu Canvas 2D (pas de librairie de graphe externe) ; `client/src/netmap/` fournit les briques réutilisées par la page :

- `types.ts` — `AgentNode`, `IpNode`, `Particle`, `Ripple`, `LiveEvent`, `AgentPeerLink`, `WlEntry`. `IpNode` porte tout l'état d'orbite (`orbitAngle`, `orbitSpeed`, `orbitSlot`, `arriveT`, `trail`, `orbitEccentricity`, `orbitCurrentR`) pour l'animation type « ceinture d'astéroïdes »
- `constants.ts` — TTL des IP par statut (`IP_TTL_CLEAN`, `IP_TTL_SUSPICIOUS`, `IP_TTL_BANNED`), couleurs d'événements, couleurs par type de device
- `helpers.ts` — `flagEmoji`, `svcColor`, `isDangerousSvc`, `statusColor`, `ipToInt`, `matchWhitelist`, `makeOrbitalFields` (calcul des champs orbitaux initiaux d'une IP)
- `layout.ts` — `placeIp`, `distributeIpsAroundAgents`, `relayoutIps`, `layoutAgents` : positionnement initial des agents et répartition des IP en arc de 240° autour de chaque agent, triées par activité (les plus actives sur l'anneau le plus proche)
- `physics.ts` — classe `ForceSimulation` : simulation de forces pour repousser les agents dont les anneaux d'IP se chevaucheraient
- `tabStore.ts` — store Zustand `useNetMapTabStore` : onglets NetMap personnalisés (sous-ensembles d'agents), persistés en `localStorage` (clé `obliguard-netmap-tabs`) puis synchronisés vers `/profile` (`preferences.netmapTabs`) avec un debounce de 1500 ms

`NetMapPage.tsx` détecte le type de device (`detectDeviceType`) à partir de `deviceType`, `osInfo` et `hostname` (mikrotik/OPNsense/pfSense → `firewall`, RouterOS → `firewall`, Linux/Windows Server → `server`, Windows → `windows`, Darwin → `desktop`), et pilote les particules d'événements uniquement à partir des vrais événements Socket.io (pas de simulation visuelle).

## `netmap3d/` — moteur 3D (Three.js, lazy-loadé)

Le composant `NetMap3D` n'est chargé que lorsque l'utilisateur bascule en vue 3D, via `React.lazy` :

```ts
const NetMap3D = lazy(() => import('../netmap3d/NetMap3D'));
```

encapsulé dans un `<Suspense fallback={...Loading 3D engine…}>` dans `NetMapPage.tsx`. Cela isole Three.js (et ses sous-modules `OrbitControls`, `EffectComposer`, `UnrealBloomPass`, `CSS2DRenderer`) dans un chunk Vite séparé, non téléchargé en mode 2D.

Fichiers de `client/src/netmap3d/` :

- `NetMap3D.tsx` — composant React ; boucle `requestAnimationFrame`, garde les mêmes refs que le mode 2D (`agentsRef`, `ipsRef`, `agentLinksRef` passés en props depuis `NetMapPage`) pour partager la même source de données entre les deux modes
- `scene.ts` — `createScene()` : `THREE.Scene` fond noir spatial (`0x000206`) avec `FogExp2`, caméra perspective (FOV 60), `WebGLRenderer` en tone mapping ACES Filmic, `CSS2DRenderer` pour les labels HTML, pipeline de post-processing `EffectComposer` + `UnrealBloomPass`, `OrbitControls` avec damping ; éclairage : lumière ambiante froide, point light "soleil" chaude à l'origine, fill light bleue par en dessous, directional light distante
- `skybox.ts` — champ d'étoiles de 15 000 points (`STAR_COUNT`) avec shader GLSL de scintillement
- `agentMesh.ts` — sphères émissives pour les agents (le glow vient du bloom post-processing, pas de mesh de bulle additive)
- `ipMesh.ts` — `IpMeshPool`, pool `InstancedMesh` (capacité 2000) pour les points IP, plus performant qu'un mesh par IP
- `orbitRing.ts` — anneaux d'orbite elliptiques inclinés en 3D, `getOrbitPosition3D()`
- `interactions.ts` — raycasting au clic (agents via `traverse`, IP via `instanceId` sur l'`InstancedMesh`), `flyTo()` pour l'animation de caméra
- `constants3d.ts` — `SCALE = 0.35` (facteur de conversion coordonnées 2D pixels → unités 3D), rayons (`AGENT_RADIUS`, `IP_RADIUS_MIN/MAX`), réglages caméra (`CAM_INITIAL_DIST`, `CAM_MIN_DIST`, `CAM_MAX_DIST`), réglages bloom (`BLOOM_STRENGTH`, `BLOOM_RADIUS`, `BLOOM_THRESHOLD`), couleurs de device et de statut IP dédiées (plus vives qu'en 2D)

Point d'architecture important : la simulation physique (force sim des agents, mouvement orbital des IP, animation d'arrivée, expiration) tourne dans la boucle d'animation de `NetMapPage.tsx` **indépendamment** du `viewMode` — seul le rendu Canvas 2D est gardé par un test de nullité du contexte canvas. Cela garantit que passer de 2D à 3D (et inversement) ne réinitialise pas l'état des IP en orbite.

## Layout et composants transverses

`client/src/components/layout/` :

- `AppLayout.tsx` — shell applicatif (sidebar + header + zone de contenu, `<Outlet />` de react-router)
- `Sidebar.tsx` — navigation principale, filtrée par rôle/permissions
- `Header.tsx` — barre supérieure (sélecteur de tenant, profil)
- `TenantSwitcher.tsx` — changement de tenant actif
- `ProtectedRoute.tsx` — garde d'authentification et de rôle (`requiredRole="admin"`)
- `LiveAlerts.tsx` — toasts d'alertes temps réel (bans, attaques) via `react-hot-toast`, position/activation pilotées par `liveAlertsStore`
- `NotificationCenter.tsx` — panneau de notifications persistantes
- `GlobalAddAgentModal.tsx` — modale d'ajout d'agent accessible depuis n'importe quelle page
- `DesktopUpdateBanner.tsx` — bannière de mise à jour pour l'app tray desktop

Autres dossiers de composants métier : `components/agent/`, `components/groups/`, `components/mikrotik/`, `components/monitors/`, `components/notifications/`, `components/remediation/`, `components/settings/`, `components/maintenance/`, `components/common/` (composants UI génériques réutilisés par plusieurs pages).

## i18n

`client/src/i18n/` charge `i18next` + `react-i18next` avec 18 langues (`locales/*.json`, ~874 clés chacune : en, fr, de, es, pt, it, nl, pl, cs, ro, ru, uk, zh, ja, ko, ar, tr, he). La langue est appliquée au login via `setLanguage()` dans `authStore.syncPreferencesToStore()`, à partir de `user.preferredLanguage`.

## Thème et style

`client/src/index.css` + Tailwind CSS pilotent le style. `client/src/utils/theme.ts` expose `initTheme()` (appelé de façon synchrone en tête de `App.tsx`, avant le rendu React, pour éviter un flash de contenu non stylé) et `applyTheme()` (appelé lors de la synchronisation des préférences utilisateur).
