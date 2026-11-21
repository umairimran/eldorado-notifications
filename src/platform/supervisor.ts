// Runs one bot process per account (node dist/src/index.js), each with its own data folder,
// port and Eldorado keys (passed as environment variables, never written to disk in plain
// text). Restarts crashed bots with backoff, keeps a log file per bot and live counters.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { localDate } from './store.js';
import { redact } from './security.js';

export interface BotSpec {
  username: string;
  port: number;
  clientId: string;
  clientSecret: string;
  pollIntervalMs: number;
}

export type BotStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface BotInfo {
  status: BotStatus;
  startedAt?: number;
  restarts: number;
  lastError?: string;
  lastExit?: { code: number | null; at: number };
  offersSentToday: number;
  offersFailedToday: number;
  lastStat?: string;
}

interface Bot {
  spec: BotSpec;
  wanted: boolean;
  child?: ChildProcess;
  log?: WriteStream;
  timer?: NodeJS.Timeout;
  rapidFailures: number;
  day: string;
  info: BotInfo;
}

const LOG_MAX_BYTES = 20 * 1024 * 1024;

export class Supervisor {
  private readonly bots = new Map<string, Bot>();

  constructor(
    private readonly o: {
      /** Absolute path of dist/src/index.js. */
      botEntry: string;
      /** One subfolder per account: <customersDir>/<username>/.state, logs/. */
      customersDir: string;
      log?: (line: string) => void;
    },
  ) {}

  dataDir(username: string): string {
    return join(this.o.customersDir, username);
  }

  logFile(username: string): string {
    return join(this.dataDir(username), 'logs', 'bot.log');
  }

  info(username: string): BotInfo {
    const b = this.bots.get(username);
    if (!b) return { status: 'stopped', restarts: 0, offersSentToday: 0, offersFailedToday: 0 };
    this.rollDay(b);
    return { ...b.info };
  }

  runningCount(): number {
    let n = 0;
    for (const b of this.bots.values()) if (b.info.status === 'running') n++;
    return n;
  }

  /** Start (or restart with new settings) the bot for this account. */
  async start(spec: BotSpec): Promise<void> {
    const existing = this.bots.get(spec.username);
    if (existing) await this.stop(spec.username);
    const b: Bot = {
      spec,
      wanted: true,
      rapidFailures: 0,
      day: localDate(),
      info: { status: 'starting', restarts: 0, offersSentToday: existing?.info.offersSentToday ?? 0, offersFailedToday: existing?.info.offersFailedToday ?? 0 },
    };
    if (existing && existing.day !== b.day) b.info.offersSentToday = b.info.offersFailedToday = 0;
    this.bots.set(spec.username, b);
    await mkdir(join(this.dataDir(spec.username), 'logs'), { recursive: true });
    await this.launch(b);
  }

  async stop(username: string): Promise<void> {
    const b = this.bots.get(username);
    if (!b) return;
    b.wanted = false;
    if (b.timer) clearTimeout(b.timer);
    const child = b.child;
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((r) => child.once('exit', () => r()));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    b.log?.end();
    b.info.status = 'stopped';
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.bots.keys()].map((u) => this.stop(u)));
  }

  /** Forget a stopped bot entirely (account deleted). */
  forget(username: string): void {
    this.bots.delete(username);
  }

  /** Last lines of a bot's log, with its secrets hidden. */
  async tail(username: string, maxLines = 200): Promise<string[]> {
    const file = this.logFile(username);
    let fh;
    try {
      fh = await open(file, 'r');
      const { size } = await fh.stat();
      const len = Math.min(size, 96 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const b = this.bots.get(username);
      const text = redact(buf.toString('utf8'), [b?.spec.clientSecret, b?.spec.clientId]);
      return text.split(/\r?\n/).slice(len < size ? 1 : 0).slice(-maxLines);
    } catch {
      return [];
    } finally {
      await fh?.close();
    }
  }

  private rollDay(b: Bot): void {
    const today = localDate();
    if (b.day !== today) {
      b.day = today;
      b.info.offersSentToday = 0;
      b.info.offersFailedToday = 0;
    }
  }

  private async openLog(b: Bot): Promise<WriteStream> {
    const file = this.logFile(b.spec.username);
    try {
      if ((await stat(file)).size > LOG_MAX_BYTES) await rename(file, `${file}.old`);
    } catch {
      /* no log yet */
    }
    return createWriteStream(file, { flags: 'a' });
  }

  private async launch(b: Bot): Promise<void> {
    if (!b.wanted) return;
    b.log?.end();
    b.log = await this.openLog(b);
    const { spec } = b;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('ELDORADO_') || k.startsWith('OFFER_') || k.startsWith('PLATFORM_') || k === 'DASHBOARD_PASSWORD' || k === 'AUTO_OFFER') delete env[k];
    Object.assign(env, {
      ELDORADO_DATA_DIR: this.dataDir(spec.username),
      ELDORADO_CLIENT_ID: spec.clientId,
      ELDORADO_CLIENT_SECRET: spec.clientSecret,
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(spec.port),
      POLL_INTERVAL_MS: String(spec.pollIntervalMs),
      OPEN_BROWSER: 'false',
      AUTO_OFFER: 'false', // only used before the customer saves settings on the page
      OFFER_GAME_ID: '16',
    });
    b.log.write(`\r\n===== ${new Date().toISOString()} starting bot (port ${spec.port}) =====\r\n`);
    b.info.status = 'starting';
    b.info.startedAt = Date.now();
    b.info.lastError = undefined;
    const child = spawn(process.execPath, [this.o.botEntry], { cwd: this.dataDir(spec.username), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    b.child = child;
    const onLine = (line: string) => this.onLine(b, line);
    for (const s of [child.stdout!, child.stderr!]) {
      let buf = '';
      s.setEncoding('utf8');
      s.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) !== -1) {
          onLine(buf.slice(0, i).replace(/\r$/, ''));
          buf = buf.slice(i + 1);
        }
      });
    }
    child.on('error', (e) => {
      b.info.lastError = `could not start: ${e.message}`;
    });
    child.on('exit', (code) => {
      if (b.child !== child) return;
      b.child = undefined;
      b.info.lastExit = { code, at: Date.now() };
      b.log?.write(`===== ${new Date().toISOString()} bot exited (code ${code}) =====\r\n`);
      if (!b.wanted) {
        b.info.status = 'stopped';
        return;
      }
      const ranMs = Date.now() - (b.info.startedAt ?? Date.now());
      b.rapidFailures = ranMs < 60_000 ? b.rapidFailures + 1 : 0;
      b.info.status = 'error';
      b.info.lastError ??= `bot stopped unexpectedly (exit code ${code})`;
      const delay = Math.min(5000 * 2 ** Math.max(0, b.rapidFailures - 1), 5 * 60_000);
      b.info.restarts++;
      b.timer = setTimeout(() => void this.launch(b), delay);
    });
  }

  private onLine(b: Bot, line: string): void {
    const safe = redact(line, [b.spec.clientSecret, b.spec.clientId]);
    b.log?.write(safe + '\r\n');
    this.rollDay(b);
    if (line.startsWith('[OFFER SENT]')) b.info.offersSentToday++;
    else if (line.startsWith('[OFFER FAILED]')) b.info.offersFailedToday++;
    else if (line.startsWith('[STAT]')) b.info.lastStat = safe;
    else if (line.startsWith('[STATUS] Listening')) {
      b.info.status = 'running';
      b.rapidFailures = 0;
    } else if (line.startsWith('[AUTH] Authentication failed')) b.info.lastError = 'Eldorado rejected the API keys (check or replace them)';
    else if (line.startsWith('[WEB] Could not start')) b.info.lastError = safe.slice(0, 200);
    else if (line.startsWith('[FATAL]')) b.info.lastError = safe.slice(0, 200);
  }
}
