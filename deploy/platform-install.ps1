# Installs or updates the multi-customer platform on a Windows VPS. Run in an ADMIN PowerShell
# from the repository folder (e.g. C:\eldorado-git):
#   powershell -ExecutionPolicy Bypass -File .\deploy\platform-install.ps1
# It builds + tests the code, copies it to C:\eldorado-platform\app, locks down the folder,
# registers the startup task "EldoradoPlatform" and (re)starts it. Customer data, logins and
# API keys in C:\eldorado-platform\data and \customers are never touched by an update.
#Requires -RunAsAdministrator
param([string]$PlatformHome = 'C:\eldorado-platform')
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$App = Join-Path $PlatformHome 'app'
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
function Write-Step($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

Write-Step 'Build + test'
Push-Location $Repo
try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE) { throw 'npm ci failed' }
    & npm.cmd test
    if ($LASTEXITCODE) { throw 'Tests failed - nothing was installed' }
} finally { Pop-Location }

Write-Step 'Stop the running platform (if any)'
Stop-ScheduledTask -TaskName 'EldoradoPlatform' -ErrorAction SilentlyContinue
$appDist = (Join-Path $App 'dist').ToLower()
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($appDist) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*platform-forever.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Step "Copy program to $App"
foreach ($d in 'data', 'customers', 'logs', 'backups', 'app') { New-Item -ItemType Directory -Force (Join-Path $PlatformHome $d) | Out-Null }
foreach ($d in 'dist', 'public', 'deploy') {
    & robocopy (Join-Path $Repo $d) (Join-Path $App $d) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copy of $d failed" }
}
Copy-Item (Join-Path $Repo 'package.json') $App -Force

Write-Step 'Lock down the platform folder (SYSTEM + Administrators only)'
# Only the top folder gets explicit rights; everything inside inherits them.
& icacls $PlatformHome /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' /C /Q | Out-Null
& icacls (Join-Path $PlatformHome '*') /reset /T /C /Q | Out-Null

Write-Step 'Register startup task "EldoradoPlatform"'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$App\deploy\platform-forever.ps1`"" -WorkingDirectory $App
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'EldoradoPlatform' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'EldoradoPlatform'

$log = Join-Path $PlatformHome 'logs\platform.log'
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'started \d+ bot' -Quiet)) { break }
}
if (Test-Path $log) { Get-Content $log -Tail 8 }
Write-Host "`nPlatform running on http://127.0.0.1:3100 (the ngrok tunnel should point there)." -ForegroundColor Green
