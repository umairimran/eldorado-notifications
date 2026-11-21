// Eldorado seller notification listener: polls the official Seller API, prints every new
// notification to the terminal and pushes it live to a local web page.
//   npm start            -> continuous monitoring + web page (http://127.0.0.1:3000)
//   npm run verify       -> one-shot check of authentication + notification retrieval
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpClient, HttpStatusError } from './http.js';
import { TokenManager } from './auth.js';
import { Listener, NotificationsClient, StateWriter, loadState, itemDate, itemId, type NotificationItem } from './notifications.js';
import { WebServer } from './server.js';
import {
  CURRENCIES,
  DELIVERY_TIMES,
  MAX_MESSAGE_LENGTH,
  OFFER_CATEGORIES,
  OfferSender,
  loadCategorySettings,
  parseBoostingRequest,
  saveCategorySettings,
  validateOfferSettings,
  type CategorySettings,
  type OfferConfig,
  type OfferResult,
  type OfferSettings,
} from './offers.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Config {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  pollIntervalMs: number;
  pageSize: number;
  requestTimeoutMs: number;
  maxCatchupPages: number;
  maxBackoffMs: number;
  statsIntervalMs: number;
  stateFile: string;
  webPort: number;
  webHost: string;
  openBrowser: boolean;
  autoOffer: boolean;
  offer: OfferConfig;
  offerStateFile: string;
  offerSettingsFile: string;
  dashboardPassword: string;
}

function intEnv(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(`[CONFIG] ${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function loadConfig(): Config {
  try {
    process.loadEnvFile(resolve(ROOT, '.env'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') fail(`[CONFIG] Could not read .env: ${(e as Error).message}`);
  }
  const clientId = process.env.ELDORADO_CLIENT_ID?.trim();
  const clientSecret = process.env.ELDORADO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) fail('[CONFIG] Set ELDORADO_CLIENT_ID and ELDORADO_CLIENT_SECRET in .env (see .env.example)');

  const autoOffer = (process.env.AUTO_OFFER ?? 'false').trim().toLowerCase() === 'true';
  const price = Number(process.env.OFFER_PRICE ?? '');
  const deliveryTime = process.env.OFFER_DELIVERY_TIME?.trim() || 'Day1';
  const message = process.env.OFFER_MESSAGE?.trim() ?? '';
  const offer: OfferConfig = {
    gameId: process.env.OFFER_GAME_ID?.trim() || '16',
    boostingCategoryId: process.env.OFFER_BOOSTING_CATEGORY_ID?.trim() || '6',
    priceAmount: price,
    currency: process.env.OFFER_CURRENCY?.trim() || 'USD',
    quantity: intEnv('OFFER_QUANTITY', 1, 1, 1_000_000),
    minQuantity: intEnv('OFFER_MIN_QUANTITY', 1, 1, 1_000_000),
    deliveryTime,
    message,
  };

  return {
    autoOffer,
    offer,
    offerSettingsFile: resolve(ROOT, '.state/offer-settings.json'),
    dashboardPassword: process.env.DASHBOARD_PASSWORD ?? '',
    offerStateFile: resolve(ROOT, process.env.OFFER_STATE_FILE?.trim() || '.state/offered.json'),
    clientId,
    clientSecret,
    baseUrl: process.env.ELDORADO_BASE_URL?.trim() || 'https://www.eldorado.gg',
    pollIntervalMs: intEnv('POLL_INTERVAL_MS', 1000, 100, 3_600_000),
    pageSize: intEnv('PAGE_SIZE', 20, 1, 50),
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 10_000, 1000, 120_000),
    maxCatchupPages: intEnv('MAX_CATCHUP_PAGES', 5, 1, 100),
    maxBackoffMs: intEnv('MAX_BACKOFF_MS', 60_000, 1000, 3_600_000),
    statsIntervalMs: intEnv('STATS_INTERVAL_MS', 60_000, 0, 86_400_000),
    stateFile: resolve(ROOT, process.env.STATE_FILE?.trim() || '.state/seen.json'),
    webPort: intEnv('WEB_PORT', 3000, 0, 65_535),
    webHost: process.env.WEB_HOST?.trim() || '127.0.0.1',
    openBrowser: (process.env.OPEN_BROWSER ?? 'true').trim().toLowerCase() !== 'false',
  };
}

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

const out = (s: string) => process.stdout.write(s + '\n');
const warn = (s: string) => process.stderr.write(`${s}\n`);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function printNotification(item: NotificationItem, detectedAt: number, rttMs: number): void {
  const date = itemDate(item);
  const lines = [
    '',
    '[NEW NOTIFICATION]',
    `Detected: ${stamp(detectedAt)}`,
    `Notification ID: ${itemId(item)}`,
    `Request RTT: ${Math.round(rttMs)}ms`,
  ];
  if (date !== undefined) {
    lines.push(`Event time: ${stamp(date)} (notificationDate)`);
    lines.push(`Event age at detection: ${detectedAt - date}ms (local clock minus server timestamp; includes clock skew)`);
  }
  lines.push('', 'Payload:', JSON.stringify(item, null, 2), '');
  process.stdout.write(lines.join('\n') + '\n');
}

function applySettings(target: OfferConfig, s: OfferSettings): void {
  target.priceAmount = s.priceAmount;
  target.currency = s.currency;
  target.quantity = s.quantity;
  target.minQuantity = s.minQuantity;
  target.deliveryTime = s.deliveryTime;
  target.message = s.message;
}

/** First run: take .env values (and the message saved by the old message box, if any). */
async function settingsFromEnv(cfg: Config): Promise<OfferSettings> {
  let message = cfg.offer.message;
  try {
    const legacy = JSON.parse(await readFile(resolve(ROOT, '.state', 'chat-message.json'), 'utf8')) as { message?: unknown };
    if (typeof legacy.message === 'string' && legacy.message.trim()) message = legacy.message.trim();
  } catch {
    /* none */
  }
  return {
    enabled: cfg.autoOffer,
    priceAmount: cfg.offer.priceAmount,
    currency: cfg.offer.currency,
    quantity: cfg.offer.quantity,
    minQuantity: cfg.offer.minQuantity,
    deliveryTime: cfg.offer.deliveryTime,
    message,
  };
}

function describeOffer(o: OfferConfig): string {
  return `${o.priceAmount} ${o.currency} x${o.quantity}, delivery ${o.deliveryTime}, message "${o.message}"`;
}

const categoryLabel = (id: string) => OFFER_CATEGORIES.find((c) => c.id === id)?.label ?? `category ${id}`;

/** The offer to send for one category: the game from .env plus that category's page settings. */
function offerConfigFor(base: OfferConfig, categoryId: string, s: OfferSettings): OfferConfig {
  const c: OfferConfig = { ...base, boostingCategoryId: categoryId };
  applySettings(c, s);
  return c;
}

/**
 * Settings for every category on the page. Missing categories start OFF with the 🔥 Pirate Shop
 * values (or .env defaults) and an empty message, so nothing is sent until you fill one in.
 */
function completeCategorySettings(saved: CategorySettings, fallback: OfferSettings): CategorySettings {
  const pirate = saved['6'] ?? fallback;
  const out: CategorySettings = {};
  for (const { id } of OFFER_CATEGORIES) {
    let s = saved[id] ?? (id === '6' ? pirate : { ...pirate, enabled: false, message: '' });
    if (s.enabled && !validateOfferSettings(s).ok) s = { ...s, enabled: false };
    out[id] = s;
  }
  return out;
}

function printOfferResult(r: OfferResult): void {
  if (r.ok) {
    out(`[OFFER SENT] ${stamp(Date.now())} request=${r.boostingRequestId} HTTP ${r.status}${r.offerId ? ` offerId=${r.offerId}` : ''} RTT ${Math.round(r.rttMs ?? 0)}ms`);
  } else {
    warn(`[OFFER FAILED] ${stamp(Date.now())} request=${r.boostingRequestId} HTTP ${r.status || 'network'} - ${r.error} (not retried)`);
  }
}

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    /* opening the browser is a convenience only */
  }
}

async function verify(client: NotificationsClient, tokens: TokenManager): Promise<void> {
  out('[VERIFY] Authentication: OK (token valid for ' + tokens.secondsLeft + 's; token not shown)');
  const p1 = await client.fetchPage();
  out(`[VERIFY] GET /api/notifications/me: OK - ${p1.results.length} notifications on page 1, RTT ${Math.round(p1.rttMs)}ms`);
  const newest = p1.results[0];
  if (newest) {
    const d = itemDate(newest);
    out(`[VERIFY] Newest: id=${itemId(newest)} date=${d === undefined ? 'n/a' : stamp(d)}`);
  }
  if (p1.nextPageCursor) {
    const p2 = await client.fetchPage(p1.nextPageCursor);
    const overlap = p2.results.some((i) => p1.results.some((j) => itemId(i) === itemId(j)));
    out(`[VERIFY] Cursor pagination: OK - page 2 has ${p2.results.length} notifications${overlap ? ' (WARNING: overlaps page 1)' : ', no overlap'}`);
  } else {
    out('[VERIFY] Cursor pagination: only one page exists');
  }
  out('[VERIFY] All checks passed. Run "npm start" to begin monitoring.');
}

async function main(): Promise<void> {
  const verifyOnly = process.argv.includes('--verify');
  const cfg = loadConfig();
  const http = createHttpClient(cfg.requestTimeoutMs);
  const tokens = new TokenManager({
    http: http.request,
    baseUrl: cfg.baseUrl,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    onBackgroundError: (e) => warn(`[AUTH] Background token refresh failed: ${errMsg(e)} (will retry)`),
  });
  const client = new NotificationsClient(http.request, tokens, cfg.baseUrl, cfg.pageSize);

  out('========================================');
  out('  ELDORADO SELLER NOTIFICATION LISTENER');
  out('========================================');
  out('');

  try {
    await tokens.getToken();
  } catch (e) {
    http.close();
    fail(`[AUTH] Authentication failed: ${errMsg(e)}\n       Check ELDORADO_CLIENT_ID / ELDORADO_CLIENT_SECRET and that the credential is not revoked or expired.`);
  }
  out('[AUTH] Authentication successful');

  const offerIdx = process.argv.indexOf('--offer');
  if (offerIdx !== -1) {
    // One-shot: send a single offer to the given boosting request ID, print the result, exit.
    const requestId = process.argv[offerIdx + 1];
    if (!requestId) fail('[OFFER] Usage: --offer <boostingRequestId>');
    // Uses the 🔥 Pirate Shop Access settings.
    const saved = (await loadCategorySettings(cfg.offerSettingsFile))?.['6'];
    if (saved) applySettings(cfg.offer, saved);
    const check = validateOfferSettings({ ...cfg.offer, enabled: true });
    if (!check.ok) fail(`[OFFER] Offer settings invalid: ${check.error}`);
    const sender = new OfferSender(http.request, tokens, cfg.baseUrl, cfg.offer, cfg.offerStateFile);
    await sender.loadState();
    if (sender.hasOffered(requestId)) {
      out(`[OFFER] Already offered on ${requestId}; not sending again.`);
    } else {
      out(`[OFFER] Sending ${describeOffer(cfg.offer)} to boosting request ${requestId} ...`);
      printOfferResult((await sender.send(requestId))!);
    }
    tokens.stop();
    http.close();
    return;
  }

  if (verifyOnly) {
    try {
      await verify(client, tokens);
    } catch (e) {
      tokens.stop();
      http.close();
      fail(`[VERIFY] Failed: ${errMsg(e)}`);
    }
    tokens.stop();
    http.close();
    return;
  }

  // Offer settings per category: saved from the page (.state/offer-settings.json), else .env defaults.
  const savedSettings = (await loadCategorySettings(cfg.offerSettingsFile)) ?? {};
  let settings: CategorySettings = completeCategorySettings(savedSettings, await settingsFromEnv(cfg));
  const offers = new OfferSender(http.request, tokens, cfg.baseUrl, cfg.offer, cfg.offerStateFile);
  await offers.loadState();

  const web = new WebServer(resolve(ROOT, 'public', 'index.html'), cfg.pollIntervalMs, {
    get: () => OFFER_CATEGORIES.map((c) => ({ id: c.id, label: c.label, settings: settings[c.id] })),
    save: async (input) => {
      const categoryId = String((input as { categoryId?: unknown } | null)?.categoryId ?? '');
      if (!OFFER_CATEGORIES.some((c) => c.id === categoryId)) return { ok: false, error: 'Unknown category' };
      const r = validateOfferSettings(input);
      if (!r.ok) return r;
      settings = { ...settings, [categoryId]: r.value }; // the next offer uses the new values immediately
      await saveCategorySettings(cfg.offerSettingsFile, settings);
      out(
        `[OFFER] ${stamp(Date.now())} settings saved from the page: ${categoryLabel(categoryId)} auto-offer ${r.value.enabled ? 'ON' : 'OFF'} - ` +
          describeOffer(offerConfigFor(cfg.offer, categoryId, r.value)),
      );
      return { ok: true, value: r.value, categoryId };
    },
    deliveryTimes: DELIVERY_TIMES,
    currencies: CURRENCIES,
    maxMessageLength: MAX_MESSAGE_LENGTH,
  }, 200, cfg.dashboardPassword || undefined);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(cfg.webHost);
  if (!loopback && cfg.dashboardPassword.length < 12) {
    fail('[WEB] WEB_HOST exposes the page beyond this machine: set DASHBOARD_PASSWORD (12+ characters) in .env first.');
  }
  if (cfg.dashboardPassword && cfg.dashboardPassword.length < 12) fail('[WEB] DASHBOARD_PASSWORD must be at least 12 characters.');
  const store = await loadState(cfg.stateFile, warn);
  const writer = new StateWriter(cfg.stateFile, store, warn);

  let polls = 0;
  let errors = 0;
  let rttSum = 0;
  let lastRtt = 0;
  let detected = 0;
  let offersSent = 0;
  let offersFailed = 0;
  const syncStats = (status: 'live' | 'retrying', message?: string) => {
    web.stats = {
      ...web.stats,
      status,
      message,
      polls,
      errors,
      detected,
      offersSent,
      offersFailed,
      lastRttMs: polls ? lastRtt : undefined,
      avgRttMs: polls ? rttSum / polls : undefined,
      lastPollAt: polls ? Date.now() : web.stats.lastPollAt,
      intervalMs: listener.intervalMs,
    };
    web.pushStats();
  };

  const listener: Listener = new Listener({
    client,
    store,
    pollIntervalMs: cfg.pollIntervalMs,
    maxCatchupPages: cfg.maxCatchupPages,
    maxBackoffMs: cfg.maxBackoffMs,
    hooks: {
      onNew: (item, info) => {
        detected++;
        printNotification(item, info.detectedAt, info.rttMs);
        web.pushNew(item, info.detectedAt, info.rttMs);
        const req = parseBoostingRequest(item);
        const catSettings = req && req.gameId === cfg.offer.gameId ? settings[req.categoryId] : undefined;
        if (req && catSettings?.enabled && !offers.hasOffered(req.requestId)) {
          const requestId = req.requestId;
          const offerCfg = offerConfigFor(cfg.offer, req.categoryId, catSettings);
          out(`[OFFER] Matched ${categoryLabel(req.categoryId)} - sending ${describeOffer(offerCfg)} to request ${requestId}`);
          // Runs off the polling path: detection of further notifications is never delayed.
          void offers.send(requestId, offerCfg).then((r) => {
            if (!r) return;
            if (r.ok) offersSent++;
            else offersFailed++;
            printOfferResult(r);
            web.pushOffer(info.id, r);
            web.stats = { ...web.stats, offersSent, offersFailed };
            web.pushStats();
          });
        }
      },
      onPoll: (rtt) => {
        polls++;
        lastRtt = rtt;
        rttSum += rtt;
        syncStats('live');
      },
      onWarn: (m) => {
        errors++;
        warn(`${stamp(Date.now())} ${m}`);
        syncStats('retrying', m);
      },
      onStateChange: () => writer.schedule(),
    },
  });

  try {
    await web.listen(cfg.webPort, cfg.webHost);
  } catch (e) {
    tokens.stop();
    http.close();
    fail(`[WEB] Could not start the web page on ${cfg.webHost}:${cfg.webPort}: ${errMsg(e)} (set WEB_PORT in .env to use another port)`);
  }

  // First contact: retry transient failures; stop on rejected credentials.
  const ctrl = new AbortController();
  let started: Awaited<ReturnType<Listener['start']>> | undefined;
  while (!started && !ctrl.signal.aborted) {
    try {
      started = await listener.start();
    } catch (e) {
      if (e instanceof HttpStatusError && e.source === 'auth' && e.status >= 400 && e.status < 500 && e.status !== 429) {
        fail(`[AUTH] ${e.message}`);
      }
      const wait = listener.backoffDelay(e);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  if (!started) return;
  web.addExisting(started.firstPage);

  const url = `http://${cfg.webHost === '0.0.0.0' ? '127.0.0.1' : cfg.webHost}:${cfg.webPort}`;
  out(`[API] Notifications endpoint connected (GET /api/notifications/me, RTT ${Math.round(started.rttMs)}ms)`);
  out(
    started.resumed
      ? `[STATE] Resumed: ${started.known} known notification IDs; ${started.reported} new since last run reported above`
      : `[BASELINE] ${started.known} existing notifications recorded as seen (not reported)`,
  );
  out('[MODE] Live monitoring (HTTP polling - Eldorado offers no webhooks/push)');
  out(`[POLL] ${cfg.pollIntervalMs}ms (POLL_INTERVAL_MS; no documented rate limit, auto-slows on HTTP 429)`);
  out(`[WEB] Live page: ${url}${cfg.dashboardPassword ? ' (password login ON)' : ''}`);
  for (const { id, label } of OFFER_CATEGORIES) {
    const s = settings[id];
    out(
      s.enabled
        ? `[OFFER] Auto-offer ON for ${label} (gameId ${cfg.offer.gameId} / boostingCategoryId ${id}): ${describeOffer(offerConfigFor(cfg.offer, id, s))} (one offer per request)`
        : `[OFFER] Auto-offer OFF for ${label} (boostingCategoryId ${id})`,
    );
  }
  out('[STATUS] Listening for new notifications... (Ctrl+C to stop)');
  if (cfg.openBrowser) openInBrowser(url);

  let statsTimer: NodeJS.Timeout | undefined;
  if (cfg.statsIntervalMs > 0) {
    statsTimer = setInterval(() => {
      out(
        `[STAT] ${stamp(Date.now())} polls=${polls} errors=${errors} rtt last=${Math.round(lastRtt)}ms avg=${polls ? Math.round(rttSum / polls) : 0}ms` +
          ` interval=${listener.intervalMs}ms detected=${detected}`,
      );
    }, cfg.statsIntervalMs);
    statsTimer.unref();
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) process.exit(130); // second Ctrl+C: exit immediately
    stopping = true;
    out('\n[STOP] Shutting down...');
    ctrl.abort();
    if (statsTimer) clearInterval(statsTimer);
    await Promise.race([running, new Promise((r) => setTimeout(r, 2000))]);
    await writer.flush();
    tokens.stop();
    await web.close();
    http.close();
    out(`[STOP] Done. polls=${polls} detected=${detected}`);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  const running = listener.run(ctrl.signal);
  await running;
}

main().catch((e) => fail(`[FATAL] ${errMsg(e)}`));
