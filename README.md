# Eldorado Seller Notification Listener

Read-only, low-latency listener for your Eldorado.gg seller notifications. Every **new** notification is:

- printed to the terminal (full JSON, detection time with milliseconds, request RTT, event age), and
- pushed instantly to a live web page at **http://127.0.0.1:3000** (sound + optional desktop pop-ups).

It only ever calls two endpoints: the token endpoint and `GET /api/notifications/me`. It never marks anything as read, never touches offers, orders or messages.

> **Multi-customer platform** (sell the bot to other sellers: one website with logins, an Admin Panel to add / disable / remove customers and their API keys, one bot per customer): see [docs/PLATFORM.md](docs/PLATFORM.md). Handover notes for the next developer: [CLAUDE.md](CLAUDE.md).

## Run

Requires Node.js 22+ (`winget install OpenJS.NodeJS.LTS`).

```powershell
npm install
```
```powershell
copy .env.example .env      # then fill in ELDORADO_CLIENT_ID / ELDORADO_CLIENT_SECRET
```
```powershell
npm run verify              # one-shot: checks auth, notification retrieval and paging, then exits
```
```powershell
npm start                   # continuous monitoring + opens the live page
```
```powershell
npm test                    # mocked tests (no network)
```

Stop with **Ctrl+C** (state is saved; a second Ctrl+C exits immediately).

## How it works

| Piece | Detail |
|---|---|
| Auth | `POST https://www.eldorado.gg/api/authentication/seller/token` with `{clientId, clientSecret}` → `{accessToken, expiresIn: 900, tokenType: "Bearer"}`. Cached; refreshed in the background ~2 min before expiry; on any 401 it refreshes and retries once. Token never printed. (The help article shows `eldorado.gg` without `www` - that host redirects and breaks POST.) |
| Notifications | `GET /api/notifications/me?notificationReadStatuses=IsUnread&notificationReadStatuses=IsRead&pageSize=20`. **The status filter is required** - without it the API returns an empty list. Results are newest-first, cursor-paged (`nextPageCursor` → `cursorValue` + `pageDirection=Next`). |
| IDs / time | `notification.id` (or `customNotification.id`) and `notificationDate`. |
| Push / webhooks | None. Eldorado's docs: "At the moment, no webhook registration is available." So it polls. |
| Rate limits | Not documented, and no rate-limit headers are sent. Default 1 request/second. On HTTP 429 it honors `Retry-After` and doubles the interval (max 30s). 5xx / network errors use exponential backoff with jitter (max 60s). |
| Speed | One keep-alive TLS connection reused for every poll, prebuilt request URL, `Set` lookups, polls never overlap, next poll scheduled as soon as the interval allows. Typical RTT ≈ 290ms. |
| New vs old | First run: everything currently listed is recorded as seen and not reported. IDs are persisted to `.state/seen.json`, so restarts don't re-report; notifications that arrived while it was stopped are reported once. If a whole page is new (burst), it follows the cursor until it reaches a known ID. |
| Web page | Server-Sent Events from the local process; bound to `127.0.0.1` only (it shows buyer names). |

**RTT vs. delivery latency:** RTT is just the HTTP round trip. "Event age" = local detection time − Eldorado's `notificationDate`, so it includes your PC's clock error. Keep Windows time synced (Settings → Time & language → Date & time → **Sync now**) or the age will be off by the skew.

## Auto-offer (🔥Pirate Shop Access)

Controlled from the **⚡ Auto-offer panel** on the live page: ON/OFF switch, price, currency, quantity, min quantity, delivery time and message. **Save settings** applies them instantly (no restart) and stores them in `.state/offer-settings.json`. The `.env` `AUTO_OFFER` / `OFFER_*` values are only the first-run defaults.

When auto-offer is ON, every **new** `BoostingRequestCreated` notification for `OFFER_GAME_ID` / `OFFER_BOOSTING_CATEGORY_ID` (default Fortnite `16` / `6` = 🔥Pirate Shop Access) gets one offer via the official `POST /api/boostingOffers`:

```json
{ "details": { "boostingRequestId": "<notification.details.detailsId>", "guaranteedDeliveryTime": "Day1",
  "pricing": { "quantity": 1, "minQuantity": 1, "pricePerUnit": { "amount": 20, "currency": "USD" } },
  "message": "<OFFER_MESSAGE>" } }
```

- One offer per request, remembered in `.state/offered.json` (survives restarts). Requests that existed before startup are never offered.
- Sent off the polling path, so detection speed is unaffected. Result shows as `[OFFER SENT]` / `[OFFER FAILED]` in the terminal and as a badge on the web page.
- 4xx and network errors are not retried (no double offers); 429/5xx are retried up to 3 attempts.
- The Seller API has no plain chat-message endpoint; the offer's `message` is how text reaches the buyer.
- Manual one-shot: `npm run build` then `node dist/src/index.js --offer <boostingRequestId>`.

There is no test environment: offers are real.

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `ELDORADO_CLIENT_ID` / `ELDORADO_CLIENT_SECRET` | - | required |
| `POLL_INTERVAL_MS` | 1000 | lower = faster detection, more requests |
| `PAGE_SIZE` | 20 | 1-50 |
| `REQUEST_TIMEOUT_MS` | 10000 | |
| `MAX_CATCHUP_PAGES` | 5 | |
| `MAX_BACKOFF_MS` | 60000 | |
| `STATS_INTERVAL_MS` | 60000 | terminal `[STAT]` line, 0 = off |
| `WEB_PORT` / `WEB_HOST` | 3000 / 127.0.0.1 | |
| `OPEN_BROWSER` | true | |
| `STATE_FILE` | .state/seen.json | |

## Files

```
src/index.ts          entry point: config, terminal output, startup, Ctrl+C
src/auth.ts           token fetch, cache, background refresh
src/notifications.ts  API client, seen-ID store, polling/backoff loop
src/http.ts           keep-alive HTTPS client, Retry-After parsing
src/server.ts         local web server + live push (SSE)
public/index.html     the live page
test/                 mocked tests
```

## Security

- `.env` and `.state/` are git-ignored. This folder is inside OneDrive, so `.env` is synced to your OneDrive.
- If your Client secret was ever pasted anywhere (chat, Discord, screenshots), generate a new credential on the Seller API page, update `.env`, then revoke the old one.
