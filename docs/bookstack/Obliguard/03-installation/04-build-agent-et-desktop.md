Cette page décrit la compilation de l'agent Go (`agent/`) — binaire cross-platform + installeur MSI Windows — et de l'application de bureau (`desktop-app/`, référencée depuis `client/src/pages/DownloadPage.tsx`). Les deux sont des binaires Go compilés séparément du monorepo Node (`shared/`, `server/`, `client/`).

## Agent — vue d'ensemble

La version de l'agent est pilotée par un fichier unique, source de vérité pour tous les scripts de build : `agent/VERSION` (ex. `1.8.37`). Elle est injectée au build via un `-ldflags` Go :

```bash
LDFLAGS="-X main.agentVersion=${VERSION}"
```

Tous les binaires produits atterrissent dans `agent/dist/` :

```
obliguard-agent-linux-amd64
obliguard-agent-linux-arm64
obliguard-agent-freebsd-amd64
obliguard-agent-darwin-amd64
obliguard-agent-darwin-arm64
obliguard-agent.exe
obliguard-agent.msi
obliguard-agent.wixpdb
```

## Build cross-platform du binaire

### Linux + FreeBSD — `agent/build-linux.sh`

Exécuté sur un hôte Linux (appelé à distance en SSH par `000-RegularUpdate.bat`). `CGO_ENABLED=0`, trois cibles :

```bash
GOOS=linux   GOARCH=amd64 go build -ldflags="-s -w -X main.agentVersion=${VERSION}" -o dist/obliguard-agent-linux-amd64 .
GOOS=linux   GOARCH=arm64 go build -ldflags="-s -w -X main.agentVersion=${VERSION}" -o dist/obliguard-agent-linux-arm64 .
GOOS=freebsd GOARCH=amd64 go build -ldflags="-s -w -X main.agentVersion=${VERSION}" -o dist/obliguard-agent-freebsd-amd64 .
```

Une alternative Docker existe dans `agent/Dockerfile.crossbuild` (image `golang:1.22-alpine`, stage final `FROM scratch`), utilisée via le daemon Docker distant (`10.0.0.152`) :

```bash
docker build -f agent/Dockerfile.crossbuild --build-arg AGENT_VERSION=1.2.3 -t obliguard-agent-xbuild agent/
docker create --name xbuild-tmp obliguard-agent-xbuild
docker cp xbuild-tmp:/out/. agent/dist/
docker rm xbuild-tmp
```

### macOS — `agent/build-mac.sh`

Doit s'exécuter **sur un Mac** (Apple Silicon ou Intel), contrairement aux autres cibles. Raison documentée dans le script : `gopsutil` utilise `cpu.Percent(percpu=true)`, qui appelle `host_processor_info` (API Mach) — cela nécessite `CGO_ENABLED=1`. Un binaire cross-compilé perdrait le détail par cœur du CPU dans l'UI (repli sur `top`, qui ne donne que le pourcentage global).

Le script détecte l'architecture native via `go env GOARCH`, construit celle-ci en natif (CGO), puis tente l'architecture croisée avec `clang -arch` :

```bash
CGO_ENABLED=1 GOOS=darwin GOARCH="$NATIVE_GOARCH" \
  go build -ldflags="-s -w -X main.agentVersion=$VERSION" \
  -o "dist/obliguard-agent-darwin-$NATIVE_GOARCH" .

CGO_ENABLED=1 GOOS=darwin GOARCH="$CROSS_GOARCH" \
  CGO_CFLAGS="-arch $CROSS_CLANG_ARCH" CGO_LDFLAGS="-arch $CROSS_CLANG_ARCH" \
  go build -ldflags="-s -w -X main.agentVersion=$VERSION" \
  -o "dist/obliguard-agent-darwin-$CROSS_GOARCH" .
```

Si la cross-compilation échoue, le script continue avec un avertissement — le binaire natif reste utilisable. Les deux fichiers `obliguard-agent-darwin-arm64` / `-amd64` doivent ensuite être copiés manuellement sur l'hôte de build Windows/Unraid avant de relancer `000-RegularUpdate.bat` (le `Dockerfile` de l'image serveur les récupère via `COPY agent/dist/`).

### Tous les OS d'un coup — `agent/build.sh`

Script bash générique (utilisable sous Git Bash sur Windows) qui compile les cinq cibles principales en une passe : `linux/amd64`, `linux/arm64`, `darwin/amd64`, `darwin/arm64`, `windows/amd64`. La version est lue depuis `agent/VERSION` ou passée en argument (`./build.sh 1.6.0`). Il rappelle explicitement en fin d'exécution que le MSI n'est **pas** inclus et doit être construit à part via WiX.

## MSI Windows via WiX v4+

### Pré-requis

```bash
dotnet tool install -g wix
```

Nécessite le SDK .NET 8. **Important** : WiX v4+ utilise la CLI unifiée `wix build` — les anciens outils `candle.exe` / `light.exe` de WiX v3 ne sont plus utilisés.

### Script `agent/build-msi.bat`

Séquence complète en 3 étapes, à lancer depuis `agent/` :

1. **Vérifications** : présence de `go` et de `wix` dans le `PATH` (sinon message d'erreur avec lien d'installation), lecture de la version depuis `VERSION`.
2. **Build de l'exe Windows** :
   ```bat
   set CGO_ENABLED=0
   set GOOS=windows
   set GOARCH=amd64
   go build -ldflags="-s -w -X main.agentVersion=!VER!" -o dist\obliguard-agent.exe .
   ```
3. **Build du MSI** : le placeholder `AGENT_VERSION_PLACEHOLDER` dans `agent/installer/product.wxs` est remplacé par la version courante via un one-liner Node (choisi pour éviter les problèmes de guillemets/pipes de `cmd.exe` / PowerShell) :
   ```js
   var fs=require('fs');
   var c=fs.readFileSync('installer/product.wxs','utf8').replace('AGENT_VERSION_PLACEHOLDER','!VER!');
   fs.writeFileSync('installer/_product_versioned.wxs',c);
   ```
   puis :
   ```bat
   wix build installer\_product_versioned.wxs -b . -arch x64 -out dist\obliguard-agent.msi
   ```
   Le fichier temporaire versionné est supprimé après le build (succès ou échec).

### `agent/installer/product.wxs`

Package WiX v4 (`xmlns="http://wixtoolset.org/schemas/v4/wxs"`), points clés :

- `UpgradeCode` fixe (`8D56E26E-B218-4788-81B6-4E5088F285F6`) + `<MajorUpgrade DowngradeErrorMessage="..." />` pour gérer les mises à niveau in-place.
- Deux propriétés MSI passées en ligne de commande : `SERVERURL` et `APIKEY` (`Secure="yes"`), utilisées comme arguments du service Windows :
  ```
  msiexec /i obliguard-agent.msi SERVERURL="https://..." APIKEY="your-key" /quiet
  ```
- Le composant `AgentExe` installe `obliguard-agent.exe` avec `DefaultVersion="65535.0.0.0"` — un contournement nécessaire car les binaires Go n'ont pas de ressource de version Win32 par défaut ; sans ce champ, MSI peut sauter la copie du fichier si un binaire "non versionné mais modifié" traîne d'une install précédente ratée.
- `ServiceInstall` déclare le service `ObliguardAgent` (`DisplayName="Obliguard Monitoring Agent"`, `Start="auto"`, `Type="ownProcess"`, compte `LocalSystem`), avec les arguments `--url "[SERVERURL]" --key "[APIKEY]"`. Le binaire appelle `SetServiceStatus(SERVICE_RUNNING)` via `golang.org/x/sys/windows/svc` (voir `agent/service_windows.go`), donc le `Wait="yes"` par défaut de `ServiceControl` se résout normalement sans accrochage.
- Au premier démarrage, l'agent écrit `config.json` et lit ensuite ce fichier directement ; le composant `AgentConfig` écrit aussi `ServerUrl`/`ApiKey` dans `HKLM\SOFTWARE\ObliguardAgent` en repli pour les cas limites où `config.json` n'existe pas encore.

### Wizard d'installation offline

Deux scripts additionnels produisent un exécutable autonome qui embarque l'agent et se termine par un blob de configuration ajouté à la volée par le serveur (`/api/agent/installer/wizard.exe`, tail-blob `OBLI_CFG`) :

- `agent/build-wizard.bat` (Windows, GUI `lxn/walk`) : copie le MSI déjà construit dans `wizard/windows/`, génère un manifeste Common-Controls via `github.com/akavel/rsrc`, puis `go build -ldflags="-s -w -H windowsgui"` → `dist/obliguard-installer-wizard.exe`. Nécessite `build-msi.bat` exécuté avant.
- `agent/build-wizard-linux.bat` (cross-compile CLI Linux depuis Windows) : copie `dist/obliguard-agent-linux-amd64` dans `wizard/linux/`, build avec `CGO_ENABLED=0` → `dist/obliguard-installer-wizard-linux-amd64`. Nécessite `build-linux.sh` exécuté avant.

## Desktop app (`desktop-app/`)

L'app de bureau est une application Go native basée sur une **webview système** — WebView2 sur Windows, WKWebView sur macOS — qui charge l'interface web du client Obliguard dans une fenêtre native tout en injectant des bindings JS pour les opérations locales impossibles depuis un navigateur (choix de dossier, écriture de fichier, etc.).

### Bindings injectés côté client

Le code React détecte l'exécution dans l'app native via un objet `window` étendu par l'overlay Go, référencé dans `client/src/pages/DownloadPage.tsx` :

```ts
type NativeWindow = Window & {
  __obliguard_is_native_app?: boolean;
  __go_getDownloadDir?: () => Promise<string>;
  __go_chooseDownloadDir?: () => Promise<string>;
  __go_downloadFile?: (relUrl: string, filename: string) => Promise<string>;
};
```

`__go_downloadFile` télécharge un fichier depuis le serveur Obliguard directement vers le dossier sauvegardé (ouvre le sélecteur de dossier natif si aucun n'est encore défini) — utilisé pour proposer les téléchargements des exécutables agent (`ObliToolsSetup.msi`, `ObliTools.exe` sur Windows, `ObliTools-*.dmg` / `.zip` sur macOS) sans passer par le téléchargement navigateur classique.

`client/src/components/layout/DesktopUpdateBanner.tsx` lit une seconde variable, `__obliguard_app_version`, injectée par le binaire Go compilé (numéro de version de l'app elle-même, distinct de `agentVersion`). Elle compare cette version à celle renvoyée par `GET /agent/desktop-version` et affiche une bannière de mise à jour si `currentVersion < latestVersion` (comparaison sémantique `X.Y.Z` maison, `isOutdated()`). L'utilisateur peut « Ignorer cette version » (persisté en `localStorage` sous la clé `obliguard:skipped-desktop-version`) ou fermer la bannière pour la session.

### Build

D'après les instructions affichées sur la page Téléchargement (`DownloadPage.tsx`, bloc « build-it-yourself ») :

- **Windows** : `desktop-app/build-windows.ps1`. Nécessite WiX v4 :
  ```powershell
  dotnet tool install --global wix
  .\build-windows.ps1
  ```
- **macOS** : `desktop-app/build-mac.sh` :
  ```bash
  ./build-mac.sh
  ```

Comme pour l'agent, le packaging Windows produit un installeur MSI via `wix build` (pas `candle`/`light`), suivant le même modèle que `agent/build-msi.bat` : binaire Go compilé d'abord, puis empaquetage WiX avec injection de version.

## Points d'attention communs

- **Toujours** repartir de `agent/VERSION` (ou de l'équivalent côté `desktop-app/`) comme unique source de vérité pour la version injectée — ne jamais coder une version en dur dans un script de build.
- Sous Windows, `CGO_ENABLED=0` est utilisé pour l'agent (binaire de service pur), alors que macOS impose `CGO_ENABLED=1` pour conserver les métriques CPU par cœur — ne pas uniformiser ce flag entre les scripts.
- `wix build` (v4+) remplace intégralement `candle.exe`/`light.exe` (v3) : toute doc ou script héritée mentionnant ces deux binaires est obsolète pour ce projet.
- Après tout build MSI, `docker compose build` doit être relancé sur le serveur de build pour que l'image serveur embarque les nouveaux binaires servis via `/api/agent/download/`.
