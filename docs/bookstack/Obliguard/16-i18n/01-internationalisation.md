## Vue d'ensemble

Le client React d'Obliguard est entièrement internationalisé via **i18next** / **react-i18next**. Toutes les chaînes de l'interface (labels, messages d'erreur, formulaires, pages d'administration, wizard d'enrôlement) passent par le hook `useTranslation()` et la fonction `t()` — aucune chaîne n'est codée en dur dans le JSX des pages listées ci-dessous.

La configuration vit dans `client/src/i18n/index.ts`, et les dictionnaires de traduction dans `client/src/i18n/locales/<code>/translation.json`.

## Langues supportées

18 langues sont déclarées dans `SUPPORTED_LANGUAGES` (`client/src/i18n/index.ts`) :

| Code | Langue | Nom natif | Sens |
|------|--------|-----------|------|
| `en` | English | English | LTR |
| `fr` | French | Français | LTR |
| `es` | Spanish | Español | LTR |
| `de` | German | Deutsch | LTR |
| `pt-BR` | Portuguese (Brazil) | Português (Brasil) | LTR |
| `zh-CN` | Chinese (Simplified) | 简体中文 | LTR |
| `ja` | Japanese | 日本語 | LTR |
| `ko` | Korean | 한국어 | LTR |
| `ru` | Russian | Русский | LTR |
| `ar` | Arabic | العربية | **RTL** |
| `it` | Italian | Italiano | LTR |
| `nl` | Dutch | Nederlands | LTR |
| `pl` | Polish | Polski | LTR |
| `tr` | Turkish | Türkçe | LTR |
| `sv` | Swedish | Svenska | LTR |
| `da` | Danish | Dansk | LTR |
| `cs` | Czech | Čeština | LTR |
| `uk` | Ukrainian | Українська | LTR |

Chaque entrée de `SUPPORTED_LANGUAGES` est un objet `{ code, name, nativeName, dir? }` ; seul l'arabe porte `dir: 'rtl'`, ce qui déclenche le mode RTL de l'application (voir plus bas).

Deux langues utilisent des codes composés au lieu d'un code ISO-639-1 nu : `pt-BR` (portugais du Brésil, et non un `pt` générique) et `zh-CN` (chinois simplifié). Cela évite toute ambiguïté si d'autres variantes (pt-PT, zh-TW) sont ajoutées plus tard.

## Structure des fichiers

```
client/src/i18n/
├── index.ts                      # config i18next, SUPPORTED_LANGUAGES, setLanguage()
└── locales/
    ├── en/translation.json
    ├── fr/translation.json
    ├── es/translation.json
    ├── de/translation.json
    ├── pt-BR/translation.json
    ├── zh-CN/translation.json
    ├── ja/translation.json
    ├── ko/translation.json
    ├── ru/translation.json
    ├── ar/translation.json
    ├── it/translation.json
    ├── nl/translation.json
    ├── pl/translation.json
    ├── tr/translation.json
    ├── sv/translation.json
    ├── da/translation.json
    ├── cs/translation.json
    └── uk/translation.json
```

Un seul fichier `translation.json` par langue (namespace i18next unique `translation`) — pas de découpage en plusieurs namespaces par domaine fonctionnel. Chaque fichier est un objet JSON imbriqué, avec **23 namespaces racine** identiques dans toutes les langues :

```
common, status, nav, login, forgotPassword, resetPassword, enrollment,
dashboard, monitors, groups, notifications, settings, profile, users,
agents, remediations, maintenance, importExport, download, notFound,
header, tenant, evaluateOnly
```

Exemple de structure (`common`) :

```json
{
  "common": {
    "save": "Save",
    "cancel": "Cancel",
    "delete": "Delete",
    "edit": "Edit",
    "create": "Create",
    "apply": "Apply",
    "confirm": "Confirm",
    "close": "Close"
  }
}
```

Le fichier `en/translation.json` compte **881 clés terminales** (feuilles), ce qui correspond à l'ordre de grandeur documenté (~874) — chaque langue maintient le même nombre de clés pour garantir la parité de traduction. Le poids des fichiers varie selon la densité des caractères de la langue (`en`: 41 Ko, `ru`: 61 Ko, `uk`: 63 Ko, `ja`: 53 Ko, `ar`: 55 Ko).

## Chargement et initialisation

Contrairement à un chargement paresseux par langue via un backend HTTP, Obliguard **importe statiquement les 18 fichiers JSON** au build (commentaire explicite dans le code : *"Import all locale files statically (no lazy loading needed at this app size)"*). Tous les dictionnaires sont donc inclus dans le bundle client au lieu d'être chargés à la demande — un choix assumé vu la taille modeste de l'app (~50 Ko × 18 ≈ 900 Ko de JSON, négligeable après gzip).

```typescript
// client/src/i18n/index.ts
import en from './locales/en/translation.json';
import fr from './locales/fr/translation.json';
// ... 16 autres imports

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      fr: { translation: fr },
      // ...
    },
    lng: initialLang,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
```

- `fallbackLng: 'en'` : toute clé manquante dans une traduction retombe sur l'anglais.
- `interpolation.escapeValue: false` : pas d'échappement HTML côté i18next (React échappe déjà via JSX).

### Résolution de la langue initiale

```typescript
const savedLang = localStorage.getItem('i18n_language') || navigator.language.split('-')[0] || 'en';
const initialLang = SUPPORTED_LANGUAGES.find(
  l => l.code === savedLang || l.code.startsWith(savedLang)
)?.code ?? 'en';
```

Ordre de priorité : préférence stockée en `localStorage` (`i18n_language`) → langue du navigateur (`navigator.language`, tronquée au code ISO principal, ex. `fr-CA` → `fr`) → `en` par défaut. Le `.startsWith(savedLang)` permet à un code court comme `pt` de matcher `pt-BR`.

## Changement de langue à l'exécution

La fonction `setLanguage()` (`client/src/i18n/index.ts`) centralise le changement de langue :

```typescript
export function setLanguage(code: string) {
  i18n.changeLanguage(code);
  localStorage.setItem('i18n_language', code);
  const lang = SUPPORTED_LANGUAGES.find(l => l.code === code);
  document.documentElement.setAttribute('lang', code);
  document.documentElement.setAttribute('dir', lang?.dir ?? 'ltr');
}
```

Elle fait trois choses : change la langue active i18next, persiste le choix en `localStorage`, et met à jour les attributs `lang` / `dir` sur `<html>` — c'est ce dernier point qui bascule toute l'UI en RTL pour l'arabe (mise en page miroir gérée nativement par le CSS via `dir="rtl"`).

`setLanguage` est appelée à deux endroits :

- **`ProfilePage.tsx`** : sélecteur de langue dans les préférences utilisateur (`<select>` peuplé par `SUPPORTED_LANGUAGES`). Le changement est appliqué immédiatement côté client puis persisté côté serveur via `profileApi.update({ preferredLanguage: code })` (best-effort, non bloquant si l'appel échoue).
- **`EnrollmentPage.tsx`** : première étape du wizard d'enrôlement (`LanguageStep`, `Step = 'language'`), affichée avec des drapeaux emoji par langue. Le choix est propagé au reste du wizard (`data.preferredLanguage`) puis soumis au profil en fin de parcours.

## Persistance côté serveur

La préférence de langue est stockée en base sur l'utilisateur (`preferred_language` sur la table `users`, migration `001_obliguard_schema.ts`) et exposée/consommée dans :

- `server/src/controllers/enrollment.controller.ts` — enregistrement pendant l'enrôlement
- `server/src/controllers/profile.controller.ts` — mise à jour depuis `ProfilePage`
- `server/src/validators/profile.schema.ts` — validation du champ
- `server/src/services/auth.service.ts`, `server/src/services/user.service.ts` — propagation à la création/lecture de compte
- `server/src/services/obligate.service.ts` et `server/src/routes/obligateCallback.routes.ts` — récupération de la langue préférée lors du SSO Obligate

Au chargement de session, `preferredLanguage` (renvoyé par l'API) est utilisé pour initialiser `setLanguage()` côté client, garantissant que l'utilisateur retrouve son interface dans sa langue sur n'importe quel appareil.

## Usage dans les composants

Chaque page/composant traduit importe le hook standard :

```typescript
import { useTranslation } from 'react-i18next';

export function DashboardPage() {
  const { t } = useTranslation();
  return <h1>{t('dashboard.title')}</h1>;
}
```

26 fichiers du client consomment `useTranslation`/`i18next`, couvrant l'ensemble des pages principales (`DashboardPage`, `NetMap` via `Header`/`Sidebar`, `BansPage` et consorts via les composants de layout, `SettingsPage`, `AdminUsersPage`, `AdminTenantsPage`, `AdminAgentPage`, `GroupManagePage`/`GroupDetailPage`/`GroupEditPage`, `NotificationsPage`, `ImportExportPage`, `ProfilePage`, `EnrollmentPage`, `LoginPage`, `ForgotPasswordPage`, `ResetPasswordPage`, `DownloadPage`, `NotFoundPage`, les modales de fenêtres de maintenance, etc.).

## Ce qui n'est pas internationalisé

- **Backend / API** : les messages d'erreur serveur, logs, et le contenu des notifications sortantes (Telegram, Discord, Slack, Teams, SMTP, Webhook, Gotify, Ntfy, Pushover, Free Mobile — voir `server/src/services/notification*`) ne passent pas par i18next ; ils sont générés en anglais côté serveur.
- **Agent Go** (`agent/`) et **app tray** (`desktop-app/`) : pas de couche i18n, sorties console/logs en anglais.
- **Contenu dynamique** (noms d'IP, logs bruts d'authentification, noms de services détectés) : jamais traduit, affiché tel quel.

## Ajouter une langue

1. Créer `client/src/i18n/locales/<code>/translation.json` en copiant `en/translation.json` comme squelette (881 clés, mêmes namespaces).
2. Traduire toutes les clés feuilles.
3. Dans `client/src/i18n/index.ts` : ajouter l'import statique, l'entrée dans `resources`, et l'entrée dans `SUPPORTED_LANGUAGES` (avec `dir: 'rtl'` si la langue s'écrit de droite à gauche, comme l'hébreu ou le persan).
4. Aucune migration base de données n'est nécessaire : `preferred_language` est un simple champ texte, sans contrainte d'énumération côté serveur.
