# Notes for Claude (or any developer) taking over this project

Eldorado.gg seller bot: polls the official Eldorado Seller API for notifications, shows them on a
live web page, and auto-sends one boosting offer per new Fortnite request (per-category settings).
Branch `multi-customer` adds a **multi-customer platform**: one website with logins, an Admin
Panel, and one bot per paying customer. Read `docs/PLATFORM.md` first - it has the full layout,
paths, startup tasks, install/update and rollback steps.

## Production (Windows Server VPS)

- Repo checkout: `C:\eldorado-git` (branch `multi-customer`). Installed copy: `C:\eldorado-platform\app`.
- Public link: fixed ngrok domain → platform on `127.0.0.1:3100`. Each bot: `127.0.0.1:31xx`.
- Startup tasks (SYSTEM): `EldoradoPlatform`, `EldoradoTunnelNgrok`. Old `EldoradoBot` is disabled.
- Private notes (link, admin username, where each secret lives) are in
  `C:\eldorado-platform\PRIVATE-NOTES.md` on the VPS - **not in git**. This repo is PUBLIC.

## Rules

- Never print, log, commit or paste secrets: Eldorado client secrets, `master.key`, `session.key`,
  passwords, the ngrok authtoken. `.gitignore` covers `.env`, `*.key`, `.state/`, `logs/`.
- Never bind anything to `0.0.0.0` or open firewall ports; the internet only reaches the platform
  through the ngrok tunnel.
- Only one bot may run per Eldorado account (double offers). The platform refuses duplicate keys;
  do not start the old `C:\eldorado-notifications` bot while the platform runs the admin bot.
- Offer messages: max 500 characters (Eldorado limit). Custom request (category 1) never gets offers.
- Changes: work on a branch, `npm test` must pass (`node --test dist/test/*.test.js`), then
  `deploy\platform-install.ps1` (it refuses to install if tests fail).

## Commands

```powershell
npm ci; npm test                                    # build + 34 tests
powershell -ExecutionPolicy Bypass -File .\deploy\platform-install.ps1   # deploy (Admin PowerShell)
Get-Content C:\eldorado-platform\logs\platform.log -Tail 50
Get-Content C:\eldorado-platform\customers\<user>\logs\bot.log -Tail 50
```

## Eldorado API facts learned the hard way

- Base URL must be `https://www.eldorado.gg` (bare host redirects and breaks POST).
- Notifications need `notificationReadStatuses=IsUnread&notificationReadStatuses=IsRead`.
- No chat-message endpoint for sellers; text reaches buyers only through the offer `message`.
- Fortnite boosting category IDs (gameId 16): 0 Battle Royale Rank Boost, 1 Custom request,
  2 Reload Rank Boost, 3 Tournament Boost, 4 Battle Pass, 5 Save the World, 6 Pirate Shop Access, 7 Coaching.
- Cloudflare quick tunnels block the live SSE stream; ngrok works.
