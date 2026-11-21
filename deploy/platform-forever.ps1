# Keeps the multi-customer platform running forever: restarts it 5 seconds after any exit/crash.
# Started at boot by the "EldoradoPlatform" scheduled task (see platform-install.ps1).
# The platform itself starts and supervises one bot per customer.
$ErrorActionPreference = 'Continue'
$App = Split-Path -Parent $PSScriptRoot          # C:\eldorado-platform\app
$PlatformHome = Split-Path -Parent $App          # C:\eldorado-platform
Set-Location $App
$env:PLATFORM_HOME = $PlatformHome
$logDir = Join-Path $PlatformHome 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'platform.log'

while ($true) {
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 20MB)) { Move-Item $log "$log.old" -Force }
    Add-Content $log "`r`n===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') starting platform =====" -Encoding utf8
    & cmd.exe /c "node dist\src\platform\main.js >> `"$log`" 2>&1"
    Add-Content $log "===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') platform exited (code $LASTEXITCODE), restarting in 5s =====" -Encoding utf8
    Start-Sleep -Seconds 5
}
