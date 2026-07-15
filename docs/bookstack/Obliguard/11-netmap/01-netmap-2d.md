La NetMap 2D est la visualisation temps réel par défaut du parc d'agents et des IP en interaction avec eux. Elle est implémentée dans `client/src/pages/NetMapPage.tsx` (~2500 lignes) avec un jeu de modules partagés dans `client/src/netmap/` (`types.ts`, `constants.ts`, `helpers.ts`, `layout.ts`, `physics.ts`, `tabStore.ts`). Le rendu se fait sur un `<canvas>` 2D piloté par une boucle `requestAnimationFrame`, sans dépendance de charting externe.

## Modèle de données

Deux structures principales, définies dans `client/src/netmap/types.ts` :

- **`AgentNode`** — un agent : position `(x, y)`, rayon `r`, `wsConnected`, `deviceColor`/`deviceType` (couleur selon le type d'équipement), `groupId`/`groupName`, `checkIntervalMs`/`maxMissedPushes` (pour la logique de grâce hors-ligne).
- **`IpNode`** — une IP observée : `agentIds[]` + `agentWeights` (compteur de contacts par agent, pour le centroïde pondéré), état orbital (`orbitAngle`, `orbitSpeed`, `orbitSlot`, `orbitEccentricity`, `orbitCurrentR`), animation d'arrivée (`arriveT`, `spawnX/Y`), `trail[]` (traînée de comète), `status` (`clean`/`suspicious`/`banned`/`whitelisted`), `glowUntil` (pulse temporaire sur nouvel événement).

Deux refs persistent l'état hors du cycle de rendu React : `agentsRef` (tableau d'`AgentNode`) et `ipsRef` (`Map<string, IpNode>` indexée par IP). Les nœuds de liaison agent-agent réels sont dans `agentLinksRef: Map<string, AgentPeerLink>` (type `AgentPeerLink` — `sourceId`, `targetId`, `type: 'lan'|'wan'`, `services[]`, `count`, `glowUntil`), alimentés quand `ip_events.source_agent_id` est renseigné (IP homologue détectée sur un autre agent, cf. NetMap peer links / migration 005).

## TTL et cycle de vie des IP

Les IP disparaissent de la carte selon un TTL dépendant de leur statut (`client/src/netmap/constants.ts`) :

| Statut | TTL |
|---|---|
| `clean` | 60 s (`IP_TTL_CLEAN`) |
| `suspicious` | 5 min (`IP_TTL_SUSPICIOUS`) |
| `banned` | 10 min (`IP_TTL_BANNED`) |
| autre | 90 s (`IP_TTL`, fallback) |

Le fondu commence à 60 % du TTL (`IP_FADE_AGE = 0.6`), calculé dans la boucle de rendu via `ageFade`. Les peer links agent-agent expirent après `PEER_LINK_TTL = 120 s`.

## Layout des agents — simulation de force

Le placement des agents combine un layout initial déterministe et une simulation physique continue :

- **`layoutAgents()`** (`client/src/netmap/layout.ts`) — positionnement initial en cercle autour du centre du canvas (angle `i/n * 2π`), avec un jitter pseudo-aléatoire par `agent.id`, puis 80 itérations de relaxation vers le centre.
- **`distributeIpsAroundAgents()` / `relayoutIps()`** — répartition des IP en arcs concentriques de 240° (`ARC_SPAN = 4π/3`, en excluant la zone d'étiquette en haut) autour de chaque agent, triées par activité décroissante (les plus actives sur l'anneau intérieur). Une passe de répulsion agent-agent (120 itérations, refroidissement `alpha`) évite le chevauchement des « systèmes d'anneaux ». Le rayon d'exclusion par agent est calculé par `agentExclusionR()` dans `helpers.ts` selon le nombre d'IP.

En continu, `client/src/netmap/physics.ts` fournit **`ForceSimulation`**, un moteur force-directed maison (zéro dépendance, intégration Verlet) avec 7 forces configurables :

1. Ressort d'attraction sur les liens (`SimLink`, `strength`/`idealLength`) — relie chaque IP à son agent.
2. Répulsion de Coulomb agent-agent (`agentRepulsion = 800`, renforcée si les rayons d'exclusion se chevauchent).
3. Gravité de centrage des agents vers le milieu du canvas (`centerGravity = 0.008`).
4-5. Les ressorts IP↔agent sont des `SimLink` classiques (mono ou multi-agent).
6. Répulsion IP-IP à courte portée (`ipRepulsion = 2.0`, portée `ipRepulsionRange = 18px`), accélérée par une **`SpatialHash`** (grille de cellules, O(n) au lieu de O(n²)).
7. Confinement aux bords du canvas (`wallStiffness`, marge `margin = 40`).

La simulation tourne par `alpha` décroissant (`alphaDecay = 0.005`, `alphaMin = 0.001`) et se réchauffe (`reheat(alpha)`) à chaque ajout de nœud (ex. nouvelle IP → `sim.reheat(0.15)` dans `NetMapPage.tsx`).

## Système orbital des IP

Une fois positionnées près de leur agent, les IP tournent en orbite continue — effet « ceinture d'astéroïdes » :

- **Anneaux d'orbite** : `orbitRingCount(ipCount)` (dans `NetMapPage.tsx`) alloue un anneau pour ~20 IP (`Math.ceil(ipCount / 20)`), avec un espacement `ORBIT_RING_GAP = 10px`. `orbitRingRadius(nodeR, ringIndex) = nodeR + 18 + ringIndex * 10`. Les IP sont réparties en round-robin sur les anneaux (`orbRadius()`, `slot % rings`).
- **Espacement en angle d'or** : chaque nouvelle IP reçoit un slot séquentiel par agent (`slotCountersRef: Map<number, number>`) et un angle initial `slot * 2.399963` radians (l'angle d'or, ≈ 137.5°), garantissant une distribution homogène sans clustering visuel même avec des arrivées séquentielles.
- **Vitesse de Kepler** : les orbites extérieures tournent plus lentement, proportionnellement à `1/√r` — physiquement inspiré de la 3ᵉ loi de Kepler. Calcul (ligne ~900 de `NetMapPage.tsx`) :

```ts
const baseR = ag.r + 18;
const keplerFactor = Math.sqrt(baseR / Math.max(orbR, baseR));
if (!paused) ip.orbitAngle += ip.orbitSpeed * keplerFactor;
```

- Le rayon orbital cible (`targetR`) est lissé vers `orbitCurrentR` par interpolation (`+= (target - current) * 0.05`) pour éviter les sauts quand le nombre d'anneaux change.
- Les IP multi-agents (vues par ≥2 agents) orbitent en ellipse autour du **centroïde pondéré** des agents concernés (pondération par `agentWeights`), avec excentricité aléatoire par IP (`orbitEccentricity`, 0.55–0.85, `makeOrbitalFields()` dans `helpers.ts`) pour un effet de dispersion naturel. Leur vitesse angulaire est réduite (`× 0.7`).
- **Animation d'arrivée** : une nouvelle IP apparaît en bord de canvas (`spawnX/Y`, calculé par zone dans `makeOrbitalFields`) puis migre vers sa position orbitale en `arriveT` (incrément `+0.0025`/frame, interpolation linéaire spawn → cible).
- **Pause** : `orbitPausedRef` (bouton pause utilisateur) ou sélection d'une IP (`clickedIp !== null`) gèlent l'angle orbital.

## Anneaux d'orbite (rendu)

Les anneaux sont dessinés autour de chaque agent avec un fondu enchaîné lissé (`agentDisplayedRingsRef`, lerp `× 0.03` vers le nombre de cibles) plutôt qu'un affichage binaire — évite les popping visuels quand des IP apparaissent/disparaissent. Opacité réduite (`0.10`, `0.04` si un autre agent est sélectionné). Couleur selon l'état de connexion de l'agent (`#4a8abb` connecté / `#2a3a4a` déconnecté).

## Peer links (liens agent-agent)

Deux types de tracés distincts entre agents :

- **Arêtes IP partagée** (non dirigées, pointillés animés) : dessinées quand la même IP a contacté plusieurs agents (`agentEdges`, `Set` de paires triées `min-max`).
- **Peer links réels** (`agentLinksRef`, dirigés, avec flèche) : trafic effectif entre deux agents détecté via `source_agent_id`. Couleur selon le type — LAN bleu subdued (`#3b82f6`) vs WAN ambre (`#f97316`), constantes `PEER_LINK_COLOR` dans `client/src/netmap/constants.ts`. Épaisseur logarithmique selon `link.count`, tirets animés (`lineDashOffset`) si récent (< 8 s), glow temporaire (`glowUntil`), étiquette `LAN`/`WAN` au milieu du segment.

## Minimap

Rendue en bas à droite du canvas (150×100px) dès que le nombre d'agents dépasse 2 (`agents.length > 2`, section « Minimap » de `animate()`). Calcule les bornes du monde à partir des positions agents uniquement (+ marge 40px), projette agents (points cyan/gris selon `wsConnected`) et le rectangle de viewport courant (dérivé de `transformRef` — pan/zoom). Les IP ne sont pas affichées sur la minimap (volontairement, pour lisibilité).

## Recherche d'IP

Champ texte dans la barre d'outils (`searchIp` state). À la soumission, recherche exacte dans `ipsRef.current` (`Map.get(q)`) :
- Trouvée → `searchHit` est fixé sur l'IP, la caméra (`transformRef`) recentre et zoome (`k: 2`) sur le nœud, un anneau blanc pulsant est dessiné autour du point pendant 4 secondes puis `searchHit` repasse à `null`.
- Non trouvée → toast d'erreur `"IP not on map"`.

## Filtre « menaces uniquement »

Toggle `threatOnly` (bouton `⚠ THREATS` / `⚠ ALL` dans la barre d'outils). Quand actif, la liste des `IpNode` rendus est filtrée en amont du pipeline de dessin :

```ts
if (threatOnlyRef.current) {
  ipNodes = ipNodes.filter(ip => ip.status === 'banned' || ip.status === 'suspicious');
}
```

Ce filtre s'applique après le filtre d'onglet (`visibleAgentIdsRef`, cf. onglets NetMap ci-dessous) et avant le calcul des anneaux d'orbite par agent — les IP `clean`/`whitelisted` disparaissent alors intégralement du rendu (dots, lignes, labels).

## Onglets NetMap (filtrage par sous-ensemble d'agents)

`client/src/netmap/tabStore.ts` (`useNetMapTabStore`, Zustand) gère des onglets personnalisés — chacun un sous-ensemble d'agents (`NetMapTab { id, name, agentIds[], sortOrder }`). Persistance double : `localStorage` (clé `obliguard-netmap-tabs`, instantané) puis synchronisation serveur différée (`PATCH /profile`, `preferences.netmapTabs`, debounce 1.5 s). L'onglet actif (`activeTabId`, `null` = « All Agents ») pilote `visibleAgentIdsRef`, utilisé pour filtrer à la fois les agents et les IP affichés dans `animate()`.

## Éléments de rendu additionnels

- **Ripples** (`ripplesRef`) — onde de choc rouge expansive émise sur un événement de ban.
- **Particles** (`particlesRef`, via `spawnParticle()`) — particule animée d'un agent vers une IP sur événement socket réel (`auth_success`/`auth_failure`/`ban`), couleur selon `EVENT_COLORS`.
- **Trail** — traînée de comète pour les IP multi-agents en orbite elliptique (8 dernières positions).
- **Pulse de ban** — throb rouge lent (`Math.sin(ts/800)`) autour des IP au statut `banned`.
- **Ripple de suspicion** — anneau expansif toutes les ~3s pour les IP `suspicious` avec plus de 10 échecs.
- **Badges** — étiquette `CC · IP` dessinée uniquement pour les IP notables (`shouldLabel()` dans `helpers.ts` : bannie, whitelistée, plus de 2 échecs, ≥8 événements, ou vue par plusieurs agents), rendu via `drawBadgeAt()`.

## Couleurs et types d'équipement

`DEVICE_TYPE_COLORS` (`client/src/netmap/constants.ts`) associe une couleur par type d'agent : `firewall` (#F5A623 — MikroTik/OPNsense/pfSense), `router` (#00cfff), `server` (#7F77DD — Linux), `windows` (#3b82f6), `desktop` (#5DCAA5), `default` (#90c8f0). Détection via `detectDeviceColor()`/`detectDeviceType()` dans `NetMapPage.tsx`. Les couleurs de service (SSH, RDP, FTP, etc.) sont dans `SVC_COLORS`, et `DANGEROUS_SVCS` marque les services à risque (ssh, rdp, ftp, mysql, telnet, smb, vnc) pour la mise en évidence.

## Bascule 2D/3D

Le mode d'affichage (`viewMode: '2d' | '3d'`) est persistant en `localStorage` (`obliguard-netmap-viewmode`). Les deux modes partagent les mêmes refs de données (`agentsRef`, `ipsRef`, `agentLinksRef`) — la boucle de simulation physique (force sim, mouvement orbital, arrivée, expiration TTL) tourne dans `animate()` indépendamment du mode ; seul le bloc de dessin canvas 2D est ignoré quand `viewMode === '3d'` (le composant `NetMap3D` prend alors le relais, cf. page dédiée à la NetMap 3D).
