# Enrôlement d'un tenant Microsoft 365 dans Obliguard.
#
# Ce script est versionné dans le dépôt et servi par l'instance Obliguard, donc sa
# version suit celle du serveur. Il est idempotent : le relancer sur un tenant
# déjà enrôlé met à jour ce qui manque sans rien casser.
#
# Il ne collecte aucun mot de passe. L'authentification se fait en interactif
# navigateur, jamais par le flux de code d'appareil : ce flux est le vecteur de
# l'incident B et Obliguard le signale lui-même en CRITICAL (D-SI-09).
#
# Usage, la commande étant fournie par l'interface :
#   $s = Invoke-RestMethod 'https://obliguard.exemple/api/m365/enrol/script'
#   Invoke-Expression $s
#   Register-ObliguardM365 -Server 'https://obliguard.exemple' -Token '<jeton>'

function Register-ObliguardM365 {
    [CmdletBinding()]
    param(
        # URL publique de l'instance Obliguard.
        [Parameter(Mandatory)][string]$Server,
        # Jeton d'enrôlement à usage unique, émis par l'interface.
        [Parameter(Mandatory)][string]$Token,
        # Demande aussi les permissions d'écriture, pour les actions de confinement.
        # Aucune action n'est exécutée automatiquement : ces permissions ne font
        # qu'activer les boutons de l'interface.
        [switch]$IncludeWrite,
        # N'attribue pas le rôle Exchange. Les contrôles P-EXO seront alors
        # signalés comme non couverts au lieu d'échouer silencieusement.
        [switch]$SkipExchange
    )

    # Ces deux réglages sont volontairement posés dans la fonction, pas au niveau
    # du fichier : le script est chargé par Invoke-Expression dans la session de
    # l'opérateur, et un Set-StrictMode global y resterait actif après coup, au
    # risque de casser ses commandes suivantes.
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $Server = $Server.TrimEnd('/')

    Write-Host ''
    Write-Host 'Obliguard — enrôlement M365' -ForegroundColor Cyan
    Write-Host ''

    # ── 1. Ce qu'il faut appliquer ───────────────────────────────────────────
    Write-Host '[1/7] Récupération du plan depuis Obliguard...'
    $body = @{ token = $Token; includeWrite = [bool]$IncludeWrite } | ConvertTo-Json
    try {
        $plan = Invoke-RestMethod -Method Post -Uri "$Server/api/m365/enrol/plan" `
            -ContentType 'application/json' -Body $body
    } catch {
        throw "Plan d'enrôlement refusé par $Server : $($_.Exception.Message). Le jeton est peut-être expiré (une heure) ou déjà utilisé."
    }
    Write-Host "      Tenant : $($plan.primaryDomain)"
    Write-Host "      Application : $($plan.appDisplayName)"

    # ── 2. Modules ───────────────────────────────────────────────────────────
    Write-Host '[2/7] Vérification du module Microsoft.Graph...'
    $needed = @('Microsoft.Graph.Applications', 'Microsoft.Graph.Identity.DirectoryManagement')
    foreach ($m in $needed) {
        if (-not (Get-Module -ListAvailable -Name $m)) {
            Write-Host "      Installation de $m pour l'utilisateur courant..."
            Install-Module $m -Scope CurrentUser -Force -AllowClobber
        }
        Import-Module $m -ErrorAction Stop
    }

    # ── 3. Connexion ─────────────────────────────────────────────────────────
    # Interactif navigateur : compatible MFA, et conforme aux stratégies d'accès
    # conditionnel du client. Les droits demandés sont ceux de l'opérateur, le
    # temps de la session ; ils ne sont pas accordés à l'application créée.
    Write-Host '[3/7] Connexion au tenant client (une fenêtre de navigateur va s''ouvrir)...'
    $adminScopes = @(
        'Application.ReadWrite.All',
        'AppRoleAssignment.ReadWrite.All',
        'Directory.Read.All'
    )
    Connect-MgGraph -Scopes $adminScopes -NoWelcome -ErrorAction Stop
    $ctx = Get-MgContext
    if (-not $ctx) { throw 'Connexion à Microsoft Graph impossible.' }
    Write-Host "      Connecté au tenant $($ctx.TenantId) en tant que $($ctx.Account)"

    # Garde-fou : le tenant connecté doit bien être celui qu'on croit enrôler.
    # Sans ce contrôle, une session restée ouverte sur un autre client déposerait
    # le certificat dans le mauvais tenant.
    $domains = (Get-MgDomain -All).Id
    if ($domains -notcontains $plan.primaryDomain) {
        Disconnect-MgGraph | Out-Null
        throw "Le tenant connecté ($($ctx.TenantId)) ne possède pas le domaine $($plan.primaryDomain). Domaines trouvés : $($domains -join ', '). Enrôlement interrompu."
    }

    # ── 4. Inscription d'application ─────────────────────────────────────────
    Write-Host '[4/7] Inscription de l''application...'
    $escaped = $plan.appDisplayName.Replace("'", "''")
    $app = Get-MgApplication -Filter "displayName eq '$escaped'" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($app) {
        Write-Host "      Application existante réutilisée ($($app.AppId))"
    } else {
        $app = New-MgApplication -DisplayName $plan.appDisplayName -SignInAudience 'AzureADMyOrg'
        Write-Host "      Application créée ($($app.AppId))"
    }

    # ── 5. Certificat ────────────────────────────────────────────────────────
    # Seule la partie publique est déposée. La clé privée reste sur le serveur
    # Obliguard et n'a jamais transité par ce poste.
    Write-Host '[5/7] Dépôt du certificat...'
    $certBytes = [Convert]::FromBase64String($plan.certificateBase64)
    $already = @($app.KeyCredentials | Where-Object {
        $_.CustomKeyIdentifier -and ([BitConverter]::ToString($_.CustomKeyIdentifier).Replace('-', '')) -eq $plan.certThumbprint
    })
    if ($already.Count -gt 0) {
        Write-Host "      Certificat $($plan.certThumbprint) déjà présent"
    } else {
        # On conserve les certificats existants : pendant une rotation, l'ancien
        # doit rester valide jusqu'à ce que le serveur bascule.
        $keys = @()
        foreach ($k in $app.KeyCredentials) {
            $keys += @{ type = $k.Type; usage = $k.Usage; key = $k.Key; displayName = $k.DisplayName }
        }
        $keys += @{
            type        = 'AsymmetricX509Cert'
            usage       = 'Verify'
            key         = $certBytes
            displayName = "CN=obliguard-m365-$($plan.primaryDomain)"
        }
        Update-MgApplication -ApplicationId $app.Id -KeyCredentials $keys
        Write-Host "      Certificat $($plan.certThumbprint) déposé"
    }

    # ── 6. Permissions et consentement ───────────────────────────────────────
    # Les permissions sont résolues par nom en interrogeant chaque ressource :
    # aucun GUID n'est codé en dur, ni ici ni côté serveur.
    Write-Host '[6/7] Permissions applicatives et consentement administrateur...'

    $appSp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $appSp) {
        $appSp = New-MgServicePrincipal -AppId $app.AppId
        Write-Host '      Principal de service créé'
    }

    $required = @()
    $granted = 0
    $skipped = @()

    foreach ($resource in $plan.resources) {
        $resSp = Get-MgServicePrincipal -Filter "appId eq '$($resource.resourceAppId)'" -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $resSp) {
            $skipped += "$($resource.resourceName) (ressource absente du tenant)"
            continue
        }

        $access = @()
        foreach ($name in $resource.permissions) {
            $role = $resSp.AppRoles | Where-Object {
                $_.Value -eq $name -and $_.AllowedMemberTypes -contains 'Application'
            } | Select-Object -First 1

            if (-not $role) {
                # Permission inexistante sur ce tenant : typiquement les rôles P2
                # sur une licence gratuite. Ce n'est pas une erreur.
                $skipped += "$name (non proposée par $($resource.resourceName))"
                continue
            }

            $access += @{ id = $role.Id; type = 'Role' }

            # Le consentement administrateur, pour des permissions applicatives,
            # consiste exactement à créer ces assignations de rôle.
            try {
                New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $appSp.Id `
                    -PrincipalId $appSp.Id -ResourceId $resSp.Id -AppRoleId $role.Id -ErrorAction Stop | Out-Null
                $granted++
            } catch {
                if ($_.Exception.Message -match 'already exists|Permission being assigned was already assigned') {
                    $granted++
                } else {
                    Write-Warning "      $name : $($_.Exception.Message)"
                }
            }
        }

        if ($access.Count -gt 0) {
            $required += @{ resourceAppId = $resource.resourceAppId; resourceAccess = $access }
        }
    }

    if ($required.Count -gt 0) {
        # Déclarer les permissions sur l'application ne les accorde pas, mais rend
        # l'inscription lisible dans le portail : sans cela, un administrateur qui
        # l'ouvre ne voit aucune permission demandée.
        Update-MgApplication -ApplicationId $app.Id -RequiredResourceAccess $required
    }
    Write-Host "      $granted permission(s) accordée(s)"
    foreach ($s in $skipped) { Write-Host "      ignorée : $s" -ForegroundColor DarkGray }

    # ── 7. Rôle Exchange ─────────────────────────────────────────────────────
    # Exchange.ManageAsApp ouvre la porte, ce rôle décide de ce qu'on peut lire.
    # Sans lui, toutes les commandes Exchange échouent en accès refusé, y compris
    # les lectures : c'est ce qui rend les contrôles P-EXO inopérants.
    if ($SkipExchange) {
        Write-Host '[7/7] Rôle Exchange ignoré (-SkipExchange).' -ForegroundColor Yellow
        Show-ObliguardExchangeInstructions -Plan $plan -AppId $app.AppId -SpObjectId $appSp.Id
    } elseif (Get-Module -ListAvailable -Name ExchangeOnlineManagement) {
        Write-Host '[7/7] Attribution du rôle Exchange...'
        try {
            Import-Module ExchangeOnlineManagement -ErrorAction Stop
            Connect-ExchangeOnline -ShowBanner:$false -ErrorAction Stop
            $existing = Get-ServicePrincipal -ErrorAction SilentlyContinue |
                Where-Object { $_.AppId -eq $app.AppId } | Select-Object -First 1
            if (-not $existing) {
                New-ServicePrincipal -AppId $app.AppId -ObjectId $appSp.Id `
                    -DisplayName $plan.appDisplayName -ErrorAction Stop | Out-Null
            }
            Add-RoleGroupMember -Identity $plan.exchangeRole -Member $appSp.Id -ErrorAction Stop
            Write-Host "      Rôle « $($plan.exchangeRole) » attribué"
        } catch {
            if ($_.Exception.Message -match 'already a member') {
                Write-Host "      Rôle « $($plan.exchangeRole) » déjà attribué"
            } else {
                Write-Warning "      Attribution du rôle Exchange impossible : $($_.Exception.Message)"
                Show-ObliguardExchangeInstructions -Plan $plan -AppId $app.AppId -SpObjectId $appSp.Id
            }
        } finally {
            Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
        }
    } else {
        Write-Host '[7/7] Module ExchangeOnlineManagement absent.' -ForegroundColor Yellow
        Show-ObliguardExchangeInstructions -Plan $plan -AppId $app.AppId -SpObjectId $appSp.Id
    }

    # ── Retour à Obliguard ───────────────────────────────────────────────────
    Write-Host ''
    Write-Host 'Retour des identifiants à Obliguard...'
    $callback = @{
        token         = $Token
        entraTenantId = $ctx.TenantId
        clientId      = $app.AppId
    } | ConvertTo-Json

    # Les permissions fraîchement accordées mettent quelques secondes à se
    # propager : le premier appel d'Obliguard échouerait sans cette pause.
    Start-Sleep -Seconds 10

    try {
        $result = Invoke-RestMethod -Method Post -Uri "$Server/api/m365/enrol/complete" `
            -ContentType 'application/json' -Body $callback
    } catch {
        Disconnect-MgGraph | Out-Null
        throw "Obliguard a refusé le retour d'enrôlement : $($_.Exception.Message)"
    }

    Disconnect-MgGraph | Out-Null

    Write-Host ''
    if ($result.ok) {
        Write-Host 'Enrôlement terminé.' -ForegroundColor Green
    } else {
        Write-Host 'Enrôlement incomplet.' -ForegroundColor Yellow
    }
    Write-Host "  Tenant Entra   : $($ctx.TenantId)"
    Write-Host "  Application    : $($app.AppId)"
    Write-Host "  Licence        : $(if ($result.licenceProfile) { $result.licenceProfile } else { 'non déterminée' })"
    Write-Host "  Permissions OK : $($result.grantedScopes.Count)"
    if ($result.missingScopes -and $result.missingScopes.Count -gt 0) {
        Write-Host "  Manquantes     : $($result.missingScopes -join ', ')" -ForegroundColor Yellow
        Write-Host ''
        Write-Host '  Relancer la vérification depuis Obliguard une fois corrigé.' -ForegroundColor DarkGray
    }
    if ($result.error) {
        Write-Host "  Erreur         : $($result.error)" -ForegroundColor Red
    }
    Write-Host ''
}

function Show-ObliguardExchangeInstructions {
    param($Plan, [string]$AppId, [string]$SpObjectId)

    Write-Host ''
    Write-Host '      Sans le rôle Exchange, les contrôles P-EXO (règles de boîte masquées,' -ForegroundColor Yellow
    Write-Host '      transferts, trace des messages) ne pourront pas s''exécuter. Obliguard' -ForegroundColor Yellow
    Write-Host '      les signalera comme non couverts plutôt que de les déclarer conformes.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '      À exécuter pour les activer :' -ForegroundColor DarkGray
    Write-Host '        Install-Module ExchangeOnlineManagement -Scope CurrentUser' -ForegroundColor DarkGray
    Write-Host '        Connect-ExchangeOnline' -ForegroundColor DarkGray
    Write-Host "        New-ServicePrincipal -AppId $AppId -ObjectId $SpObjectId -DisplayName '$($Plan.appDisplayName)'" -ForegroundColor DarkGray
    Write-Host "        Add-RoleGroupMember -Identity '$($Plan.exchangeRole)' -Member $SpObjectId" -ForegroundColor DarkGray
    Write-Host ''
}
