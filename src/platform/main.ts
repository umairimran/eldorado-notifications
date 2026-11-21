// Multi-customer platform: one website (login + admin panel) that runs one Eldorado bot per account.
//   node dist/src/platform/main.js                     -> run the platform (default)
//   node dist/src/platform/main.js set-admin <username> [name]
//        password is read from stdin; creates or updates the admin login (used once at install)
//   node dist/src/platform/main.js import-bot <username> <old bot folder>
//        moves an existing single-user bot (its .env keys + .state) into the platform for that account
//
// Environment: PLATFORM_HOME (default C:\eldorado-platform on Windows, ./platform-home elsewhere),
//              PLATFORM_PORT (default 3100), PLATFORM_HOST (default 127.0.0.1)
import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createHttpClient } from '../http.js';
import { TokenManager } from '../auth.js';
import { PlatformServer, type KeyVerifier } from './server.js';
import { Supervisor } from './supervisor.js';
import { Store, localDate, type Account } from './store.js';
import { SessionSigner, USERNAME_RE, hashPassword } from './security.js';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOME = resolve(process.env.PLATFORM_HOME?.trim() || (process.platform === 'win32' ? 'C:\\eldorado-platform' : join(APP_ROOT, 'platform-home')));
const DATA = join(HOME, 'data');
const CUSTOMERS = join(HOME, 'customers');
const DELETED = join(HOME, 'deleted');
const BACKUPS = join(HOME, 'backups');
const BASE_URL = 'https://www.eldorado.gg';

const out = (s: string) => process.stdout.write(`[PLATFORM] ${new Date().toISOString()} ${s}\n`);
function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

/** Checks keys by requesting a seller token from Eldorado (read-only, nothing is changed). */
const verifyKeys: KeyVerifier = async (clientId, clientSecret) => {
  const http = createHttpClient(15_000);
  const tokens = new TokenManager({ http: http.request, baseUrl: BASE_URL, clientId, clientSecret });
  try {
    await tokens.getToken();
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false, error: /HTTP (400|401|403)/.test(msg) ? 'Eldorado rejected these API keys. Check the Client ID and Client Secret.' : `Could not check the keys with Eldorado: ${msg}` };
  } finally {
    tokens.stop();
    http.close();
  }
};

async function sessionKey(): Promise<Buffer> {
  const file = join(DATA, 'session.key');
  try {
    return Buffer.from((await readFile(file, 'utf8')).trim(), 'hex');
  } catch {
    const { randomBytes } = await import('node:crypto');
    const k = randomBytes(32);
    await writeFile(file, k.toString('hex'), { flag: 'wx' });
    return k;
  }
}

async function readStdin(): Promise<string> {
  let s = '';
  for await (const c of process.stdin) s += c;
  // Windows shells may add a byte-order mark and a trailing newline when piping text.
  return s.replace(/^﻿/, '').replace(/[\r\n]+$/, '');
}

/** Kill bots left running by a previous platform process (e.g. after a crash), so ports are free. */
function killOrphanBots(botEntry: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  const needle = botEntry.replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  return new Promise((r) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, () => r()));
}

let lastBackupAt: number | undefined;
async function backup(store: Store): Promise<void> {
  await mkdir(BACKUPS, { recursive: true });
  await writeFile(join(BACKUPS, `accounts-${localDate()}.json`), store.snapshot());
  lastBackupAt = Date.now();
  const files = (await readdir(BACKUPS)).filter((f) => /^accounts-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 30))) await rm(join(BACKUPS, f), { force: true });
}

async function setAdmin(store: Store, username: string, name: string): Promise<void> {
  if (!USERNAME_RE.test(username)) fail('Username: 3-32 characters, lowercase letters, numbers, - or _');
  const password = await readStdin();
  if (password.length < 12) fail('Password must be at least 12 characters (read from stdin).');
  const existing = store.get(username);
  if (existing && existing.role !== 'admin') fail(`${username} exists and is not an admin`);
  const now = new Date().toISOString();
  const a: Account = existing
    ? { ...existing, name: name || existing.name, passwordHash: await hashPassword(password), sessionVersion: existing.sessionVersion + 1, enabled: true }
    : { username, name: name || 'Admin', role: 'admin', passwordHash: await hashPassword(password), sessionVersion: 1, enabled: true, createdAt: now, updatedAt: now };
  await store.put(a);
  out(`admin login "${username}" saved`);
}

async function importBot(store: Store, username: string, from: string): Promise<void> {
  const a = store.get(username);
  if (!a) fail(`Create the account "${username}" first (set-admin).`);
  const env = parseEnv(await readFile(join(from, '.env'), 'utf8'));
  const clientId = env.ELDORADO_CLIENT_ID?.trim();
  const clientSecret = env.ELDORADO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) fail(`${from}\\.env has no ELDORADO_CLIENT_ID / ELDORADO_CLIENT_SECRET`);
  const v = await verifyKeys(clientId, clientSecret);
  if (!v.ok) fail(v.error);
  const dir = join(CUSTOMERS, username);
  await mkdir(dir, { recursive: true });
  if (existsSync(join(from, '.state'))) await cp(join(from, '.state'), join(dir, '.state'), { recursive: true, force: true });
  await store.put({
    ...a,
    bot: {
      port: a.bot?.port ?? store.nextPort(),
      pollIntervalMs: Number(env.POLL_INTERVAL_MS) >= 1000 ? Number(env.POLL_INTERVAL_MS) : 1000,
      clientIdBox: store.encrypt(clientId),
      clientSecretBox: store.encrypt(clientSecret),
      keyHint: clientSecret.slice(-4),
    },
  });
  out(`bot for "${username}" imported from ${from} (keys verified with Eldorado, settings and offer history copied)`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  await mkdir(DATA, { recursive: true });
  const store = await Store.open(DATA);
  if (cmd === 'set-admin') return setAdmin(store, String(args[0] ?? ''), args.slice(1).join(' '));
  if (cmd === 'import-bot') return importBot(store, String(args[0] ?? ''), resolve(String(args[1] ?? '')));
  if (cmd) fail(`Unknown command "${cmd}"`);

  const botEntry = join(APP_ROOT, 'dist', 'src', 'index.js');
  if (!existsSync(botEntry)) fail(`Bot program missing: ${botEntry} (run npm run build)`);
  await killOrphanBots(botEntry);
  const supervisor = new Supervisor({ botEntry, customersDir: CUSTOMERS });
  const server = new PlatformServer({
    store,
    runner: supervisor,
    signer: new SessionSigner(await sessionKey()),
    verifyKeys,
    adminHtmlPath: join(APP_ROOT, 'public', 'platform', 'admin.html'),
    archiveData: async (username) => {
      const src = join(CUSTOMERS, username);
      if (!existsSync(src)) return;
      await mkdir(DELETED, { recursive: true });
      await rename(src, join(DELETED, `${username}-${Date.now()}`));
    },
    lastBackupAt: () => lastBackupAt,
  });

  const port = Number(process.env.PLATFORM_PORT || 3100);
  const host = process.env.PLATFORM_HOST?.trim() || '127.0.0.1';
  await server.listen(port, host);
  out(`website on http://${host}:${port} (home ${HOME})`);
  if (!store.list().some((a) => a.role === 'admin')) out('WARNING: no admin login yet - run: node dist/src/platform/main.js set-admin admin');

  const expired = await server.checkExpiry();
  if (expired.length) out(`disabled (paid-until passed): ${expired.join(', ')}`);
  await server.startAll();
  const stopped = store.list().filter((a) => a.enabled && a.bot && a.botStopped).map((a) => a.username);
  out(`started ${store.list().filter((a) => a.enabled && a.bot && !a.botStopped).length} bot(s)${stopped.length ? `; stopped by admin: ${stopped.join(', ')}` : ''}`);
  await backup(store).catch((e) => out(`backup failed: ${(e as Error).message}`));

  const expiryTimer = setInterval(() => {
    server.checkExpiry().then((d) => d.length && out(`disabled (paid-until passed): ${d.join(', ')}`), () => {});
  }, 10 * 60_000);
  const backupTimer = setInterval(() => void backup(store).catch(() => {}), 24 * 3600_000);

  const shutdown = async () => {
    clearInterval(expiryTimer);
    clearInterval(backupTimer);
    out('stopping...');
    await supervisor.stopAll();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => fail(`[PLATFORM] FATAL ${(e as Error)?.stack ?? e}`));
