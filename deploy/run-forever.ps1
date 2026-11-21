# Keeps the bot running forever: restarts it 5 seconds after any exit/crash.
# Started at boot by the "EldoradoBot" scheduled task (see windows-setup.ps1).
$ErrorActionPreference = 'Continue'
$App = Split-Path -Parent $PSScriptRoot
Set-Location $App
$env:OPEN_BROWSER = 'false'
$logDir = Join-Path $App 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'bot.log'

while ($true) {
    # simple log rotation (keep ~20 MB + one old file)
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 20MB)) {
        Move-Item $log "$log.old" -Force
    }
    Add-Content $log "`r`n===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') starting bot =====" -Encoding utf8
    & cmd.exe /c "node dist\src\index.js >> `"$log`" 2>&1"
    Add-Content $log "===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') bot exited (code $LASTEXITCODE), restarting in 5s =====" -Encoding utf8
    Start-Sleep -Seconds 5
}
