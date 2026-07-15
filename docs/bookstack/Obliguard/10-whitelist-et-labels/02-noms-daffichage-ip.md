## Objectif

Une adresse IP brute (`203.0.113.42`) ne dit rien à un opérateur. Les **noms d'affichage IP** (`ip_display_names`) permettent d'attacher un libellé humain à n'importe quelle IP connue du système — qu'elle soit banni, suspecte, whitelistée ou simplement vue dans les événements — pour l'identifier d'un coup d'œil sur la NetMap et la page de réputation IP (ex. `"AIRBOX"`, `"NAS Bureau"`, `"VPN Siège"`).

Ce mécanisme est distinct de la whitelist (`server/src/services/whitelist.service.ts`) : un label n'a aucun effet sur le ban engine, c'est un renommage purement cosmétique.

## Modèle de données

Migration `server/src/db/migrations/012_ip_display_names.ts` :

```sql
CREATE TABLE ip_display_names (
  id           SERIAL PRIMARY KEY,
  ip           TEXT NOT NULL,
  label        TEXT NOT NULL,
  tenant_id    INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ip, tenant_id)
);
CREATE INDEX idx_ip_display_names_ip ON ip_display_names(ip);
CREATE INDEX idx_ip_display_names_tenant ON ip_display_names(tenant_id);
```

Portée (`tenant_id`) :
- `NULL` → label **global**, posé par un admin sans contexte tenant, visible par tous les tenants.
- `N` → label **scopé au tenant N**, visible uniquement par ce tenant, et prioritaire sur un éventuel label global pour la même IP.

La contrainte `UNIQUE(ip, tenant_id)` garantit au plus un label par (IP, tenant).

## Service — `server/src/services/ipDisplayNames.service.ts`

### `list(tenantId?)`

Retourne tous les labels visibles par l'appelant :
- Toujours les labels globaux (`tenant_id IS NULL`).
- Si le tenant appelant est le tenant maître (`isMasterTenant(tenantId)`, `@obliview/shared`), tous les labels de tous les tenants sont inclus.
- Sinon, seulement les labels du tenant courant en plus des globaux.

La déduplication se fait ensuite en mémoire via une `Map<ip, IpDisplayName>` : pour une même IP, l'entrée scopée au tenant écrase toujours l'entrée globale (le label tenant "gagne").

```ts
for (const row of rows as IpDisplayName[]) {
  const existing = map.get(row.ip);
  if (!existing || row.tenantId !== null) {
    map.set(row.ip, row); // le label tenant l'emporte sur le global
  }
}
```

### `upsert(ip, label, tenantId, userId?)`

- `INSERT ... ON CONFLICT (ip, tenant_id) DO UPDATE` (merge sur `label` et `updated_at`).
- Si `label` est vide ou ne contient que des espaces (`!label.trim()`), l'appel est redirigé vers `delete()` — poser un label vide équivaut à le supprimer.
- `created_by` est renseigné avec `userId` à la création (utilisé côté client pour afficher qui a créé le label — voir `IPReputationPage.tsx` qui résout `created_by` en nom d'utilisateur via `GET /users/:id`).

### `delete(ip, tenantId)`

Supprime l'entrée correspondant exactement à `(ip, tenantId)` — `tenantId = null` cible explicitement le label global via `whereNull('tenant_id')`.

## API — routes et contrôleur

`server/src/routes/ipDisplayNames.routes.ts`, montées sous `/ip-labels` (voir `server/src/routes/index.ts`) :

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/ip-labels` | `requireAuth` | Liste les labels visibles pour le tenant courant |
| POST | `/ip-labels` | `requireAuth` + `requireRole('admin')` | Crée/modifie un label (`{ ip, label }`) |
| DELETE | `/ip-labels/:ip` | `requireAuth` + `requireRole('admin')` | Supprime le label d'une IP |

`server/src/controllers/ipDisplayNames.controller.ts` :
- `upsertLabel` / `deleteLabel` déterminent la portée à partir de `req.tenantId` (le tenant actif de la session admin) ; sans contexte tenant, le label est posé en global (`tenantId = null`).
- Seuls les admins peuvent écrire (`requireRole('admin')`) ; la lecture est ouverte à tout utilisateur authentifié (`requireAuth`), qui ne verra que les labels globaux + ceux de son propre tenant.

## Client — `client/src/api/ipLabels.api.ts`

```ts
export const ipLabelsApi = {
  list(): Promise<IpDisplayName[]>,
  upsert(ip: string, label: string): Promise<void>,
  remove(ip: string): Promise<void>,
};
```

Wrapper fin autour de `GET/POST/DELETE /ip-labels` via `apiClient`.

## Utilisation — NetMap (`client/src/pages/NetMapPage.tsx`)

Au chargement des données NetMap, `ipLabelsApi.list()` est appelé **en parallèle** de la réputation IP et de la whitelist (`Promise.all`), avec fallback silencieux sur `[]` en cas d'échec :

```ts
const [repRes, wlRes, displayNamesRaw] = await Promise.all([
  apiClient.get(/* /ip-reputation */),
  apiClient.get('/whitelist').catch(() => ({ data: { data: [] } })),
  ipLabelsApi.list().catch(() => []),
]);
```

Le résultat alimente une `Map<string, string>` (`displayNameMap`, IP → label) consultée pour chaque nœud IP construit (événements, réputation, entrées whitelist) afin de renseigner le champ `displayLabel` du nœud (`IpNode`, voir `client/src/netmap/types.ts`). Ce `displayLabel` est prioritaire sur le `whitelistLabel` pour l'affichage du texte au survol/à côté du point IP, aussi bien en mode 2D (canvas) qu'en mode 3D (labels CSS2D, `client/src/netmap3d/`).

## Utilisation — IPReputationPage (`client/src/pages/IPReputationPage.tsx`)

- Au montage, `ipLabelsApi.list()` remplit un état local `ipLabels: Map<string, string>`.
- Dans le tableau de réputation, `displayLabel = ipLabels.get(row.ip)` est utilisé comme **source de vérité unique** pour le nom affiché d'une ligne (commentaire dans le code : *"Single label: use ip_display_names label (ipLabels) as the one source of truth"*), ce qui remplace tout autre système de renommage plus ancien.
- Le tiroir de détail (`IPDetailDrawer`, composant local à la page) reçoit `currentLabel={ipLabels.get(selectedIp.ip)}` et une prop `onRename(ip, label)`. Le formulaire de renommage propose :
  - un champ pour poser/éditer le label (bouton "Add label" / "Edit label" selon l'état),
  - un bouton de suppression si un label existe déjà (`currentLabel && ...`), qui appelle `onRename(ip.ip, '')` → traduit côté service en suppression via la règle "label vide = delete".
- `handleRename` appelle `ipLabelsApi.upsert`/`remove` puis met à jour la `Map` locale de façon optimiste et affiche un toast de confirmation.
- Si l'entrée possède un `created_by`, la page résout l'auteur via `GET /users/:id` (`displayName || username`) pour l'afficher dans le détail du label.

## Portée BansPage

À ce jour, `client/src/pages/BansPage.tsx` **ne consomme pas** `ipLabelsApi` : les bans y sont affichés avec l'IP brute, sans résolution de label. Le label personnalisé n'est donc actif que sur la NetMap et sur la page Réputation IP.

## Points d'attention

- Un label est purement déclaratif : il n'influence ni le ban engine (`ban.service.ts`), ni le whitelist matching, ni la sévérité/réputation calculée par `ipReputation.service.ts`.
- Seuls les admins peuvent créer/modifier/supprimer des labels ; les rôles read-only voient les labels mais ne peuvent pas les éditer (boutons d'édition masqués côté UI, et l'API rejette de toute façon via `requireRole('admin')`).
- La portée globale vs tenant permet à un opérateur multi-tenant de labelliser une IP partagée (ex. un range NAT connu) une seule fois pour tous les tenants, tout en laissant chaque tenant surcharger localement si besoin.
