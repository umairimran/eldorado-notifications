# Makes the live page reachable worldwide over HTTPS through a Cloudflare quick tunnel.
# No account, domain or open ports needed. Requires DASHBOARD_PASSWORD in .env (login page).
# Run in an ADMIN PowerShell:
#   powershell -ExecutionPolicy Bypass -File C:\eldorado-notifications\deploy\windows-tunnel.ps1
# Note: a quick-tunnel URL changes whenever the tunnel restarts (e.g. VPS reboot);
# the current one is always in logs\public-url.txt.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$App = Split-Path -Parent $PSScriptRoot
Set-Location $App
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not (Select-String -Path (Join-Path $App '.env') -Pattern '^DASHBOARD_PASSWORD=.{12,}' -Quiet)) {
    throw 'Set DASHBOARD_PASSWORD (12+ characters) in .env before exposing the page to the internet.'
}

# 1. cloudflared (official Cloudflare release)
$tools = Join-Path $App 'tools'
New-Item -ItemType Directory -Force $tools | Out-Null
$exe = Join-Path $tools 'cloudflared.exe'
if (-not (Test-Path $exe)) {
    Write-Host 'Downloading cloudflared from github.com/cloudflare/cloudflared ...'
    Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $exe -UseBasicParsing
}
& $exe --version

# 2. Startup task that keeps the tunnel up
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$App\deploy\tunnel-forever.ps1`"" -WorkingDirectory $App
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'EldoradoTunnel' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

# 3. Start it and print the public link
$urlFile = Join-Path $App 'logs\public-url.txt'
Remove-Item $urlFile -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'EldoradoTunnel'
for ($i = 0; $i -lt 60 -and -not (Test-Path $urlFile); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path $urlFile) {
    Write-Host "`nPUBLIC LINK: $(Get-Content $urlFile)" -ForegroundColor Green
} else {
    Write-Host 'Tunnel did not report a URL yet - check logs\tunnel.log' -ForegroundColor Yellow
}
