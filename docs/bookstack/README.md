# Documentation Obliguard pour BookStack

Ce dossier contient la documentation complète du projet **Obliguard**, prête à être
publiée dans **BookStack**, dans l'étagère **ObliTools**.

La documentation est structurée exactement selon la hiérarchie BookStack :

```
Étagère : ObliTools
└── Livre : Obliguard
    ├── Chapitre  → Page(s) Markdown
    └── …
```

## Contenu du dossier

| Fichier / dossier          | Rôle                                                                    |
|-----------------------------|--------------------------------------------------------------------------|
| `Obliguard/`                | Les pages Markdown, un sous-dossier par chapitre, un fichier par page   |
| `manifest.json`             | Arborescence étagère → livre → chapitres → pages (ordre + titres)       |
| `push-to-bookstack.mjs`     | Script de publication **idempotent** via l'API BookStack                |
| `README.md`                 | Ce fichier                                                               |

> Les fichiers `.md` ne contiennent volontairement **pas** de titre de niveau 1 :
> le nom de la page dans BookStack (défini dans `manifest.json`) fait office de titre.

## Plan de la documentation

Le livre **Obliguard** est organisé en 17 chapitres :

1. **Présentation** — vue d'ensemble, concepts clés, panorama fonctionnel
2. **Architecture technique** — stack & monorepo, architecture serveur, architecture client, architecture de l'agent Go
3. **Installation & configuration** — Docker, dev local, variables d'environnement, build agent/desktop
4. **Moteur de bans (Ban Engine)** — cycle d'évaluation & auto-ban, scoping & types, TTL/exclusions/notifications
5. **Hub WebSocket agent** — protocole & heartbeat, détection hors ligne, commandes & pushAndWait
6. **Agent Go** — détection de services & logwatcher, pare-feu multiplateforme, auto-update, gestion des règles pare-feu
7. **Templates de services** — parsers intégrés & regex custom, seuils/modes/assignation hiérarchique
8. **Listes de blocage distantes** — remote blocklists & guard.obli.tools
9. **Réputation IP** — agrégation & GeoIP, statuts & soft-delete
10. **Whitelist & étiquettes IP** — whitelist CIDR & scoping, noms d'affichage IP
11. **NetMap** — NetMap 2D, NetMap 3D
12. **Multi-tenant & permissions** — tenants & groupes hiérarchiques, RBAC & héritage des paramètres
13. **Notifications** — les 10 plugins de notification
14. **Modèle de données** — vue d'ensemble des 20 migrations, tables clés
15. **Référence API** — routes IPs/bans/templates, routes agent & pare-feu, routes admin/auth/tenants
16. **Internationalisation** — i18next, 18 langues
17. **État & feuille de route** — fonctionnalités & état actuel

Le détail exact (titres et ordre des pages) fait foi dans `manifest.json`.

## Publier dans BookStack (recommandé — via l'API)

1. Dans BookStack, crée un **jeton d'API** : *Profil utilisateur → Jetons d'API →
   Créer un jeton*. Note l'**identifiant** et le **secret**. Le compte doit avoir le
   droit de créer étagères / livres / chapitres / pages.
2. Renseigne les variables d'environnement et lance le script (Node 18+) :

   **PowerShell**
   ```powershell
   $env:BOOKSTACK_URL      = 'https://wiki.mondomaine.fr'
   $env:BOOKSTACK_TOKEN_ID = 'votre_token_id'
   $env:BOOKSTACK_TOKEN_SECRET = 'votre_token_secret'
   node .\push-to-bookstack.mjs --dry-run   # simulation d'abord
   node .\push-to-bookstack.mjs             # publication réelle
   ```

   **bash**
   ```bash
   BOOKSTACK_URL=https://wiki.mondomaine.fr \
   BOOKSTACK_TOKEN_ID=votre_token_id \
   BOOKSTACK_TOKEN_SECRET=votre_token_secret \
   node push-to-bookstack.mjs
   ```

Le script est **idempotent** : il crée l'étagère, le livre, les chapitres et les
pages s'ils n'existent pas, et met à jour titres/contenus/ordre à chaque exécution
(correspondance **par nom**). Aucun doublon n'est créé si on le relance.

> L'étagère **ObliTools** est partagée avec les autres outils de la suite
> (Obligate, Obliplan, …). Le script ne fait qu'**ajouter** le livre Obliguard à la
> liste existante des livres de l'étagère (fusion, jamais d'écrasement) — les
> autres livres déjà présents restent intacts.

## Publier manuellement (sans API)

Dans BookStack : crée l'étagère **ObliTools** (si elle n'existe pas déjà), puis un
livre **Obliguard**, puis un chapitre par entrée du plan ci-dessus, et pour chaque
page utilise l'éditeur en mode **Markdown** en collant le contenu du fichier `.md`
correspondant (le nom de la page est donné par `manifest.json`).

---

*Documentation générée à partir du code source (`D:\Obliguard`). Pour la régénérer
après une évolution du code, relancer la génération puis republier avec le script.*
