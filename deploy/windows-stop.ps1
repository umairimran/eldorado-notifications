# Stop the bot (it will start again at the next reboot unless you also disable the task:
#   Disable-ScheduledTask -TaskName EldoradoBot). Run as Administrator.
#Requires -RunAsAdministrator
Stop-ScheduledTask -TaskName 'EldoradoBot' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*run-forever.ps1*' } |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*dist\src\index.js*' } |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
Write-Host 'Bot stopped.' -ForegroundColor Yellow
