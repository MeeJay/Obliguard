# wfpbench-run.ps1 — Obliguard WFP RAM benchmark driver
# LANCER DANS UN POWERSHELL *ADMINISTRATEUR* (clic droit > Exécuter en tant qu'admin).
#   cd D:\Obliguard ;  .\wfpbench-run.ps1
# Utilise la plage source 240.0.0.0/4 (réservée/martienne) => AUCUN trafic légitime bloqué.
# Nettoie tout à la fin. Ne redémarre PAS la machine (test reboot optionnel, manuel).

$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'wfpbench.exe'
if (-not (Test-Path $exe)) { throw "wfpbench.exe introuvable à $exe" }

function Measure-Fw([string]$label) {
  $seen = @{}
  $rows = foreach ($svc in 'mpssvc','BFE') {
    $procId = (Get-CimInstance Win32_Service -Filter "Name='$svc'").ProcessId
    if (-not $procId -or $seen.ContainsKey($procId)) { continue }
    $seen[$procId] = $true
    $p = Get-Process -Id $procId
    [pscustomobject]@{
      Svc  = $svc; PID = $procId
      WS_MB   = [math]::Round($p.WorkingSet64/1MB,1)
      Priv_MB = [math]::Round($p.PrivateMemorySize64/1MB,1)
    }
  }
  Write-Host "`n===== $label =====" -ForegroundColor Cyan
  $rows | Format-Table -AutoSize | Out-String | Write-Host
}

Measure-Fw 'BASELINE (avant insertion)'

# Insertions cumulatives (mêmes clés déterministes => -n 30000 ajoute aux 10000 déjà là).
foreach ($n in 10000, 30000, 100000) {
  Write-Host "`n>>> insertion de $n filtres (240.0.0.0/4) ..." -ForegroundColor Yellow
  & $exe -n $n -base 240.0.0.0 | Select-Object -Last 8
  Measure-Fw "APRES $n filtres v4"
}

# Preuve dual-stack IPv6 (plage discard 0100:: — aucune source légitime).
Write-Host "`n>>> insertion 30000 filtres IPv6 (0100::) ..." -ForegroundColor Yellow
& $exe -n 30000 -v6 -base6 "0100::" | Select-Object -Last 6
Measure-Fw 'APRES +30000 filtres v6 (130000 total)'

# Comptage final via l'outil (énumère notre provider dans le moteur).
Write-Host "`n>>> comptage moteur:" -ForegroundColor Yellow
& $exe -verify

# NETTOYAGE — supprime TOUS les filtres/ sublayer/ provider du bench.
Write-Host "`n>>> nettoyage ..." -ForegroundColor Yellow
& $exe -cleanup
Measure-Fw 'APRES nettoyage (doit revenir ~baseline)'

Write-Host @"

--- OPTIONNEL: preuve fail-closed au reboot (manuel) ---
  1) .\wfpbench.exe -n 30000 -base 240.0.0.0
  2) REBOOT la machine
  3) .\wfpbench.exe -verify     # doit encore compter 30000 (sans agent lancé)
  4) .\wfpbench.exe -cleanup

Envoie-moi les tableaux 'mpssvc/BFE' à chaque étape.
Barre d'acceptation: MpsSvc/BFE < 1 Go @30K, < 2 Go @100K, croissance ~lineaire.
"@ -ForegroundColor Green
