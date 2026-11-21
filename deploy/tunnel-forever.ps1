# Keeps a Cloudflare quick tunnel (https://<random>.trycloudflare.com -> http://127.0.0.1:3000)
# running forever. Started at boot by the "EldoradoTunnel" scheduled task (windows-tunnel.ps1).
# The current public URL is written to logs\public-url.txt.
$ErrorActionPreference = 'Continue'
$App = Split-Path -Parent $PSScriptRoot
Set-Location $App
$exe = Join-Path $App 'tools\cloudflared.exe'
$logDir = Join-Path $App 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'tunnel.log'
$urlFile = Join-Path $logDir 'public-url.txt'

while ($true) {
    if (Test-Path $log) { Move-Item $log "$log.old" -Force }
    $p = Start-Process -FilePath $exe -ArgumentList 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3000', '--logfile', "`"$log`"" -PassThru -WindowStyle Hidden
    # publish the URL as soon as cloudflared prints it
    for ($i = 0; $i -lt 60 -and -not $p.HasExited; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Path $log) {
            $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1
            if ($m) { $m.Matches[0].Value | Set-Content $urlFile -Encoding ascii; break }
        }
    }
    $p.WaitForExit()
    Start-Sleep -Seconds 5
}
