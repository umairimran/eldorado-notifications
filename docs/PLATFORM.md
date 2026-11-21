# Multi-customer platform (Seller Bot for many sellers)

One website, one link. You (the admin) and every paying customer log in there. Each customer
gets their **own** Eldorado bot (their notifications, their offers, their settings), running
24/7 on the VPS. You manage everything from the **Admin Panel** in the browser - no commands.

```
 Customer A ─┐                                         ┌─► bot of A   (127.0.0.1:3102)
 Customer B ─┼─► https://<ngrok link> ─► platform :3100 ┼─► bot of B   (127.0.0.1:3103)
 Admin ──────┘   (ngrok tunnel)          login + admin  └─► admin's bot (127.0.0.1:3101)
```

## Daily use (Admin Panel)

Open the link, log in as `admin`, you land on **/admin**.

| Button | What it does |
|---|---|
| ＋ Add customer | Name, username, the seller's **Eldorado Client ID + Client Secret**, paid-until date. The keys are checked with Eldorado first (nothing is created if they are wrong), then stored encrypted. The new login + password is shown with a **Copy** button - send it to the customer. |
| ⏹ Stop bot / ▶ Start bot | Switches only the bot off/on (no checking, no offers). Works for every account, **including the admin's own bot**. The login keeps working; a stopped bot stays off after restarts/reboots until started again. |
| ⏸ Disable / ▶ Enable | Customers only: stops the bot **and** blocks the login (e.g. not paid) / allows it again. |
| 📅 +1 month | Extends paid-until by one month. An expired customer is switched back on automatically. |
| 👁 Login details | Shows the customer's link + username + password again, with **Copy**. Passwords are stored AES-encrypted (plus a scrypt hash for login checks). |
| 🔑 API keys | Replace the Eldorado keys (checked first), bot restarts. |
| 🔒 Reset password | Makes a new password (also visible later under 👁 Login details). The old one stops working immediately. |
| 🔄 Restart bot | Restarts that customer's bot. |
| 📄 Log | Last 300 lines of the bot's log (API keys are never shown). |
| ✏️ Edit | Name, paid-until, notes, check interval. |
| 🗑 Delete | Type the username to confirm. Bot stops, login removed; data folder moved to `deleted\`. |
| My account | Change the admin password. |
| My bot ↗ | Your own bot page (same page customers see). |

Automatic: when a customer's **paid-until** date has passed, they are disabled (checked every
10 minutes). Customers see "Your subscription has ended. Contact the seller" when they try to log in.

Customers see only their own bot page (live notifications + the 7 auto-offer panels) and a small
"Log out" bar. They can never see API keys or the admin panel. One Eldorado account can only be
used by one customer (two bots on the same account would send double offers).

## Where things are on the VPS

| Path | What |
|---|---|
| `C:\eldorado-git` | Git checkout of this repo (branch `multi-customer`). Edit + build here. |
| `C:\eldorado-platform\app` | Installed program (copied by `deploy\platform-install.ps1`). |
| `C:\eldorado-platform\data\accounts.json` | All logins. Passwords are scrypt hashes, Eldorado keys are AES-256-GCM encrypted. |
| `C:\eldorado-platform\data\master.key` | Key that decrypts the Eldorado keys. **Never share. Back it up offline** - without it the encrypted keys (and backups) are useless. |
| `C:\eldorado-platform\data\session.key` | Signs login cookies. Deleting it logs everyone out. |
| `C:\eldorado-platform\customers\<username>\` | One folder per account: `.state\` (offer settings, offered requests, seen notifications) and `logs\bot.log`. |
| `C:\eldorado-platform\logs\platform.log` | Platform log (start/stop, expiry, errors). |
| `C:\eldorado-platform\backups\` | Daily copy of `accounts.json` (keys stay encrypted), last 30 days. |
| `C:\eldorado-platform\deleted\` | Data folders of deleted customers. |
| `C:\eldorado-tunnel-ngrok\` | ngrok (fixed link) → `127.0.0.1:3100`. Holds the ngrok authtoken (not in git). |
| `C:\eldorado-notifications\` | The old single-user install. Its `EldoradoBot` task is **disabled**; kept only as a fallback. |

The whole `C:\eldorado-platform` folder is readable only by SYSTEM and Administrators.

Startup tasks (all run as SYSTEM at boot, restart on crash):

| Task | Runs |
|---|---|
| `EldoradoPlatform` | `app\deploy\platform-forever.ps1` → `node dist\src\platform\main.js` (website + all bots) |
| `EldoradoTunnelNgrok` | `C:\eldorado-tunnel-ngrok\ngrok-forever.ps1` (public link) |
| `EldoradoBot` | old single bot - **disabled** |
| `EldoradoTunnel`, `EldoradoTunnelLHR` | old tunnels - **disabled** |

## How it works (code)

| File | Role |
|---|---|
| `src/platform/main.ts` | Entry point. Starts the website, all bots, expiry check (10 min), daily backup. CLI: `set-admin`, `import-bot`. |
| `src/platform/server.ts` | Website: `/login`, `/logout`, `/admin` + `/admin/api/*`, and a proxy that forwards everything else (incl. the live SSE stream) to the logged-in account's own bot. Injects the "Log out" bar into the bot page. |
| `src/platform/supervisor.ts` | Starts one `node dist/src/index.js` per account with its own `ELDORADO_DATA_DIR`, port and keys (keys passed as environment variables, never written in plain text). Restarts crashed bots with backoff, writes `logs\bot.log`, counts offers. |
| `src/platform/store.ts` | `accounts.json` + `master.key`, atomic writes, encryption helpers, dates. |
| `src/platform/security.ts` | scrypt passwords, AES-256-GCM, signed session cookies, login rate limit, log redaction. |
| `public/platform/admin.html` | Admin Panel (plain HTML/JS). |
| `src/index.ts` | The bot itself (unchanged behaviour). `ELDORADO_DATA_DIR` lets many bots share one program folder. |

Security details: login cookie is HttpOnly + SameSite=Lax (+Secure over HTTPS), signed with
`session.key`, and carries a per-account version (disable / password reset logs out everywhere).
Logins lock after 10 wrong tries per username (20 per IP) for 10 minutes. Admin API calls need a
custom header + JSON + same origin (no cross-site requests). The platform and all bots listen on
127.0.0.1 only; the internet reaches them only through the ngrok tunnel.

## Install / update (Administrator PowerShell)

```powershell
cd C:\eldorado-git
git pull
powershell -ExecutionPolicy Bypass -File .\deploy\platform-install.ps1
```

This runs the tests (nothing is installed if they fail), copies the program to
`C:\eldorado-platform\app`, and restarts the platform (all bots restart, ~10 s). Logins, keys and
customer data are not touched.

First-time only (already done on this VPS):

```powershell
# admin login (password read from a file, at least 12 characters), then restart the platform
cmd /c "set PLATFORM_HOME=C:\eldorado-platform&& cd /d C:\eldorado-platform\app && node dist\src\platform\main.js set-admin admin Owner < C:\path\to\password.txt"
# optional: move an existing single-user bot (its .env keys + .state) into the admin account
cmd /c "set PLATFORM_HOME=C:\eldorado-platform&& cd /d C:\eldorado-platform\app && node dist\src\platform\main.js import-bot admin C:\eldorado-notifications"
```

The CLI commands write `accounts.json` directly: **stop the platform first** (or restart it right
after), otherwise the running website keeps its old copy in memory and overwrites the change.

## Troubleshooting

| Symptom | Check |
|---|---|
| Link shows ngrok "offline" | `Get-ScheduledTask EldoradoTunnelNgrok`; `C:\eldorado-tunnel-ngrok\ngrok.log` |
| Login page loads, then "Your bot is starting…" forever | Admin Panel → that customer → 📄 Log. "Eldorado rejected the API keys" = replace keys. |
| Website down | `C:\eldorado-platform\logs\platform.log`; `Start-ScheduledTask EldoradoPlatform` |
| Offers fail with "message too long" | Message max 500 characters (Eldorado limit); the page refuses longer ones. |

Restart everything: `Restart-Computer`, or
`Stop-ScheduledTask EldoradoPlatform; Start-ScheduledTask EldoradoPlatform`
(the platform kills leftover bots from a previous run on start).

## Roll back to the old single-user bot

```powershell
Stop-ScheduledTask EldoradoPlatform; Disable-ScheduledTask EldoradoPlatform
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -like '*eldorado-platform*' } | % { Stop-Process -Id $_.ProcessId -Force }
# copy the latest state back so no request is offered twice
Copy-Item C:\eldorado-platform\customers\admin\.state\* C:\eldorado-notifications\.state\ -Force
Enable-ScheduledTask EldoradoBot; Start-ScheduledTask EldoradoBot
# point ngrok back to 3000: edit C:\eldorado-tunnel-ngrok\ngrok-forever.ps1 (3100 -> 3000), then restart EldoradoTunnelNgrok
```

## Limits

- ~10-30 customers per VPS to start. Every bot checks Eldorado every 1 s by default (Admin Panel →
  ✏️ Edit → "Check every" to slow a customer down). Watch "VPS memory used" in the panel.
- Fortnite boosting only (game 16), same categories for everyone.
- Free ngrok shows its warning page once per browser; a paid ngrok plan removes it.
- Payments are handled by the admin outside the app (paid-until date + "+1 month").
