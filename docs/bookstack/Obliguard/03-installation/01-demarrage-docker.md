## Fichiers Docker Compose disponibles

Le dépôt racine (`D:\Obliguard`) contient plusieurs fichiers compose, chacun pour un scénario de déploiement différent :

| Fichier | Usage |
|---------|-------|
| `docker-compose.yml` | Déploiement standard, images publiées (`meejay/obliguard-server`, `meejay/obliguard-client`), PostgreSQL embarqué dans un conteneur |
| `docker-compose.external-db.yml` | Même chose, mais sans conteneur PostgreSQL — se connecte à une base déjà existante (ex. Unraid, serveur PostgreSQL partagé) |
| `docker-compose.build.yml` | Build local des images depuis les Dockerfiles (`server/Dockerfile`, `client/Dockerfile`) au lieu de tirer les images Docker Hub |
| `docker-compose.dev.yml` | Overlay de développement — build target `builder`, hot-reload (`npx tsx watch`, `npx vite --host`), montage des sources en volumes, port Vite `5173` exposé |

Le fichier `install.sh` à la racine automatise le cas standard : il crée un dossier d'installation, télécharge `docker-compose.yml` et `.env.example`, génère des secrets aléatoires, puis lance `docker compose pull && docker compose up -d`.

## Démarrage rapide

Cas le plus courant : PostgreSQL embarqué, images publiées.

```bash
cd D:\Obliguard
cp .env.example .env   # sur Windows : copy .env.example .env
# éditer .env : au minimum DB_PASSWORD et SESSION_SECRET
docker compose up -d
```

`docker-compose.yml` définit trois services :

- **`postgres`** — image `postgres:16-alpine`, healthcheck `pg_isready -U obliguard` (intervalle 5 s, 10 tentatives, `start_period` 60 s). Les données persistent dans le volume nommé `postgres_data`.
- **`server`** — image `meejay/obliguard-server:${OBLIGUARD_VERSION:-latest}`, attend que `postgres` soit `service_healthy` avant de démarrer, écoute sur le port interne `3001`. Monte `${CUSTOM_DIR:-./custom}` sur `/custom` (scripts personnalisés, clés SSH pour les intégrations distantes — voir permissions `chmod 700 custom/.ssh` et `chmod 600 custom/.ssh/id_*`).
- **`client`** — image `meejay/obliguard-client:${OBLIGUARD_VERSION:-latest}`, attend que `server` soit `service_healthy`, publie le port `${LISTEN_PORT:-3001}` sur le port `80` du conteneur (reverse proxy nginx qui sert le build React et relaie l'API/WS vers `server`).

Une fois `docker compose up -d` terminé, l'interface est accessible sur `http://localhost:${LISTEN_PORT}` (port `3001` par défaut si `LISTEN_PORT` n'est pas fixé dans `.env`), avec le compte admin par défaut :

```
Utilisateur : admin
Mot de passe : admin123
```

À changer immédiatement après la première connexion (`ProfilePage.tsx`).

## Variables d'environnement minimales

Le fichier `.env.example` (racine du dépôt) liste toutes les variables consommées par `docker-compose.yml`. Pour un premier démarrage, seules celles-ci comptent réellement :

| Variable | Rôle | Défaut si absente |
|----------|------|--------------------|
| `DB_PASSWORD` | Mot de passe du rôle `obliguard` dans le conteneur `postgres` intégré | `changeme` — **à changer en production** |
| `SESSION_SECRET` | Clé de signature des sessions Express | `change-this-in-production` — **à changer, sinon les sessions ne sont pas sûres** |
| `CLIENT_ORIGIN` | Origine autorisée pour le CORS (doit correspondre à l'URL réellement utilisée par le navigateur) | `http://localhost` |
| `LISTEN_PORT` | Port hôte publié pour le client (nginx) | `3001` |
| `DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD` | Compte admin créé au premier démarrage si la base est vide | `admin` / `admin123` |
| `OBLIGUARD_VERSION` | Tag d'image Docker Hub à tirer (`latest`, `dev`, ou un numéro de version précis) | `latest` |
| `CUSTOM_DIR` | Répertoire hôte monté sur `/custom` dans le conteneur `server` (scripts, clés SSH — persiste entre les mises à jour) | `./custom` |

Ces variables sont lues côté serveur par `server/src/env.ts`, qui charge `dotenv.config()` en tout premier — avant `index.ts` et `knexfile.ts` — pour garantir que `DATABASE_URL`/`SESSION_SECRET` sont disponibles avant toute connexion à la base ou tout `require` de configuration.

`DATABASE_URL` n'est **pas** à fixer manuellement dans le cas standard : `docker-compose.yml` la construit automatiquement à partir de `DB_PASSWORD` :

```
DATABASE_URL=postgres://obliguard:${DB_PASSWORD:-changeme}@postgres:5432/obliguard
```

Elle ne devient une variable à définir explicitement que dans le scénario PostgreSQL externe (voir plus bas).

## Réseau Docker et PostgreSQL partagé

Chaque instance Obliguard déployée avec `docker compose up -d` reçoit automatiquement un réseau Docker dédié nommé `<nom-du-projet>_default` (le nom du projet est celui du dossier contenant le `docker-compose.yml`, ou celui fixé via `COMPOSE_PROJECT_NAME`). Les trois services (`postgres`, `server`, `client`) communiquent entre eux sur ce réseau via leurs noms de service comme hostnames DNS internes — c'est pourquoi `DATABASE_URL` référence l'hôte `postgres` et non une IP ou `localhost`.

Point d'architecture à connaître si vous exploitez **plusieurs instances Obliguard** (ou plusieurs applications de l'écosystème `obli.tools`) sur la même machine, partageant un seul serveur PostgreSQL :

- Ne mettez **pas** toutes les instances sur un unique réseau partagé (type `obli_private`) : chaque `docker-compose.yml` déclare un service nommé `server`, et un réseau partagé entre plusieurs instances provoquerait des collisions de résolution DNS (plusieurs conteneurs répondant au nom `server`).
- La bonne pratique est de laisser chaque instance sur son propre réseau `obli*_default` isolé, puis d'attacher le conteneur PostgreSQL partagé à *chacun* de ces réseaux :

```bash
docker network connect obliguard1_default postgres-partage
docker network connect obliguard2_default postgres-partage
```

- Dans ce cas, utilisez `docker-compose.external-db.yml` (pas de service `postgres` local) et fixez explicitement dans `.env` :

```
DATABASE_URL=postgres://obliguard:<motdepasse>@postgres-partage:5432/obliguard
SESSION_SECRET=<chaîne aléatoire propre à cette instance>
```

  chaque instance garde son propre nom d'utilisateur/base logique côté PostgreSQL, mais toutes partagent le même conteneur serveur.
- Côté pool de connexions, `server/knexfile.ts` fixe `pool.max` à `10` par défaut (surchageable via `DATABASE_POOL_MAX`) et un `acquireTimeoutMillis` de `20000` ms — volontairement modeste, car un PostgreSQL partagé entre plusieurs instances `obli*` doit répartir un nombre de connexions limité.

## Exposer PostgreSQL en dehors du conteneur

Par défaut, le port `5432` du conteneur `postgres` n'est **pas** publié sur l'hôte (section `ports` commentée dans `docker-compose.yml`). Pour lancer des migrations depuis votre poste ou brancher pgAdmin, décommentez :

```yaml
  postgres:
    ports:
      - "5432:5432"
```

C'est déjà le comportement de `docker-compose.dev.yml`, qui publie `5432:5432` en plus d'ajouter le hot-reload serveur/client et le port Vite `5173`.

## Vérifier le démarrage et gérer l'instance

```bash
docker compose logs -f              # suivre les logs des 3 services
docker compose ps                   # état / healthcheck de chaque conteneur
docker compose pull && docker compose up -d   # mettre à jour vers la dernière image
docker compose down                 # arrêter (les volumes, dont postgres_data, sont conservés)
```

Le `server` ne démarre qu'une fois `postgres` marqué `service_healthy`, et le `client` qu'une fois `server` marqué `service_healthy` (`depends_on: condition: service_healthy`) — un ordre de démarrage propre est donc garanti sans script d'attente supplémentaire.
