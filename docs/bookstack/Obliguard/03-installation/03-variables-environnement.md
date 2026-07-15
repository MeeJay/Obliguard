## Où sont lues les variables

Le serveur charge le fichier `.env` via `dotenv` dans `server/src/env.ts` :

```ts
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
```

Ce module est importé en tout premier dans `server/src/index.ts` et dans `server/knexfile.ts`, avant tout autre import, pour garantir que `process.env` est peuplé avant que Knex ou Express ne lisent leur configuration.

Les valeurs par défaut applicatives (utilisées si la variable n'est pas définie) sont centralisées dans `server/src/config.ts`. Certaines variables plus ponctuelles sont lues directement via `process.env` à l'endroit où elles servent (`server/src/index.ts`, `server/src/services/settings.service.ts`, `server/src/validators/monitor.schema.ts`).

En déploiement Docker (recommandé), les variables sont injectées par `docker-compose.yml` / `docker-compose.external-db.yml` / `docker-compose.dev.yml` à partir d'un fichier `.env` placé à la racine du dépôt, calqué sur `.env.example`.

## Tableau de référence

| Variable | Défaut | Défini dans | Description |
|---|---|---|---|
| `OBLIGUARD_VERSION` | `latest` | `docker-compose.yml` | Tag Docker Hub des images `meejay/obliguard-server` et `meejay/obliguard-client` à tirer. |
| `DB_PASSWORD` | `changeme` | `docker-compose.yml` | Mot de passe PostgreSQL, utilisé à la fois pour créer le conteneur `postgres` (`POSTGRES_PASSWORD`) et pour construire la `DATABASE_URL` du serveur. |
| `DATABASE_URL` | `postgres://obliview:changeme@localhost:5432/obliview` | `server/src/config.ts`, `server/knexfile.ts` | Chaîne de connexion PostgreSQL complète (`postgres://user:pass@host:port/db`). En Docker standard elle est construite automatiquement à partir de `DB_PASSWORD` ; avec `docker-compose.external-db.yml` elle doit être fournie explicitement (base externe, ex. Unraid). |
| `DATABASE_POOL_MAX` | `10` | `server/knexfile.ts` | Taille max du pool de connexions Knex. À ajuster à la hausse uniquement si une instance est très chargée — un PostgreSQL partagé entre plusieurs instances Obli* a un plafond global de connexions. |
| `NODE_ENV` | `development` | `server/src/config.ts` | `production` ou `development`. Piloté `isDev` (active des comportements de dev, ex. hot-reload côté client). |
| `PORT` | `3001` | `server/src/config.ts` | Port d'écoute HTTP interne du serveur Express (dans le conteneur). |
| `LISTEN_PORT` | `3001` (`3002` avec `external-db`) | `docker-compose.yml` | Port publié sur l'hôte pour le conteneur `client` (reverse proxy nginx qui sert le front et proxifie l'API). C'est le port réellement exposé sur le LAN. |
| `SESSION_SECRET` | `dev-secret-change-me` | `server/src/config.ts` | Secret de signature des cookies de session Express. **À changer obligatoirement en production** — sinon les sessions peuvent être forgées. |
| `CLIENT_ORIGIN` | `http://localhost:5173` | `server/src/config.ts` | Origine autorisée pour CORS et pour les cookies (doit correspondre à l'URL réellement utilisée par les navigateurs pour accéder à l'interface). |
| `FORCE_HTTPS` | `false` | `server/src/config.ts` | Si `true`, force les cookies `secure` / redirections HTTPS — à activer quand l'instance est derrière un reverse proxy TLS (Nginx Proxy Manager, Traefik, Caddy...). |
| `APP_NAME` | `Obliview` | `server/src/config.ts` | Préfixe utilisé dans les notifications (Telegram, Discord, emails, etc.) et l'UI pour identifier l'instance émettrice. |
| `DEFAULT_ADMIN_USERNAME` | `admin` | `server/src/config.ts` | Nom d'utilisateur du compte administrateur créé automatiquement au premier démarrage (base vide). |
| `DEFAULT_ADMIN_PASSWORD` | `admin123` | `server/src/config.ts` | Mot de passe initial du compte admin. **À changer** dès la première connexion — non appliqué automatiquement au redémarrage si le compte existe déjà. |
| `DISABLE_2FA_FORCE` | `false` | `server/src/config.ts` | Si `true`, désactive l'obligation d'activer la 2FA qui peut être imposée par la politique du tenant. Utile en environnement de test. |
| `APP_URL` | `http://localhost:5173` | `server/src/config.ts` | URL publique de l'application, insérée dans les emails (lien de réinitialisation de mot de passe, notifications SMTP). |
| `MIN_CHECK_INTERVAL` | `10` (secondes) | `server/src/services/settings.service.ts`, `server/src/validators/monitor.schema.ts` | Politique admin : intervalle minimal autorisé entre deux vérifications d'un agent (`checkIntervalSeconds`), pour éviter qu'un tenant ne configure un polling trop agressif. |
| `MIN_RETRY_INTERVAL` | `5` (secondes) | `server/src/services/settings.service.ts`, `server/src/validators/monitor.schema.ts` | Politique admin : intervalle minimal de nouvelle tentative en cas d'échec de contact agent. |
| `IP_EVENTS_RETENTION_DAYS` | `90` | `server/src/index.ts` | Durée de rétention (en jours) des événements bruts `ip_events` (tentatives d'authentification) avant purge automatique par le job de nettoyage périodique. |
| `CUSTOM_DIR` | `./custom` | `docker-compose.yml` | Chemin hôte monté dans le conteneur serveur sur `/custom` — persiste entre les mises à jour d'image. Sert à stocker scripts personnalisés et clés SSH (utilisées par certains plugins/agents). Exemple Unraid : `/mnt/user/appdata/obliguard/custom`. |
| `VITE_API_URL` | — | `docker-compose.dev.yml`, `client/vite.config.ts` | Utilisé uniquement en dev local (hors Docker/hors build) pour pointer le client Vite vers l'URL de l'API du serveur. |

## Variables absentes du `.env` — configurées en base de données

Certains réglages qu'on pourrait s'attendre à trouver en variables d'environnement sont en réalité gérés depuis l'interface (table `app_config`, service `appConfigService`) et persistés en base, pas dans `.env` :

- **Clé API obli.tools** (`oblitools_api_key`) : lue par `remoteBlocklist.service.ts` (`appConfigService.get('oblitools_api_key')`) pour authentifier le push d'auto-bans vers `https://guard.obli.tools/blocklist/api/push` (endpoint `Authorization: Bearer <apiKey>`). Se configure depuis **Paramètres → Remote blocklists / obli.tools**.
- **Serveurs SMTP** : stockés dans la table `smtp_servers` et gérés via `/admin/smtp-servers`, pas via des variables `SMTP_HOST` / `SMTP_USER` etc.
- **Blocklists distantes personnalisées** (URL, activation) : table dédiée, gérée via `/remote-blocklists`.

Cette séparation est volontaire : ce sont des réglages multi-tenant modifiables à chaud depuis l'UI, alors que les variables `.env` couvrent uniquement le bootstrap bas niveau (connexion DB, secrets de session, ports).

## Exemple de `.env` minimal (production, stack Docker fournie)

```env
OBLIGUARD_VERSION=latest
DB_PASSWORD=un-mot-de-passe-fort
SESSION_SECRET=une-chaine-aleatoire-longue
CLIENT_ORIGIN=https://obliguard.example.com
LISTEN_PORT=3001
APP_NAME=Obliguard
DEFAULT_ADMIN_USERNAME=admin
DEFAULT_ADMIN_PASSWORD=change-moi-immediatement
CUSTOM_DIR=./custom
```

## Exemple avec base PostgreSQL externe (`docker-compose.external-db.yml`)

```env
DATABASE_URL=postgres://obliguard:motdepasse@10.0.0.5:5432/obliguard
SESSION_SECRET=une-chaine-aleatoire-longue
CLIENT_ORIGIN=https://obliguard.example.com
LISTEN_PORT=3002
```

Dans ce mode, `DB_PASSWORD` et le service `postgres` du compose standard ne sont pas utilisés — la responsabilité de créer la base `obliguard` et l'utilisateur associé revient à l'administrateur.
