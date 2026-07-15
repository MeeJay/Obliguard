Ce guide décrit le workflow pour faire tourner Obliguard en local (hors Docker), avec rechargement à chaud du serveur et du client. Le monorepo utilise des **npm workspaces** (`shared/`, `server/`, `client/`, `agent/` déclarés dans le `package.json` racine), ce qui impose un ordre de compilation précis.

## Pré-requis

- Node.js 24 LTS
- PostgreSQL accessible (voir la page Installation Docker ou une instance locale), avec `DATABASE_URL` renseignée dans `server/.env`
- Sur Windows, Node.js est installé dans `C:\Program Files\nodejs\` — si le shell (Git Bash / WSL) ne le trouve pas nativement, préfixer les commandes :

```bash
PATH="/c/Program Files/nodejs:$PATH" npx tsc
```

## 1. Compiler `shared/` avant tout

`server/` dépend du package `@obliview/shared` (`server/package.json` référence `"@obliview/shared": "*"`, résolu via le symlink du workspace npm vers `shared/dist/`). Le `tsconfig.json` du serveur ne définit **aucun** `paths` pour ce package — c'est le node_modules symlinké qui fait le lien, donc `shared/dist/` doit exister et être à jour avant de démarrer le serveur, sinon les imports `@obliview/shared` échouent.

```bash
cd shared
npx tsc
```

`shared/package.json` définit aussi un mode watch (`npm run dev` → `tsc --watch`) pratique si vous modifiez souvent des types partagés (DTOs, enums) pendant que le serveur tourne :

```bash
cd shared
npm run dev
```

Le client, lui, n'a pas besoin de ce build : `client/vite.config.ts` alias `@obliview/shared` directement vers `../shared/src` (pas `dist/`), donc Vite transpile les sources TypeScript partagées à la volée.

## 2. Lancer le serveur avec `npx tsx` (pas `ts-node`)

Le script `dev` du serveur (`server/package.json`) utilise `tsx watch` :

```json
"dev": "tsx watch src/index.ts"
```

Pour un lancement ponctuel sans watch, ou en dehors de `npm run dev` :

```bash
cd server
npx tsx src/index.ts
```

**Ne pas utiliser `ts-node`** : invoqué via `npx`, il ne résout pas les fichiers `.d.ts` custom du projet (types Express étendus, etc.), ce qui casse la compilation à la volée. `tsx` (basé sur esbuild) n'a pas ce problème.

Le chargement des variables d'environnement se fait via `server/src/env.ts`, importé en tout premier dans `src/index.ts` et dans `knexfile.ts` :

```ts
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
```

Vérifiez donc que le fichier `.env` existe bien au bon niveau (racine du package `server/`, au chemin `../../.env` relatif à `src/`) avant de démarrer, sinon `DATABASE_URL` et les autres variables ne seront pas chargées et le serveur retombera sur les valeurs par défaut de `server/knexfile.ts` (`postgres://obliview:changeme@localhost:5432/obliview`).

### Migrations avant premier démarrage

```bash
cd server
npx knex migrate:latest --knexfile knexfile.ts
```

(équivalent au script `npm run migrate`). Les 20 migrations sont dans `server/src/db/migrations/`.

## 3. Tuer le process existant avant de relancer (EADDRINUSE :3001)

Le serveur écoute sur le port **3001**. Si un process précédent tourne encore (crash du watcher, terminal fermé sans SIGTERM propre, etc.), le redémarrage échoue avec `EADDRINUSE`. Sous Windows, identifier et tuer le process avant de relancer :

```powershell
# Trouver le PID qui écoute sur 3001
Get-NetTCPConnection -LocalPort 3001 -State Listen | Select-Object -ExpandProperty OwningProcess

# Tuer le process
Stop-Process -Id <PID> -Force
```

En Git Bash :

```bash
netstat -ano | grep 3001
taskkill //PID <PID> //F
```

`tsx watch` relance normalement le process automatiquement à chaque sauvegarde de fichier, mais si le port reste occupé (process zombie, ou plusieurs terminaux avec `npm run dev` lancés en parallèle), c'est le symptôme classique à vérifier en premier.

## 4. Lancer le client Vite

```bash
cd client
npm run dev
```

Le client démarre sur le port **5173** par défaut (`process.env.PORT` sinon, cf. `client/vite.config.ts`). Vite proxifie automatiquement vers le serveur backend sur `localhost:3001` :

```ts
server: {
  port: process.env.PORT ? parseInt(process.env.PORT) : 5173,
  proxy: {
    '/api': { target: 'http://localhost:3001', changeOrigin: true },
    '/socket.io': { target: 'http://localhost:3001', ws: true },
  },
},
```

Donc pas besoin de configurer de CORS manuel en dev : toute requête `/api/*` et la connexion `/socket.io` (WebSocket Socket.io, utilisé notamment pour `AGENT_STATUS_CHANGED` et les alertes live) sont relayées vers le serveur.

## Récapitulatif — ordre de démarrage complet

```bash
# 1. Compiler le package partagé
cd shared && npx tsc

# 2. (si nécessaire) tuer un serveur existant sur le port 3001
# voir section 3 ci-dessus

# 3. Lancer le serveur en watch mode
cd server && npm run dev

# 4. Dans un autre terminal, lancer le client
cd client && npm run dev
```

Le raccourci racine `npm run dev:server` et `npm run dev:client` (définis dans le `package.json` racine) font respectivement `cd server && npm run dev` et `cd client && npm run dev`, sans lancer `shared/` — il faut donc compiler `shared/` manuellement au moins une fois avant.

Le raccourci `npm run dev` à la racine lance en revanche tout l'environnement via Docker Compose (`docker-compose.build.yml` + `docker-compose.dev.yml`) — à ne pas confondre avec le workflow local décrit ici.

## Erreurs fréquentes

| Symptôme | Cause probable | Solution |
|---|---|---|
| `Cannot find module '@obliview/shared'` au démarrage du serveur | `shared/dist/` absent ou périmé | `cd shared && npx tsc` |
| `EADDRINUSE: address already in use :::3001` | Ancien process serveur encore actif | Tuer le PID qui écoute sur 3001 (voir section 3) |
| Types custom (`.d.ts`) non reconnus, erreurs TS bizarres au runtime | Utilisation de `ts-node` au lieu de `tsx` | Toujours utiliser `npx tsx` |
| Variables d'env (`DATABASE_URL`, etc.) non prises en compte | `.env` absent au chemin `server/.env` ou `env.ts` non importé en premier | Vérifier l'emplacement du `.env` et l'ordre d'import dans `index.ts` / `knexfile.ts` |
| Le client ne trouve pas l'API en dev | Serveur backend non démarré sur le port 3001, ou proxy Vite mal configuré | Vérifier `client/vite.config.ts` et que le serveur tourne bien sur 3001 |
