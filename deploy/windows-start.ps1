# Start the bot now (it also starts automatically at every boot). Run as Administrator.
#Requires -RunAsAdministrator
$App = Split-Path -Parent $PSScriptRoot
Start-ScheduledTask -TaskName 'EldoradoBot'
Write-Host 'Starting... waiting for the bot to come up' -ForegroundColor Cyan
$log = Join-Path $App 'logs\bot.log'
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'Listening for new notifications' -Quiet)) { break }
}
if (Test-Path $log) { Get-Content $log -Tail 12 }
Write-Host "`nLive page on this VPS: http://127.0.0.1:3000" -ForegroundColor Green
Start-Process 'http://127.0.0.1:3000'
