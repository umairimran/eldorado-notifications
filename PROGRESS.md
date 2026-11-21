# Progress

## Done (2026-11-21)

- **Notification listener**: official Seller API (`POST /api/authentication/seller/token`, `GET /api/notifications/me`), 1s polling over keep-alive HTTPS, cursor paging, dedupe by ID, persisted state, 429/5xx backoff, Ctrl+C-safe.
- **Live web page** (`http://127.0.0.1:3000`): real-time feed via SSE, sound + desktop alerts, stats.
- **Auto-offer** for Fortnite 🔥Pirate Shop Access (gameId 16 / boostingCategoryId 6) via official `POST /api/boostingOffers`. One offer per request. Controlled from the page's ⚡ Auto-offer panel (ON/OFF, price, currency, quantity, min quantity, delivery time, message). Verified live: offers accepted with HTTP 201.
- **Tests**: 20 mocked tests (`npm test`).
- **Deployment kits**: Ubuntu (`deploy/eldorado.service`, `DEPLOY.md`) and Windows Server (`deploy/windows-*.ps1`, 24/7 scheduled task with auto-restart).

## Findings about the Eldorado Seller API

- Use `https://www.eldorado.gg` (the bare `eldorado.gg` host redirects and breaks POST).
- `GET /api/notifications/me` returns nothing unless `notificationReadStatuses=IsUnread&notificationReadStatuses=IsRead` is sent.
- A notification's `details.detailsId` is the boosting request ID.
- No webhooks/push, no documented rate limits.
- No endpoint to send chat messages; `createConversationForSeller` only opens an empty chat. Text reaches the buyer via the offer's `message`.
- Competitors' offer prices are not exposed, so price undercutting is not possible.

## Next

1. Enable OpenSSH on the Windows VPS (key-only) and deploy there; stop the PC copy at switch-over.
2. Add a password login to the page, then expose it worldwide over HTTPS via Cloudflare Tunnel (Vercel can't host a 24/7 poller).
3. Rotate the Eldorado Client secret (it was shared in a chat).
