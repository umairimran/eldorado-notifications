# One-time setup on a Windows VPS. Run in an ADMIN PowerShell:
#   powershell -ExecutionPolicy Bypass -File C:\eldorado-notifications\deploy\windows-setup.ps1
# It installs Node.js 22 (if missing), builds + tests the bot, verifies the Eldorado API
# from this server, then registers a startup task that keeps the bot running 24/7.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$App = Split-Path -Parent $PSScriptRoot
Set-Location $App
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Update-PathEnv {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Get-NodeMajor {
    try { return [int]((& node --version).TrimStart('v').Split('.')[0]) } catch { return 0 }
}

# 1. Node.js 22 LTS ------------------------------------------------------------------------
Write-Step 'Node.js'
Update-PathEnv
if ((Get-NodeMajor) -lt 22) {
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $ver = ($index | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1).version
    $msi = Join-Path $env:TEMP "node-$ver-x64.msi"
    Write-Host "Downloading Node.js $ver from nodejs.org ..."
    Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-x64.msi" -OutFile $msi -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait
    Update-PathEnv
}
if ((Get-NodeMajor) -lt 22) { throw 'Node.js 22+ is not available after install.' }
Write-Host "Node $(node --version) OK" -ForegroundColor Green

# 2. Build + tests --------------------------------------------------------------------------
Write-Step 'Install, build, test'
& npm.cmd ci --no-audit --no-fund
if ($LASTEXITCODE) { throw 'npm ci failed' }
& npm.cmd test
if ($LASTEXITCODE) { throw 'Tests failed' }

# 3. Live check against Eldorado from this server -------------------------------------------
Write-Step 'Verify Eldorado API from this VPS'
if (-not (Test-Path .env)) { throw '.env is missing (credentials).' }
& node dist\src\index.js --verify
if ($LASTEXITCODE) { throw 'Verification failed - see the message above.' }

# 4. Lock down the credentials file ---------------------------------------------------------
& icacls .env /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' | Out-Null

# 5. Startup task: runs at boot as SYSTEM, restarts the bot if it ever exits ----------------
Write-Step 'Register 24/7 startup task "EldoradoBot"'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$App\deploy\run-forever.ps1`"" -WorkingDirectory $App
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'EldoradoBot' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "`nSetup complete." -ForegroundColor Green
Write-Host 'The bot is NOT started yet. Make sure the bot on your PC is stopped, then run:' -ForegroundColor Yellow
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$App\deploy\windows-start.ps1`""
