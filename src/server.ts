// Local web page with live push (Server-Sent Events) and the auto-offer settings panel.
// Bound to 127.0.0.1 only: the page shows buyer usernames and order details, so it is
// never exposed to the network.
import http from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { itemDate, itemId, type NotificationItem } from './notifications.js';
import type { OfferSettings } from './offers.js';

export interface FeedEntry {
  id: string;
  item: NotificationItem;
  /** true = detected live by this listener; false = already existed when it started. */
  live: boolean;
  detectedAt?: number;
  rttMs?: number;
  eventAgeMs?: number;
  offer?: { ok: boolean; status: number; error?: string; at: number };
}

export interface OfferCategoryView {
  id: string;
  label: string;
  settings: OfferSettings;
}

export interface OfferPanel {
  /** One entry per category that can get auto-offers, in page order. */
  get(): OfferCategoryView[];
  /** Validate + apply + persist one category (input.categoryId). Returns an error message for the page on failure. */
  save(input: unknown): Promise<{ ok: true; value: OfferSettings; categoryId: string } | { ok: false; error: string }>;
  deliveryTimes: readonly string[];
  currencies: readonly string[];
  maxMessageLength: number;
}

export interface LiveStats {
  status: 'starting' | 'live' | 'retrying';
  message?: string;
  lastRttMs?: number;
  avgRttMs?: number;
  lastPollAt?: number;
  polls: number;
  errors: number;
  intervalMs: number;
  detected: number;
  offersSent: number;
  offersFailed: number;
  startedAt: number;
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

const SESSION_COOKIE = 'eldo_session';
const SESSION_TTL_MS = 30 * 24 * 3600_000;

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

function getCookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function isHttps(req: http.IncomingMessage): boolean {
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

function loginPage(error = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eldorado Notifications - Login</title>
<style>
:root{--bg:#0b0d12;--line:#232a37;--text:#e8ebf1;--muted:#8b94a7;--gold:#f5b82e;--red:#f87171}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:radial-gradient(900px 500px at 20% -10%,#1b1a12,transparent 60%),var(--bg);color:var(--text);font:14px/1.45 "Segoe UI",system-ui,sans-serif}
form{width:100%;max-width:340px;background:#11141b;border:1px solid var(--line);border-radius:16px;padding:26px}
h1{font-size:17px;margin:0 0 4px}p{color:var(--muted);margin:0 0 18px;font-size:13px}
input{width:100%;background:#0a0c10;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:11px 12px;font:inherit;outline:none}
input:focus{border-color:rgba(245,184,46,.6)}
button{margin-top:12px;width:100%;border:0;border-radius:10px;padding:11px;font:600 14px inherit;cursor:pointer;background:linear-gradient(135deg,#ffd36b,var(--gold));color:#1a1405}
.err{color:var(--red);font-size:13px;margin-top:10px;min-height:18px}
</style></head><body>
<form method="post" action="/login">
<h1>🔔 Eldorado Notifications</h1><p>Enter your dashboard password.</p>
<input type="password" name="password" autocomplete="current-password" autofocus required>
<button type="submit">Log in</button>
<div class="err">${error.replace(/[<>&"]/g, '')}</div>
</form></body></html>`;
}

export class WebServer {
  private readonly clients = new Set<http.ServerResponse>();
  private readonly feed: FeedEntry[] = [];
  private readonly server: http.Server;
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly sessions = new Map<string, number>(); // token -> expiry
  private readonly failedLogins: number[] = [];
  private readonly passwordHash: Buffer | undefined;
  stats: LiveStats;

  constructor(
    private readonly htmlPath: string,
    intervalMs: number,
    private readonly panel: OfferPanel,
    private readonly maxFeed = 200,
    /** When set, every page/API request needs a login (required when the page is reachable from the internet). */
    password?: string,
  ) {
    this.passwordHash = password ? sha256(password) : undefined;
    this.stats = { status: 'starting', polls: 0, errors: 0, intervalMs, detected: 0, offersSent: 0, offersFailed: 0, startedAt: Date.now() };
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        this.heartbeat = setInterval(() => this.broadcastRaw(': ping\n\n'), 15_000);
        this.heartbeat.unref();
        resolve();
      });
    });
  }

  /** Notifications that already existed at startup (shown dimmed under "Earlier"). */
  addExisting(items: NotificationItem[]): void {
    const sorted = [...items].sort((a, b) => (itemDate(b) ?? 0) - (itemDate(a) ?? 0));
    for (const item of sorted) {
      const id = itemId(item);
      if (!id || this.feed.some((e) => e.id === id)) continue;
      this.feed.push({ id, item, live: false });
    }
    this.trim();
    this.broadcast('init', this.snapshot());
  }

  pushNew(item: NotificationItem, detectedAt: number, rttMs: number): void {
    const id = itemId(item)!;
    const d = itemDate(item);
    this.feed.unshift({ id, item, live: true, detectedAt, rttMs: Math.round(rttMs), eventAgeMs: d === undefined ? undefined : detectedAt - d });
    this.trim();
    this.broadcast('notification', this.feed[0]);
  }

  pushOffer(notificationId: string, r: { ok: boolean; status: number; error?: string }): void {
    const offer = { ok: r.ok, status: r.status, error: r.error, at: Date.now() };
    const entry = this.feed.find((e) => e.id === notificationId);
    if (entry) entry.offer = offer;
    this.broadcast('offer', { id: notificationId, offer });
  }

  /** Port actually bound (useful with port 0). */
  get port(): number {
    const a = this.server.address();
    return typeof a === 'object' && a ? a.port : 0;
  }

  pushStats(): void {
    this.broadcast('stats', this.stats);
  }

  close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.end();
    this.clients.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private trim(): void {
    if (this.feed.length > this.maxFeed) this.feed.length = this.maxFeed;
  }

  private panelState() {
    return {
      categories: this.panel.get(),
      deliveryTimes: this.panel.deliveryTimes,
      currencies: this.panel.currencies,
      maxMessageLength: this.panel.maxMessageLength,
    };
  }

  private snapshot() {
    return { feed: this.feed, stats: this.stats, offerPanel: this.panelState() };
  }

  private broadcast(event: string, data: unknown): void {
    if (this.clients.size === 0) return;
    this.broadcastRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcastRaw(chunk: string): void {
    for (const c of this.clients) c.write(chunk);
  }

  /**
   * Only the page itself may change settings: it must send JSON with a custom header (other
   * sites cannot without a CORS preflight, which is never answered) from this same origin.
   */
  private async handleSaveSettings(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (req.headers['x-eldo-page'] !== '1' || !String(req.headers['content-type']).startsWith('application/json') || (origin && origin !== `http://${host}` && origin !== `https://${host}`)) {
      reply(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 16_384) {
        reply(res, 413, { ok: false, error: 'too large' });
        return;
      }
    }
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      reply(res, 400, { ok: false, error: 'invalid JSON' });
      return;
    }
    const r = await this.panel.save(input);
    if (!r.ok) {
      reply(res, 400, r);
      return;
    }
    this.broadcast('offerPanel', this.panelState());
    reply(res, 200, { ok: true, settings: r.value, categoryId: r.categoryId });
  }

  // ---- login ------------------------------------------------------------------------------

  private isLoggedIn(req: http.IncomingMessage): boolean {
    if (!this.passwordHash) return true;
    const token = getCookie(req, SESSION_COOKIE);
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (!exp || exp < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  private async handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const html = (status: number, body: string) =>
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' }).end(body);
    if (req.method === 'GET') {
      html(200, loginPage());
      return;
    }
    const now = Date.now();
    while (this.failedLogins.length && this.failedLogins[0] < now - 10 * 60_000) this.failedLogins.shift();
    if (this.failedLogins.length >= 10) {
      html(429, loginPage('Too many attempts. Wait 10 minutes.'));
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4096) break;
    }
    const password = new URLSearchParams(body).get('password') ?? '';
    if (!this.passwordHash || !timingSafeEqual(sha256(password), this.passwordHash)) {
      this.failedLogins.push(now);
      await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      html(401, loginPage('Wrong password.'));
      return;
    }
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, now + SESSION_TTL_MS);
    const cookie = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${isHttps(req) ? '; Secure' : ''}`;
    res.writeHead(303, { location: '/', 'set-cookie': cookie, 'cache-control': 'no-store' }).end();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/login' && (req.method === 'GET' || req.method === 'POST')) {
      await this.handleLogin(req, res);
      return;
    }
    if (path === '/logout') {
      const token = getCookie(req, SESSION_COOKIE);
      if (token) this.sessions.delete(token);
      res.writeHead(303, { location: '/login', 'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0`, 'cache-control': 'no-store' }).end();
      return;
    }
    if (!this.isLoggedIn(req)) {
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) res.writeHead(303, { location: '/login', 'cache-control': 'no-store' }).end();
      else reply(res, 401, { ok: false, error: 'login required' });
      return;
    }
    if (path === '/api/session') {
      reply(res, 200, { ok: true, auth: !!this.passwordHash });
      return;
    }
    if (req.method === 'POST' && path === '/api/offer-settings') {
      await this.handleSaveSettings(req, res);
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (path === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.socket?.setNoDelay(true);
      res.write(`retry: 1000\nevent: init\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }
    if (path === '/' || path === '/index.html') {
      try {
        const html = await readFile(this.htmlPath);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain' }).end('public/index.html is missing');
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}
