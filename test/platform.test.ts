import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RateLimiter, SessionSigner, decryptSecret, encryptSecret, generatePassword, hashPassword, verifyPassword } from '../src/platform/security.js';
import { Store, addMonths, daysLeft, localDate, type Account } from '../src/platform/store.js';
import { PlatformServer, type BotRunner } from '../src/platform/server.js';
import type { BotInfo, BotSpec } from '../src/platform/supervisor.js';

test('passwords are hashed and verified; secrets encrypt and fail when tampered', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(h.startsWith('scrypt$') && !h.includes('correct'));
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('x', undefined), false);

  const key = Buffer.alloc(32, 7);
  const box = encryptSecret(key, 'my-client-secret');
  assert.ok(!box.includes('my-client-secret'));
  assert.equal(decryptSecret(key, box), 'my-client-secret');
  const parts = box.split(':');
  parts[3] = Buffer.from('tampered!!').toString('base64');
  assert.throws(() => decryptSecret(key, parts.join(':')));
  assert.throws(() => decryptSecret(Buffer.alloc(32, 8), box));

  const pw = generatePassword();
  assert.equal(pw.length, 16);
  assert.match(pw, /^[a-km-zA-HJ-NP-Z2-9]+$/);
});

test('session tokens: valid, tamper-proof, expire', () => {
  const s = new SessionSigner(Buffer.alloc(32, 1));
  const t = s.sign('ali123', 3, 60_000, 1_000);
  assert.deepEqual(s.verify(t, 2_000), { username: 'ali123', version: 3 });
  assert.equal(s.verify(t, 70_000), undefined);
  assert.equal(s.verify(t.replace('ali123', 'admin'), 2_000), undefined);
  assert.equal(new SessionSigner(Buffer.alloc(32, 2)).verify(t, 2_000), undefined);
  const r = new RateLimiter(2, 1000);
  r.hit('k', 0);
  r.hit('k', 10);
  assert.equal(r.blocked('k', 20), true);
  assert.equal(r.blocked('k', 2000), false);
});

test('dates: +months and days left', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-22', 1), '2026-12-22');
  assert.equal(addMonths('2026-12-15', 2), '2027-02-15');
  assert.equal(daysLeft('2026-11-25', '2026-11-22'), 3);
  assert.equal(daysLeft('2026-11-21', '2026-11-22'), -1);
});

// ---- website -------------------------------------------------------------------------------

class FakeRunner implements BotRunner {
  started: BotSpec[] = [];
  stopped: string[] = [];
  async start(spec: BotSpec) {
    this.started.push(spec);
  }
  async stop(u: string) {
    this.stopped.push(u);
  }
  forget() {}
  info(): BotInfo {
    return { status: 'running', restarts: 0, offersSentToday: 0, offersFailedToday: 0 };
  }
  async tail() {
    return ['[OFFER SENT] ok'];
  }
  runningCount() {
    return this.started.length;
  }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'plat-'));
  const store = await Store.open(dir);
  // fake "customer bot": serves a page, echoes cookies it received
  let seenCookie: string | undefined = 'unset';
  const bot = http.createServer((req, res) => {
    seenCookie = req.headers.cookie;
    if (req.url === '/') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><body><h1>bot page</h1></body></html>');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: req.url }));
  });
  await new Promise<void>((r) => bot.listen(0, '127.0.0.1', () => r()));
  const botPort = (bot.address() as { port: number }).port;

  const now = new Date().toISOString();
  const mk = async (username: string, role: Account['role'], password: string, extra: Partial<Account> = {}) =>
    store.put({ username, name: username.toUpperCase(), role, passwordHash: await hashPassword(password), sessionVersion: 1, enabled: true, createdAt: now, updatedAt: now, ...extra });
  await mk('admin', 'admin', 'admin-password-123');
  await mk('cust1', 'customer', 'cust1-password', {
    paidUntil: addMonths(localDate(), 1),
    bot: { port: botPort, pollIntervalMs: 1000, clientIdBox: store.encrypt('id-1'), clientSecretBox: store.encrypt('secret-1'), keyHint: 't-1' },
  });

  const runner = new FakeRunner();
  let keysOk = true;
  const server = new PlatformServer({
    store,
    runner,
    signer: new SessionSigner(Buffer.alloc(32, 9)),
    verifyKeys: async () => (keysOk ? { ok: true } : { ok: false, error: 'Eldorado rejected these API keys.' }),
    adminHtmlPath: resolve('public', 'platform', 'admin.html'),
  });
  await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.port}`;

  const login = async (username: string, password: string) => {
    const r = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ username, password }), redirect: 'manual' });
    return { status: r.status, location: r.headers.get('location'), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  const adminPost = (cookie: string, path: string, body: unknown, headers: Record<string, string> = { 'x-platform': '1' }) =>
    fetch(`${base}/admin/api/${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  return {
    dir, store, runner, server, base, login, adminPost,
    setKeysOk: (v: boolean) => (keysOk = v),
    seenCookie: () => seenCookie,
    close: async () => {
      await server.close();
      await new Promise((r) => bot.close(r));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('login required; customers reach only their own bot; admin panel is admin-only', async () => {
  const t = await setup();
  try {
    const page = await fetch(`${t.base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/login');
    assert.equal((await fetch(`${t.base}/events`)).status, 401);
    assert.equal((await fetch(`${t.base}/admin/api/state`)).status, 401);

    assert.equal((await t.login('cust1', 'nope')).status, 401);
    const c = await t.login('cust1', 'cust1-password');
    assert.equal(c.status, 303);
    assert.equal(c.location, '/');

    const home = await fetch(`${t.base}/`, { headers: { cookie: `${c.cookie}; other=1` } });
    const html = await home.text();
    assert.match(html, /bot page/);
    assert.match(html, /platformBar/); // logged-in bar with "Log out"
    assert.equal(t.seenCookie(), 'other=1'); // the platform login cookie never reaches the bot
    assert.deepEqual(await (await fetch(`${t.base}/api/x?y=1`, { headers: { cookie: c.cookie! } })).json(), { path: '/api/x?y=1' });

    assert.equal((await fetch(`${t.base}/admin/api/state`, { headers: { cookie: c.cookie! } })).status, 403);
    assert.equal((await fetch(`${t.base}/admin`, { headers: { cookie: c.cookie! } })).status, 403);

    const a = await t.login('admin', 'admin-password-123');
    assert.equal(a.location, '/admin');
    const st = await (await fetch(`${t.base}/admin/api/state`, { headers: { cookie: a.cookie! } })).json();
    assert.equal(st.accounts.length, 2);
    assert.ok(!JSON.stringify(st).includes('secret-1') && !JSON.stringify(st).includes('passwordHash'));
    assert.equal((await fetch(`${t.base}/admin`, { headers: { cookie: a.cookie! } })).status, 200);
  } finally {
    await t.close();
  }
});

test('admin adds a customer: keys checked, stored encrypted, bot started, login works', async () => {
  const t = await setup();
  try {
    const a = (await t.login('admin', 'admin-password-123')).cookie!;
    assert.equal((await t.adminPost(a, 'accounts', { name: 'Ali' }, {})).status, 403); // no x-platform header

    t.setKeysOk(false);
    let r = await t.adminPost(a, 'accounts', { name: 'Ali', username: 'ali123', clientId: 'id-2', clientSecret: 'secret-2' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /rejected/);
    assert.equal(t.store.get('ali123'), undefined);

    t.setKeysOk(true);
    r = await t.adminPost(a, 'accounts', { name: 'Ali', username: 'ali123', clientId: 'id-1', clientSecret: 'x' });
    assert.match((await r.json()).error, /already used by "cust1"/);

    r = await t.adminPost(a, 'accounts', { name: 'Ali', username: 'ali123', clientId: 'id-2', clientSecret: 'secret-2' });
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.username, 'ali123');
    assert.equal(j.password.length, 16);
    assert.equal(t.runner.started.at(-1)!.clientSecret, 'secret-2');

    const raw = await readFile(join(t.dir, 'accounts.json'), 'utf8');
    assert.ok(!raw.includes('secret-2') && !raw.includes(j.password));
    assert.equal(t.store.keysOf(t.store.get('ali123')!)!.clientSecret, 'secret-2');
    assert.equal((await t.login('ali123', j.password)).status, 303);
  } finally {
    await t.close();
  }
});

test('disable logs the customer out and blocks login; enable / +1 month / expiry', async () => {
  const t = await setup();
  try {
    const a = (await t.login('admin', 'admin-password-123')).cookie!;
    const c = (await t.login('cust1', 'cust1-password')).cookie!;
    assert.equal((await (await t.adminPost(a, 'accounts/cust1/disable', {})).json()).ok, true);
    assert.deepEqual(t.runner.stopped, ['cust1']);
    assert.equal((await fetch(`${t.base}/api/x`, { headers: { cookie: c } })).status, 401);
    assert.equal((await t.login('cust1', 'cust1-password')).status, 403);
    assert.equal((await t.adminPost(a, 'accounts/admin/disable', {})).status, 400); // never lock out the admin

    assert.equal((await (await t.adminPost(a, 'accounts/cust1/enable', {})).json()).ok, true);
    assert.equal((await t.login('cust1', 'cust1-password')).status, 303);

    // paid-until passed -> automatically disabled; +1 month re-enables
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterday = localDate(d);
    await t.store.put({ ...t.store.get('cust1')!, paidUntil: yesterday });
    assert.deepEqual(await t.server.checkExpiry(), ['cust1']);
    assert.equal(t.store.get('cust1')!.disabledReason, 'expired');
    assert.equal((await t.adminPost(a, 'accounts/cust1/enable', {})).status, 400);
    const ext = await (await t.adminPost(a, 'accounts/cust1/extend', { months: 1 })).json();
    assert.equal(ext.ok, true);
    assert.equal(ext.account.enabled, true);
    assert.equal(ext.account.paidUntil, addMonths(localDate(), 1));
  } finally {
    await t.close();
  }
});

test('reset password, delete needs the username typed, wrong logins are rate limited', async () => {
  const t = await setup();
  try {
    const a = (await t.login('admin', 'admin-password-123')).cookie!;
    const rp = await (await t.adminPost(a, 'accounts/cust1/reset-password', {})).json();
    assert.equal((await t.login('cust1', 'cust1-password')).status, 401);
    assert.equal((await t.login('cust1', rp.password)).status, 303);

    assert.equal((await t.adminPost(a, 'accounts/cust1/delete', { confirm: 'wrong' })).status, 400);
    assert.equal((await (await t.adminPost(a, 'accounts/cust1/delete', { confirm: 'cust1' })).json()).ok, true);
    assert.equal(t.store.get('cust1'), undefined);

    for (let i = 0; i < 10; i++) await t.login('admin', 'bad');
    assert.equal((await t.login('admin', 'admin-password-123')).status, 429);
  } finally {
    await t.close();
  }
});
