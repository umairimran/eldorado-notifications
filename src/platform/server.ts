// The platform website (one link for everyone):
//   /login, /logout          username + password login for admin and customers
//   /admin, /admin/api/...   admin panel (admin only): add / disable / enable / delete customers,
//                            API keys, passwords, paid-until dates, logs
//   everything else          proxied (incl. the live SSE stream) to the logged-in account's own bot
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { addMonths, daysLeft, localDate, type Account, type Store } from './store.js';
import type { BotInfo, BotSpec } from './supervisor.js';
import { RateLimiter, SessionSigner, USERNAME_RE, generatePassword, hashPassword, verifyPassword } from './security.js';

export interface BotRunner {
  start(spec: BotSpec): Promise<void>;
  stop(username: string): Promise<void>;
  forget(username: string): void;
  info(username: string): BotInfo;
  tail(username: string, maxLines?: number): Promise<string[]>;
  runningCount(): number;
}

export type KeyVerifier = (clientId: string, clientSecret: string) => Promise<{ ok: true } | { ok: false; error: string }>;

export interface PlatformOptions {
  store: Store;
  runner: BotRunner;
  signer: SessionSigner;
  verifyKeys: KeyVerifier;
  adminHtmlPath: string;
  /** Move a deleted account's data folder out of the way (not hard-deleted). */
  archiveData?: (username: string) => Promise<void>;
  lastBackupAt?: () => number | undefined;
  sessionTtlMs?: number;
  now?: () => Date;
}

const COOKIE = 'plat_session';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function getCookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function stripCookie(header: string | undefined, name: string): string | undefined {
  const kept = (header ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && p.split('=')[0].trim() !== name);
  return kept.length ? kept.join('; ') : undefined;
}

const isHttps = (req: http.IncomingMessage) => String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
const clientIp = (req: http.IncomingMessage) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';
const wantsHtml = (req: http.IncomingMessage) => req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html');

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new HttpError(413, 'Request too large');
  }
  return body;
}

const PAGE_CSS = `:root{--bg:#0b0d12;--line:#232a37;--text:#e8ebf1;--muted:#8b94a7;--gold:#f5b82e;--red:#f87171}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:radial-gradient(900px 500px at 20% -10%,#1b1a12,transparent 60%),var(--bg);color:var(--text);font:14px/1.45 "Segoe UI",system-ui,sans-serif}
.box{width:100%;max-width:360px;background:#11141b;border:1px solid var(--line);border-radius:16px;padding:26px}
h1{font-size:17px;margin:0 0 4px}p{color:var(--muted);margin:0 0 18px;font-size:13px}
label{display:block;color:var(--muted);font-size:12px;margin:10px 0 4px}
input{width:100%;background:#0a0c10;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:11px 12px;font:inherit;outline:none}
input:focus{border-color:rgba(245,184,46,.6)}
button{margin-top:16px;width:100%;border:0;border-radius:10px;padding:11px;font:600 14px inherit;cursor:pointer;background:linear-gradient(135deg,#ffd36b,var(--gold));color:#1a1405}
.err{color:var(--red);font-size:13px;margin-top:12px;min-height:18px}a{color:var(--gold)}`;

function loginPage(error = '', username = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seller Bot - Login</title><style>${PAGE_CSS}</style></head><body>
<form class="box" method="post" action="/login">
<h1>🔔 Eldorado Seller Bot</h1><p>Log in with the username and password you were given.</p>
<label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(username)}" required ${username ? '' : 'autofocus'}>
<label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password" required ${username ? 'autofocus' : ''}>
<button type="submit">Log in</button>
<div class="err">${esc(error)}</div>
</form></body></html>`;
}

function messagePage(title: string, text: string, refreshSec?: number): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSec ? `<meta http-equiv="refresh" content="${refreshSec}">` : ''}<title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body>
<div class="box"><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/logout">Log out</a></p></div></body></html>`;
}

function userBar(a: Account): string {
  const admin = a.role === 'admin' ? `<a href="/admin" style="color:#f5b82e;text-decoration:none;font-weight:600">Admin panel</a><span style="opacity:.4">·</span>` : '';
  return `<div id="platformBar" style="position:fixed;right:14px;bottom:14px;z-index:9999;display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:999px;background:#11141bee;border:1px solid #232a37;color:#c9cfdb;font:12px 'Segoe UI',system-ui,sans-serif;box-shadow:0 8px 30px -10px #000">👤 <b style="color:#e8ebf1">${esc(a.name)}</b><span style="opacity:.4">·</span>${admin}<a href="/logout" style="color:#8b94a7;text-decoration:none">Log out</a></div>`;
}

export interface AccountView {
  username: string;
  name: string;
  role: Account['role'];
  enabled: boolean;
  disabledReason?: Account['disabledReason'];
  paidUntil?: string;
  daysLeft?: number;
  notes?: string;
  createdAt: string;
  hasBot: boolean;
  keyHint?: string;
  port?: number;
  pollIntervalMs?: number;
  bot?: BotInfo;
}

export class PlatformServer {
  private readonly server: http.Server;
  private readonly ipLimit = new RateLimiter(20, 10 * 60_000);
  private readonly userLimit = new RateLimiter(10, 10 * 60_000);
  private readonly ttl: number;

  constructor(private readonly o: PlatformOptions) {
    this.ttl = o.sessionTtlMs ?? 30 * 24 * 3600_000;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => {
        const status = e instanceof HttpError ? e.status : 500;
        const msg = e instanceof HttpError ? e.message : 'Internal error';
        if (!(e instanceof HttpError)) process.stderr.write(`[PLATFORM] ${req.method} ${req.url}: ${(e as Error)?.stack ?? e}\n`);
        if (!res.headersSent) json(res, status, { ok: false, error: msg });
        else res.destroy();
      });
    });
    this.server.requestTimeout = 0; // live streams stay open
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  get port(): number {
    const a = this.server.address();
    return typeof a === 'object' && a ? a.port : 0;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  private today(): string {
    return localDate(this.o.now?.() ?? new Date());
  }

  // ---- bots --------------------------------------------------------------------------------

  async startBotFor(a: Account): Promise<void> {
    if (!a.enabled || !a.bot) return;
    const keys = this.o.store.keysOf(a)!;
    await this.o.runner.start({ username: a.username, port: a.bot.port, pollIntervalMs: a.bot.pollIntervalMs, ...keys });
  }

  async startAll(): Promise<void> {
    for (const a of this.o.store.list()) {
      try {
        await this.startBotFor(a);
      } catch (e) {
        process.stderr.write(`[PLATFORM] could not start bot for ${a.username}: ${(e as Error).message}\n`);
      }
    }
  }

  /** Disables customers whose paid-until date has passed. Returns the usernames disabled. */
  async checkExpiry(): Promise<string[]> {
    const today = this.today();
    const done: string[] = [];
    for (const a of this.o.store.list()) {
      if (a.role !== 'customer' || !a.enabled || !a.paidUntil || a.paidUntil >= today) continue;
      await this.o.store.put({ ...a, enabled: false, disabledReason: 'expired', sessionVersion: a.sessionVersion + 1 });
      await this.o.runner.stop(a.username);
      done.push(a.username);
    }
    return done;
  }

  // ---- routing -----------------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/login') return this.login(req, res);
    if (path === '/logout') {
      res.writeHead(303, { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`, 'cache-control': 'no-store' }).end();
      return;
    }
    const acc = this.session(req);
    if (!acc) {
      if (wantsHtml(req)) res.writeHead(303, { location: '/login', 'cache-control': 'no-store' }).end();
      else json(res, 401, { ok: false, error: 'login required' });
      return;
    }
    if (path === '/admin' || path.startsWith('/admin/')) {
      if (acc.role !== 'admin') return json(res, 403, { ok: false, error: 'forbidden' });
      if (path === '/admin' || path === '/admin/') return this.adminPage(res);
      if (path.startsWith('/admin/api/')) return this.adminApi(req, res, acc, path.slice('/admin/api/'.length));
      return json(res, 404, { ok: false, error: 'not found' });
    }
    if (!acc.bot) {
      res.writeHead(303, { location: '/admin', 'cache-control': 'no-store' }).end();
      return;
    }
    this.proxy(req, res, acc);
  }

  private session(req: http.IncomingMessage): Account | undefined {
    const s = this.o.signer.verify(getCookie(req, COOKIE));
    if (!s) return undefined;
    const a = this.o.store.get(s.username);
    return a && a.enabled && a.sessionVersion === s.version ? a : undefined;
  }

  private cookieFor(req: http.IncomingMessage, a: Account): string {
    const token = this.o.signer.sign(a.username, a.sessionVersion, this.ttl);
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.ttl / 1000)}${isHttps(req) ? '; Secure' : ''}`;
  }

  private async login(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const page = (status: number, error = '', username = ''): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' }).end(loginPage(error, username));
    };
    if (req.method !== 'POST') return page(200);
    const ip = clientIp(req);
    const form = new URLSearchParams(await readBody(req, 4096));
    const username = (form.get('username') ?? '').trim().toLowerCase();
    const password = form.get('password') ?? '';
    if (this.ipLimit.blocked(ip) || this.userLimit.blocked(username)) return page(429, 'Too many attempts. Wait 10 minutes and try again.', username);
    const acc = USERNAME_RE.test(username) ? this.o.store.get(username) : undefined;
    const ok = await verifyPassword(password, acc?.passwordHash);
    if (!acc || !ok) {
      this.ipLimit.hit(ip);
      this.userLimit.hit(username);
      await sleep(800);
      return page(401, 'Wrong username or password.', username);
    }
    if (!acc.enabled) {
      const why = acc.disabledReason === 'expired' ? 'Your subscription has ended. Contact the seller to renew it.' : 'Your account is disabled. Contact the seller.';
      return page(403, why, username);
    }
    this.userLimit.reset(username);
    res.writeHead(303, { location: acc.role === 'admin' ? '/admin' : '/', 'set-cookie': this.cookieFor(req, acc), 'cache-control': 'no-store' }).end();
  }

  // ---- proxy to the account's own bot ----------------------------------------------------------

  private proxy(req: http.IncomingMessage, res: http.ServerResponse, a: Account): void {
    const headers = { ...req.headers };
    const cookie = stripCookie(headers.cookie, COOKIE);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const injectBar = req.method === 'GET' && (path === '/' || path === '/index.html');
    if (injectBar) delete headers['accept-encoding'];

    const up = http.request({ host: '127.0.0.1', port: a.bot!.port, method: req.method, path: req.url, headers }, (ur) => {
      const type = String(ur.headers['content-type'] ?? '');
      if (injectBar && ur.statusCode === 200 && type.startsWith('text/html')) {
        const chunks: Buffer[] = [];
        ur.on('data', (c: Buffer) => chunks.push(c));
        ur.on('end', () => {
          const html = Buffer.concat(chunks).toString('utf8').replace('</body>', `${userBar(a)}</body>`);
          const h = { ...ur.headers };
          delete h['content-length'];
          res.writeHead(200, h).end(html);
        });
        return;
      }
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      res.socket?.setNoDelay(true);
      ur.pipe(res);
    });
    up.on('error', () => {
      if (res.headersSent) return void res.destroy();
      if (wantsHtml(req)) {
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end(messagePage('Your bot is starting…', 'This page refreshes by itself in a few seconds. If it takes more than a few minutes, contact the seller.', 5));
      } else json(res, 503, { ok: false, error: 'bot is starting' });
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  }

  // ---- admin panel -------------------------------------------------------------------------

  private async adminPage(res: http.ServerResponse): Promise<void> {
    const html = await readFile(this.o.adminHtmlPath);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' }).end(html);
  }

  view(a: Account): AccountView {
    return {
      username: a.username,
      name: a.name,
      role: a.role,
      enabled: a.enabled,
      disabledReason: a.disabledReason,
      paidUntil: a.paidUntil,
      daysLeft: daysLeft(a.paidUntil, this.today()),
      notes: a.notes,
      createdAt: a.createdAt,
      hasBot: !!a.bot,
      keyHint: a.bot?.keyHint,
      port: a.bot?.port,
      pollIntervalMs: a.bot?.pollIntervalMs,
      bot: a.bot ? this.o.runner.info(a.username) : undefined,
    };
  }

  private async adminApi(req: http.IncomingMessage, res: http.ServerResponse, me: Account, sub: string): Promise<void> {
    if (req.method !== 'GET') {
      // Only the admin page itself can change things (custom header + JSON = no cross-site forms).
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (req.headers['x-platform'] !== '1' || !String(req.headers['content-type']).startsWith('application/json') || (origin && origin !== `http://${host}` && origin !== `https://${host}`)) {
        throw new HttpError(403, 'forbidden');
      }
    }
    const body = req.method === 'POST' ? this.parse(await readBody(req, 64 * 1024)) : {};
    const store = this.o.store;

    if (req.method === 'GET' && sub === 'state') {
      const accounts = store.list().sort((x, y) => (x.role === y.role ? x.username.localeCompare(y.username) : x.role === 'admin' ? -1 : 1));
      return json(res, 200, {
        ok: true,
        me: { username: me.username, name: me.name },
        today: this.today(),
        accounts: accounts.map((a) => this.view(a)),
        system: {
          botsRunning: this.o.runner.runningCount(),
          customers: accounts.filter((a) => a.role === 'customer').length,
          memoryUsedPct: Math.round((1 - freemem() / totalmem()) * 100),
          uptimeSec: Math.round(process.uptime()),
          lastBackupAt: this.o.lastBackupAt?.(),
        },
      });
    }

    if (req.method === 'POST' && sub === 'accounts') return json(res, 200, await this.createCustomer(body));

    if (req.method === 'POST' && sub === 'me/password') {
      const current = String(body.current ?? '');
      const next = String(body.next ?? '');
      if (!(await verifyPassword(current, me.passwordHash))) throw new HttpError(400, 'Current password is wrong');
      if (next.length < 12) throw new HttpError(400, 'New password must be at least 12 characters');
      const updated = { ...me, passwordHash: await hashPassword(next), sessionVersion: me.sessionVersion + 1 };
      await store.put(updated);
      return json(res, 200, { ok: true }, { 'set-cookie': this.cookieFor(req, updated) });
    }

    const m = /^accounts\/([a-z0-9_-]+)\/([a-z-]+)$/.exec(sub);
    if (!m) throw new HttpError(404, 'not found');
    const [, username, action] = m;
    const a = store.get(username);
    if (!a) throw new HttpError(404, 'Customer not found');

    if (req.method === 'GET' && action === 'log') {
      return json(res, 200, { ok: true, lines: a.bot ? await this.o.runner.tail(a.username, 300) : [] });
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    const isSelfAdmin = a.role === 'admin';

    switch (action) {
      case 'enable': {
        if (a.role === 'customer' && a.paidUntil && a.paidUntil < this.today()) throw new HttpError(400, 'Paid-until date has passed. Click "+1 month" first.');
        const u = { ...a, enabled: true, disabledReason: undefined };
        await store.put(u);
        await this.startBotFor(u);
        break;
      }
      case 'disable': {
        if (isSelfAdmin) throw new HttpError(400, 'The admin account cannot be disabled');
        await store.put({ ...a, enabled: false, disabledReason: 'manual', sessionVersion: a.sessionVersion + 1 });
        await this.o.runner.stop(a.username);
        break;
      }
      case 'restart': {
        if (!a.enabled || !a.bot) throw new HttpError(400, 'Enable the customer first');
        await this.startBotFor(a);
        break;
      }
      case 'reset-password': {
        if (isSelfAdmin) throw new HttpError(400, 'Change the admin password under "My account"');
        const password = generatePassword();
        await store.put({ ...a, passwordHash: await hashPassword(password), sessionVersion: a.sessionVersion + 1 });
        return json(res, 200, { ok: true, username: a.username, password });
      }
      case 'extend': {
        if (a.role !== 'customer') throw new HttpError(400, 'Only customers have a paid-until date');
        const months = Number(body.months ?? 1);
        if (!Number.isInteger(months) || months < 1 || months > 24) throw new HttpError(400, 'Months must be 1-24');
        const today = this.today();
        const paidUntil = a.paidUntil && a.paidUntil >= today ? addMonths(a.paidUntil, months) : addMonths(today, months);
        const reenable = !a.enabled && a.disabledReason === 'expired';
        const u = { ...a, paidUntil, ...(reenable ? { enabled: true, disabledReason: undefined } : {}) };
        await store.put(u);
        if (reenable) await this.startBotFor(u);
        break;
      }
      case 'keys': {
        const { clientId, clientSecret } = this.keysFrom(body);
        this.assertKeysUnused(clientId, a.username);
        const v = await this.o.verifyKeys(clientId, clientSecret);
        if (!v.ok) throw new HttpError(400, v.error);
        const u: Account = {
          ...a,
          bot: {
            port: a.bot?.port ?? store.nextPort(),
            pollIntervalMs: a.bot?.pollIntervalMs ?? 1000,
            clientIdBox: store.encrypt(clientId),
            clientSecretBox: store.encrypt(clientSecret),
            keyHint: clientSecret.slice(-4),
          },
        };
        await store.put(u);
        await this.startBotFor(u);
        break;
      }
      case 'update': {
        const u: Account = { ...a };
        if (body.name !== undefined) u.name = this.nameFrom(body.name);
        if (body.notes !== undefined) u.notes = String(body.notes).slice(0, 500);
        if (body.paidUntil !== undefined && a.role === 'customer') {
          const p = String(body.paidUntil);
          if (!DATE_RE.test(p)) throw new HttpError(400, 'Paid until must be a date');
          u.paidUntil = p;
          if (!a.enabled && a.disabledReason === 'expired' && p >= this.today()) Object.assign(u, { enabled: true, disabledReason: undefined });
        }
        let restart = u.enabled !== a.enabled;
        if (body.pollIntervalMs !== undefined && u.bot) {
          const ms = Number(body.pollIntervalMs);
          if (!Number.isInteger(ms) || ms < 1000 || ms > 10_000) throw new HttpError(400, 'Check interval must be 1000-10000 ms');
          restart ||= ms !== u.bot.pollIntervalMs;
          u.bot = { ...u.bot, pollIntervalMs: ms };
        }
        await store.put(u);
        if (restart && u.enabled) await this.startBotFor(u);
        break;
      }
      case 'delete': {
        if (isSelfAdmin) throw new HttpError(400, 'The admin account cannot be deleted');
        if (body.confirm !== a.username) throw new HttpError(400, 'Type the username to confirm');
        await this.o.runner.stop(a.username);
        this.o.runner.forget(a.username);
        await this.o.archiveData?.(a.username);
        await store.remove(a.username);
        return json(res, 200, { ok: true });
      }
      default:
        throw new HttpError(404, 'Unknown action');
    }
    return json(res, 200, { ok: true, account: this.view(store.get(a.username)!) });
  }

  private parse(body: string): Record<string, unknown> {
    if (!body) return {};
    try {
      const v = JSON.parse(body) as unknown;
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      throw new HttpError(400, 'invalid JSON');
    }
  }

  private nameFrom(v: unknown): string {
    const name = String(v ?? '').trim();
    if (!name || name.length > 60) throw new HttpError(400, 'Name is required (max 60 characters)');
    return name;
  }

  private keysFrom(body: Record<string, unknown>): { clientId: string; clientSecret: string } {
    const clientId = String(body.clientId ?? '').trim();
    const clientSecret = String(body.clientSecret ?? '').trim();
    if (!clientId || !clientSecret || clientId.length > 200 || clientSecret.length > 400) throw new HttpError(400, 'Client ID and Client Secret are required');
    return { clientId, clientSecret };
  }

  /** Two bots on one Eldorado account would send double offers. */
  private assertKeysUnused(clientId: string, exceptUsername?: string): void {
    for (const a of this.o.store.list()) {
      if (a.username === exceptUsername || !a.bot) continue;
      if (this.o.store.keysOf(a)?.clientId === clientId) throw new HttpError(400, `These API keys are already used by "${a.username}"`);
    }
  }

  private async createCustomer(body: Record<string, unknown>): Promise<unknown> {
    const store = this.o.store;
    const name = this.nameFrom(body.name);
    const username = String(body.username ?? '').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username: 3-32 characters, lowercase letters, numbers, - or _');
    if (store.get(username)) throw new HttpError(400, 'This username is already taken');
    const { clientId, clientSecret } = this.keysFrom(body);
    const paidUntil = body.paidUntil ? String(body.paidUntil) : addMonths(this.today(), 1);
    if (!DATE_RE.test(paidUntil)) throw new HttpError(400, 'Paid until must be a date');
    this.assertKeysUnused(clientId);
    const v = await this.o.verifyKeys(clientId, clientSecret);
    if (!v.ok) throw new HttpError(400, v.error);

    const password = generatePassword();
    const now = new Date().toISOString();
    const a: Account = {
      username,
      name,
      role: 'customer',
      passwordHash: await hashPassword(password),
      sessionVersion: 1,
      enabled: true,
      paidUntil,
      notes: body.notes ? String(body.notes).slice(0, 500) : undefined,
      bot: { port: store.nextPort(), pollIntervalMs: 1000, clientIdBox: store.encrypt(clientId), clientSecretBox: store.encrypt(clientSecret), keyHint: clientSecret.slice(-4) },
      createdAt: now,
      updatedAt: now,
    };
    if (a.paidUntil! < this.today()) Object.assign(a, { enabled: false, disabledReason: 'expired' });
    await store.put(a);
    await this.startBotFor(a);
    return { ok: true, username, password, account: this.view(store.get(username)!) };
  }
}
