La NetMap 3D est un mode de visualisation alternatif au canvas 2D (`NetMapPage.tsx`), basé sur Three.js. Elle est chargée en lazy (chunk séparé) et affichée quand `viewMode === '3d'` (bascule persistée dans `localStorage['obliguard-netmap-viewmode']`, voir `client/src/pages/NetMapPage.tsx` ligne ~165). Le composant racine est `client/src/netmap3d/NetMap3D.tsx`.

## Modules

| Fichier | Rôle |
|---|---|
| `NetMap3D.tsx` | Composant React, cycle de vie Three.js, boucle d'animation, synchronisation agents/IP/liens |
| `scene.ts` | Création du renderer WebGL, du composer de post-processing (bloom), du `CSS2DRenderer`, des `OrbitControls`, de l'éclairage |
| `skybox.ts` | Champ d'étoiles (15 000 points, shader GLSL de scintillement) |
| `agentMesh.ts` | Sphères émissives représentant les agents + labels CSS2D |
| `ipMesh.ts` | `InstancedMesh` pour les points IP (pool unique, un seul draw call) |
| `orbitRing.ts` | Anneaux d'orbite 3D inclinés, calcul de position orbitale `getOrbitPosition3D()` |
| `interactions.ts` | Raycaster pour les clics (agents et IP), fly-to caméra |
| `constants3d.ts` | Couleurs, échelle, rayons, réglages du bloom, caméra |

## Scène Three.js (`scene.ts`)

`createScene()` construit un `SceneContext` complet :

- **Scène** : fond noir spatial (`0x000206`), brouillard exponentiel (`THREE.FogExp2`, densité `0.00015`).
- **Caméra** : `PerspectiveCamera` FOV 60, near/far `0.1`–`12000`, distance initiale `CAM_INITIAL_DIST = 180`.
- **Renderer** : `THREE.WebGLRenderer` avec antialiasing, `ACESFilmicToneMapping`, exposition `1.4`, `SRGBColorSpace`, pixel ratio plafonné à 2.
- **`CSS2DRenderer`** : superposé en DOM absolu par-dessus le canvas WebGL (`pointer-events: none`) pour afficher les labels de noms d'agents sans coût de rendu 3D texte.
- **Post-processing** : `EffectComposer` → `RenderPass` + `UnrealBloomPass` (`BLOOM_STRENGTH = 1.5`, `BLOOM_RADIUS = 0.6`, `BLOOM_THRESHOLD = 0.2`). Les objets à forte `emissiveIntensity` (agents, IP) produisent un halo lumineux naturel via le bloom — il n'y a **pas** de mesh de "bulle" en blending additif séparé, la lueur vient uniquement du post-process.
- **`OrbitControls`** : damping activé (`dampingFactor 0.06`), pan/zoom/rotate configurés, distance min/max `20`–`3000`.
- **Éclairage** : `AmbientLight` bleu froid, `PointLight` "soleil" chaud à l'origine, `PointLight` de remplissage bleu par en dessous (rim light), `DirectionalLight` distante pour les ombres clés.

`resizeScene()` synchronise caméra, renderer, labelRenderer et composer sur un `ResizeObserver` attaché au conteneur. `disposeScene()` nettoie composer/renderer/controls et retire les éléments DOM au démontage.

## Boucle d'animation et point critique (physique vs rendu)

Dans `NetMap3D.tsx`, la boucle `animate()` tourne via `requestAnimationFrame` tant que le composant `NetMap3D` est monté (donc uniquement quand `viewMode === '3d'`) :

```ts
const animate = () => {
  rafRef.current = requestAnimationFrame(animate);
  const time = ctx.clock.getElapsedTime();
  ctx.controls.update();
  if (starsRef.current) updateStarField(starsRef.current, time);
  syncAgents(ctx, time);
  syncOrbitRings(ctx);
  syncIps();
  syncPeerLinks(ctx);
  ctx.composer.render();
  ctx.labelRenderer.render(ctx.scene, ctx.camera);
};
```

Le point d'architecture important, documenté dans `CLAUDE.md`, concerne le composant **2D** (`client/src/pages/NetMapPage.tsx`) : sa propre boucle `animate()` fait tourner le tick physique (force simulation `simRef`, avance des orbites képlériennes `ip.orbitAngle += ip.orbitSpeed * keplerFactor`, animation d'arrivée des IP `arriveT`, expiry des IP/liens tous les ~5 s) **avant** tout accès au canvas 2D. Ce n'est qu'après ce tick que le code vérifie la présence du canvas :

```ts
// ── 2D drawing (skip if canvas not mounted, e.g. in 3D mode) ─────────
const canvas = canvasRef.current;
if (!canvas) { rafRef.current = requestAnimationFrame(animate); return; }
const ctx = canvas.getContext('2d')!;
```

(`client/src/pages/NetMapPage.tsx`, lignes ~993-996). Autrement dit : **la simulation physique (positions des agents, orbites des IP, expiry) continue de s'exécuter dans la boucle du composant 2D même quand celui-ci n'est pas affiché à l'écran** (mode 3D actif) — seul le bloc de dessin canvas est court-circuité par le `if (!canvas) return`. Cela garantit que `agentsRef`, `ipsRef` et `agentLinksRef` (les refs partagées, mutées par cette même boucle) restent à jour en continu, quel que soit le mode de vue actif, puisque `NetMap3D` lit ces mêmes refs sans jamais les faire évoluer lui-même (le module 3D ne fait que projeter leur état courant en positions 3D à chaque frame — `syncAgents`, `syncIps`, `syncOrbitRings`, `syncPeerLinks`). Les deux boucles (2D et 3D) tournent donc en parallèle pendant que le mode 3D est actif, la boucle 2D assurant la physique en arrière-plan invisible, la boucle 3D assurant uniquement le rendu WebGL.

## Mapping des coordonnées 2D → 3D (`SCALE`)

Toutes les positions manipulées par la simulation (`AgentNode.x/y`, `IpNode` orbit state) sont exprimées en pixels du canvas 2D. Le module 3D les convertit systématiquement via la constante `SCALE = 0.35` définie dans `constants3d.ts` :

```ts
export const SCALE = 0.35;
```

Usages typiques :

- Position d'un agent : `group.position.set(agent.x * SCALE, 0, agent.y * SCALE)` (`agentMesh.ts`, `createAgent3D`/`updateAgent3D`).
- Position d'un groupe d'anneaux d'orbite : `group.position.set(agent.x * SCALE, 0, agent.y * SCALE)` (`NetMap3D.tsx`, `syncOrbitRings`).
- Rayon orbital d'une IP : `const r3d = orbitCurrentR * SCALE;` (`orbitRing.ts`, `getOrbitPosition3D`).
- Extrémités des liens pairs (peer links) : `new THREE.Vector3(src.x * SCALE, 0, src.y * SCALE)` (`NetMap3D.tsx`, `syncPeerLinks`).

L'axe Y du monde 3D n'a pas d'équivalent dans le plan 2D (toujours `0` pour les positions au repos) — il sert uniquement à l'inclinaison des anneaux d'orbite, à la hauteur d'arc des liens pairs (`midY = distance * 0.15`) et à l'animation d'arrivée des IP (spawn à `y = 80` au-dessus de l'agent, cf. `syncIps`).

## Agents (`agentMesh.ts`)

Chaque agent est un `THREE.Group` contenant :

- Un `coreMesh` sphérique (`MeshStandardMaterial`, `emissive` = couleur du type d'appareil issue de `DEVICE_COLORS`, `emissiveIntensity` = `2.0` si `agent.wsConnected`, sinon `0.3`) — la géométrie sphère est partagée (`sphereGeo`, un seul `SphereGeometry(1,32,32)` réutilisé pour tous les agents).
- Un rayon dépendant du volume d'événements : `AGENT_RADIUS * (0.6 + min(agent.eventCount/300, 0.6))`.
- Un `CSS2DObject` label (nom de l'agent + type d'appareil ou `OFFLINE`), positionné sous la sphère.

`updateAgent3D()` applique un effet de "respiration" (pulse sinusoïdal sur l'échelle) et fait varier `emissiveIntensity` dans le temps pour les agents en ligne, ce qui produit une variation de halo bloom perceptible.

## IP (`ipMesh.ts`)

Les IP utilisent un `IpMeshPool` — un unique `THREE.InstancedMesh` (capacité par défaut `2000`) avec un `InstancedBufferAttribute` de couleur par instance. `update(positions[])` recalcule matrice de transformation et couleur de chaque instance active (`mesh.count = min(positions.length, maxCount)`), ce qui permet de rendre des centaines d'IP en un seul draw call. `statusToColor3D()` mappe `banned/suspicious/whitelisted/clean` vers `STATUS_COLORS`.

Dans `NetMap3D.tsx`, `syncIps()` reconstruit la liste de positions à chaque frame à partir de `ipsRef` filtré (`visibleAgentIds`, `threatOnly`), calcule la position orbitale via `getOrbitPosition3D()`, et gère l'animation d'arrivée (`ip.arriveT < 1`) par interpolation `lerpVectors` avec un easing smoothstep depuis un point d'apparition élevé au-dessus de l'agent.

## Anneaux d'orbite (`orbitRing.ts`)

`createOrbitRings(ringCount)` génère des `THREE.LineLoop` elliptiques (`EllipseCurve`, 128 points), un anneau tous les `ORBIT_RING_GAP_3D = 2.5` unités au-delà de `AGENT_RADIUS + 4`, chacun incliné différemment selon l'angle d'or (`GOLDEN_ANGLE = 2.399963`) pour un effet "ceinture d'astéroïdes". `NetMap3D.tsx` recalcule le nombre d'anneaux nécessaires par agent (`ceil(count / 20)`, un anneau pour 20 IP) dans `syncOrbitRings()` et les recrée si ce nombre change.

`getOrbitPosition3D()` applique la même logique d'inclinaison (rotation X puis Z) que celle utilisée pour dessiner les anneaux, afin que chaque IP orbite exactement sur le plan de son anneau.

## Interactions (`interactions.ts`)

`setupInteractions()` attache trois listeners DOM sur le conteneur (`mousemove`, `click`, `dblclick`) et un `THREE.Raycaster` local :

- **Clic simple** : parcourt la scène (`scene.traverse`) pour collecter les groupes portant `userData.agentId` et le mesh marqué `userData.isIpPool`. Le raycaster teste d'abord les meshes enfants des groupes agents ; en cas de hit, il remonte l'arbre jusqu'au groupe pour récupérer `agentId`. Sinon, il teste l'`InstancedMesh` des IP via `intersectObject()` et récupère `instanceId` (index dans le tableau de positions filtrées `getFilteredIps()` côté `NetMap3D.tsx`).
- **Double-clic** : ne cible que les agents ; le point d'intersection sert de cible à `flyTo()`.
- **`flyTo()`** : anime la caméra et la cible des `OrbitControls` par interpolation `lerpVectors` avec easing cubique sur 1,5 s, en se plaçant à 30 unités de la cible le long de la direction d'approche.

Les callbacks de survol (`_onHoverAgent`, `_onHoverIp`) sont actuellement des no-op côté `NetMap3D.tsx` — aucun effet de hover n'est câblé en 3D pour l'instant, contrairement au mode 2D qui gère un tooltip complet.

## Ciel étoilé (`skybox.ts`)

`createStarField()` génère `STAR_COUNT = 15000` points distribués sur une sphère de rayon `STAR_SPHERE_RADIUS = 5000`, avec taille, phase et couleur (types spectraux O/B, G, K, M, A/F) randomisées par étoile. Un `ShaderMaterial` custom gère :

- le scintillement (vertex shader, sinusoïde par étoile modulée par sa phase),
- un point de rendu à cœur lumineux gaussien + halo doux (fragment shader).

`updateStarField()` met à jour l'uniform `uTime` à chaque frame et applique une rotation très lente du champ d'étoiles (`rotation.y += time * 0.00005`) pour un effet de dérive.

## Couleurs et constantes (`constants3d.ts`)

- `DEVICE_COLORS` : couleurs par type d'appareil (firewall, router, server, windows, desktop, défaut), plus vives qu'en 2D pour compenser le tone mapping.
- `STATUS_COLORS` : `banned` rouge, `suspicious` orange, `whitelisted` vert, `clean` bleu-gris.
- `PEER_COLORS` : `lan` bleu, `wan` orange — utilisées dans `syncPeerLinks()` pour colorer les courbes `CatmullRomCurve3` reliant deux agents.
- `AGENT_RADIUS = 3.0`, `IP_RADIUS_MIN/MAX = 0.25/0.9`, `ORBIT_RING_GAP_3D = 2.5`.
- `CAM_INITIAL_DIST/MIN/MAX_DIST` pour le zoom des `OrbitControls`.

## Liens pairs (`syncPeerLinks`, `NetMap3D.tsx`)

Pour chaque `AgentPeerLink` présent dans `agentLinksRef`, une courbe `THREE.CatmullRomCurve3` à 3 points (source, milieu surélevé, cible) est convertie en `THREE.Line`. La hauteur d'arc est proportionnelle à la distance (`midY = distance * 0.15`). Les liens existants sont mis à jour en place (réécriture du `BufferAttribute` de position) plutôt que recréés à chaque frame ; les liens disparus de `agentLinksRef` (expirés côté simulation 2D, TTL `PEER_LINK_TTL`) sont retirés de la scène.
