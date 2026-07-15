## Vue d'ensemble

Obliguard est un monorepo npm workspaces regroupant quatre parties : un package TypeScript partagé (`shared/`), un serveur Node.js/Express (`server/`), un client React/Vite (`client/`) et un agent réseau écrit en Go (`agent/`). Une application de tray desktop Go (`desktop-app/`) complète l'écosystème mais vit dans un dépôt séparé (elle n'est pas incluse dans les workspaces npm).

Le fichier racine `package.json` déclare les workspaces :

```json
"workspaces": [
  "shared",
  "server",
  "client",
  "agent"
]
```

`agent` figure dans la liste des workspaces npm uniquement pour la cohérence de tooling (scripts, CI) — le code Go lui-même est géré par `agent/go.mod` (module `github.com/obliguard/agent`, Go 1.22) et n'a aucune dépendance vers les packages npm.

Le build global orchestré depuis la racine :

```json
"build": "npm run build:shared && npm run build:server && npm run build:client"
```

L'ordre est important : `shared/` doit être compilé avant `server/` et `client/`, car les deux consomment son `dist/`.

## `shared/` — types et constantes partagés

`shared/` est un package TypeScript pur (`@obliview/shared`, `shared/package.json`) compilé via `tsc` (pas de bundler). Son `main`/`types` pointent vers `dist/index.js` / `dist/index.d.ts` :

```json
"main": "dist/index.js",
"types": "dist/index.d.ts",
"scripts": {
  "build": "tsc",
  "dev": "tsc --watch"
}
```

Le point d'entrée `shared/src/index.ts` ré-exporte tous les modules du package :

```ts
export * from './types';
export * from './tenants';
export * from './monitorTypes';
export * from './socketEvents';
export * from './settingsDefaults';
export * from './sensorLabels';
```

Contenu typique : types de domaine (`types.ts`), types multi-tenant (`tenants.ts`), types liés au monitoring/agents (`monitorTypes.ts`), noms d'événements Socket.io partagés entre client et serveur (`socketEvents.ts`), valeurs par défaut de configuration (`settingsDefaults.ts`) et libellés de capteurs/services (`sensorLabels.ts`). Ce package est la source de vérité unique pour tout ce qui doit rester identique entre le back-end et le front-end (formes des payloads WebSocket, enums de statut, constantes de tenant, etc.), évitant la duplication de définitions.

**Commande de compilation** : `cd shared && npx tsc` — nécessaire avant tout démarrage de `server/` en environnement de développement, car le serveur ne compile pas `shared/` lui-même, il consomme ses artefacts déjà construits dans `shared/dist/`.

## Comment `server/` consomme `shared/`

`server/package.json` déclare la dépendance en workspace :

```json
"dependencies": {
  "@obliview/shared": "*",
  ...
}
```

npm workspaces crée un symlink `server/node_modules/@obliview/shared -> ../../shared` à l'installation. Le `server/tsconfig.json` ne définit **aucun** alias `paths` pour `@obliview/shared` :

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    ...
  },
  "include": ["src/**/*", "knexfile.ts"]
}
```

La résolution passe donc par le mécanisme Node.js standard : `import { ... } from '@obliview/shared'` résout via le symlink vers `shared/package.json` → `main`/`types` → `shared/dist/`. Conséquence directe : si `shared/dist/` n'est pas à jour (package non recompilé après une modification de `shared/src/`), le serveur compile ou tourne contre une version obsolète des types/constantes partagés sans erreur visible immédiate.

Le serveur est démarré en développement via `tsx` (`"dev": "tsx watch src/index.ts"`) et non `ts-node`, car `ts-node` invoqué via `npx` ne retrouve pas les fichiers `.d.ts` personnalisés du projet. La configuration d'environnement est chargée par `server/src/env.ts` :

```ts
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
```

Ce module est importé en tout premier dans `server/src/index.ts` (`import './env'`) et dans `server/knexfile.ts` (`import './src/env'`), garantissant que `process.env` est peuplé avant toute autre initialisation (connexion PostgreSQL, config Knex, etc.).

## Comment `client/` consomme `shared/`

Le client ne passe pas par la résolution Node.js/symlink de la même façon : Vite bundle le code, donc l'alias doit être déclaré explicitement à deux endroits cohérents.

`client/tsconfig.json` (pour la vérification de types) :

```json
"paths": {
  "@/*": ["./src/*"],
  "@obliview/shared": ["../shared/src"]
}
```

`client/vite.config.ts` (pour la résolution au build/dev) :

```ts
resolve: {
  alias: {
    '@': path.resolve(__dirname, './src'),
    '@obliview/shared': path.resolve(__dirname, '../shared/src'),
  },
},
```

Point notable : contrairement au serveur, le client pointe l'alias directement vers `shared/src` (le TypeScript source), pas vers `shared/dist`. Vite transpile ces fichiers à la volée dans son propre pipeline de bundling — il n'y a donc pas besoin d'avoir exécuté `npx tsc` dans `shared/` au préalable pour que le client fonctionne en dev, contrairement au serveur.

Le build du client (`"build": "tsc -b && vite build"`) exécute d'abord une vérification de types en mode projet composite (`tsc -b`) puis le bundling Vite. `client/vite.config.ts` proxifie également `/api` et `/socket.io` vers `http://localhost:3001` en dev, pour taper directement sur le serveur Express local sans configuration CORS supplémentaire.

## `server/` — structure

Package `@obliview/server`, point d'entrée compilé `dist/src/index.js`. Stack : Express, Knex (PostgreSQL), Socket.io, `ws` (WebSocket brut pour le hub agents), `express-session` + `connect-pg-simple`, `bcrypt`, `otpauth` (TOTP), `nodemailer`, `helmet`, `express-rate-limit`.

Scripts clés (`server/package.json`) :

```json
"dev": "tsx watch src/index.ts",
"build": "tsc",
"start": "node dist/src/index.js",
"migrate": "knex migrate:latest --knexfile knexfile.ts"
```

`server/src/index.ts` orchestre au démarrage : exécution des migrations Knex en attente, création de l'app Express (`createApp`), création du serveur Socket.io (`createSocketServer`), câblage des services (`agentService`, `banEngine`, `obliguardHub`, `obligateService`) et upgrade WebSocket manuel pour le hub d'agents (via `WebSocketServer` de la librairie `ws`, distinct du canal Socket.io utilisé pour le temps réel côté navigateur).

## `client/` — structure

Package `@obliview/client`. Stack : React 18, React Router, Zustand (state), Tailwind CSS, i18next/react-i18next, Recharts (graphiques 2D), Three.js (NetMap 3D, lazy-loaded en chunk séparé), Socket.io-client, axios, `@dnd-kit` (drag & drop), `lucide-react` (icônes).

`client/vite.config.ts` injecte la version du package dans le bundle via `define` :

```ts
const { version: clientVersion } = JSON.parse(
  readFileSync(path.resolve(__dirname, './package.json'), 'utf-8'),
);
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(clientVersion) },
  ...
});
```

Cette constante `__APP_VERSION__` est utilisable telle quelle dans le code React (typée globalement) pour afficher la version courante dans l'UI sans appel réseau.

## `agent/` — binaire Go multiplateforme

`agent/` est un module Go indépendant (`go.mod` : `github.com/obliguard/agent`, Go 1.22), compilé en binaire natif (Windows/Linux/macOS/FreeBSD). Il ne dépend d'aucun package npm et communique avec `server/` uniquement via HTTP (push initial, `push.go`) et WebSocket (`cmd_ws.go`).

Organisation par responsabilité, avec fichiers à suffixe de plateforme (`_windows.go`, `_linux.go`, `_darwin.go`, `_freebsd.go`, `_stub.go`) pour le code spécifique à l'OS :

- `main.go` — configuration, flags CLI, UUID matériel, boucle principale
- `cmd_ws.go` — boucle de session WebSocket, heartbeat/flush d'événements
- `services.go` — détection automatique des services par scan de ports
- `logwatcher.go` — suivi (tail) des logs, extraction d'événements par regex
- `firewall.go` — application des bans au niveau pare-feu (nftables/firewalld/ufw/iptables, netsh, pf)
- `firewall_rules.go` + `firewall_rules_{windows,linux,darwin,freebsd}.go` — gestion des règles pare-feu par plateforme
- `uninstall.go`, `logpaths.go`, `osinfo.go`, `machine_uuid*.go`

Scripts de build par plateforme à la racine du dossier : `build.sh`, `build-linux.sh`, `build-mac.sh`, `build-msi.bat` (installeur MSI Windows via WiX), `build-wizard.bat`/`build-wizard-linux.bat`. `agent/installer/` contient les sources WiX pour le paquet MSI Windows.

## `desktop-app/` — application tray Go

Application tray Windows/macOS avec auto-update, documentée dans `CLAUDE.md` comme faisant partie de l'écosystème Obliguard. Elle n'est pas présente dans ce dépôt (`D:\Obliguard`) au moment de la rédaction de cette page — probablement gérée dans un dépôt séparé — et n'apparaît donc ni dans les workspaces npm racine ni comme module Go voisin de `agent/`. À vérifier/documenter séparément si le dépôt correspondant est mis à disposition.

## Docker

Plusieurs fichiers `docker-compose*.yml` à la racine : `docker-compose.yml` (production), `docker-compose.build.yml` (build local), `docker-compose.dev.yml` (overlay dev, utilisé via `npm run dev`), `docker-compose.external-db.yml` (PostgreSQL externe mutualisé). Chaque instance Obliguard tourne sur son propre réseau Docker `obli*_default` ; une base PostgreSQL partagée est attachée individuellement à chaque réseau plutôt que via un réseau `obli_private` unique, pour éviter les conflits de résolution DNS entre plusieurs hôtes nommés `server`.

## Points d'attention pour le développement local

- Toujours recompiler `shared/` (`cd shared && npx tsc`) après une modification de ses sources avant de relancer `server/` — le client, lui, lit `shared/src` directement via Vite et n'a pas ce problème.
- Sous Windows, Node.js est installé dans `C:\Program Files\nodejs\` ; en shell bash, préfixer les commandes avec `PATH="/c/Program Files/nodejs:$PATH"`.
- Toujours tuer l'ancien process serveur avant redémarrage (le port 3001 reste occupé sinon, `EADDRINUSE`).
- Utiliser `npx tsx` plutôt que `ts-node` pour exécuter le serveur en TypeScript direct.
