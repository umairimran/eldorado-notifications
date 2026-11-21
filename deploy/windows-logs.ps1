# Watch the bot's live log (Ctrl+C stops watching; the bot keeps running).
$App = Split-Path -Parent $PSScriptRoot
Get-Content (Join-Path $App 'logs\bot.log') -Tail 50 -Wait
