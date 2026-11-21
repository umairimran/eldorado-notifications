// Platform data: one JSON file (data/accounts.json) with every login, plus a 32-byte master key
// (data/master.key) that encrypts customers' Eldorado API keys. Writes are atomic (tmp + rename)
// and serialized. Small and dependency-free on purpose: fine for dozens of customers.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptSecret, encryptSecret } from './security.js';

export type Role = 'admin' | 'customer';

export interface BotConfig {
  port: number;
  clientIdBox: string;
  clientSecretBox: string;
  /** Last 4 characters of the client secret, for display only. */
  keyHint: string;
  pollIntervalMs: number;
}

export interface Account {
  username: string;
  name: string;
  role: Role;
  passwordHash: string;
  /** Bumped on disable / password change: every existing login of this account stops working. */
  sessionVersion: number;
  enabled: boolean;
  disabledReason?: 'manual' | 'expired';
  /** Customers: last paid day, inclusive (YYYY-MM-DD, VPS local date). */
  paidUntil?: string;
  notes?: string;
  bot?: BotConfig;
  createdAt: string;
  updatedAt: string;
}

interface DataFile {
  version: 1;
  accounts: Account[];
}

export class Store {
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly key: Buffer,
    private data: DataFile,
  ) {}

  /** Opens (or creates) data/accounts.json and data/master.key in `dataDir`. */
  static async open(dataDir: string): Promise<Store> {
    await mkdir(dataDir, { recursive: true });
    const keyFile = join(dataDir, 'master.key');
    let keyHex: string;
    try {
      keyHex = (await readFile(keyFile, 'utf8')).trim();
    } catch {
      keyHex = randomBytes(32).toString('hex');
      await writeFile(keyFile, keyHex, { flag: 'wx' });
    }
    const key = Buffer.from(keyHex, 'hex');
    if (key.length !== 32) throw new Error(`${keyFile} is not a valid 32-byte key`);

    const file = join(dataDir, 'accounts.json');
    let data: DataFile = { version: 1, accounts: [] };
    try {
      data = JSON.parse(await readFile(file, 'utf8')) as DataFile;
      if (!Array.isArray(data.accounts)) throw new Error('accounts missing');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Could not read ${file}: ${(e as Error).message}`);
    }
    return new Store(file, key, data);
  }

  list(): Account[] {
    return this.data.accounts.map((a) => ({ ...a }));
  }

  get(username: string): Account | undefined {
    const a = this.data.accounts.find((x) => x.username === username);
    return a ? { ...a } : undefined;
  }

  /** Insert or replace by username, then persist. */
  async put(account: Account): Promise<void> {
    const next = { ...account, updatedAt: new Date().toISOString() };
    const i = this.data.accounts.findIndex((x) => x.username === account.username);
    if (i === -1) this.data.accounts.push(next);
    else this.data.accounts[i] = next;
    await this.save();
  }

  async remove(username: string): Promise<void> {
    this.data.accounts = this.data.accounts.filter((x) => x.username !== username);
    await this.save();
  }

  /** Next free bot port (3101, 3102, ...). */
  nextPort(base = 3100): number {
    const used = new Set(this.data.accounts.map((a) => a.bot?.port).filter((p): p is number => !!p));
    let p = base + 1;
    while (used.has(p)) p++;
    return p;
  }

  encrypt(plain: string): string {
    return encryptSecret(this.key, plain);
  }

  decrypt(box: string): string {
    return decryptSecret(this.key, box);
  }

  /** Decrypted Eldorado keys of an account's bot. */
  keysOf(a: Account): { clientId: string; clientSecret: string } | undefined {
    if (!a.bot) return undefined;
    return { clientId: this.decrypt(a.bot.clientIdBox), clientSecret: this.decrypt(a.bot.clientSecretBox) };
  }

  /** Snapshot for backups (API keys stay encrypted; the master key is not included). */
  snapshot(): string {
    return JSON.stringify(this.data, null, 2);
  }

  private save(): Promise<void> {
    const body = JSON.stringify(this.data, null, 2);
    const run = this.chain.then(async () => {
      await writeFile(`${this.file}.tmp`, body);
      await rename(`${this.file}.tmp`, this.file);
    });
    this.chain = run.catch(() => {});
    return run;
  }
}

/** Local date as YYYY-MM-DD. */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Adds whole months to a YYYY-MM-DD date (clamped to the month's last day). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(y, m - 1 + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, last));
  return localDate(target);
}

/** Days from today until paidUntil (0 = last paid day is today, negative = expired). */
export function daysLeft(paidUntil: string | undefined, today = localDate()): number | undefined {
  if (!paidUntil) return undefined;
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${paidUntil}T00:00:00Z`);
  return Number.isNaN(b) ? undefined : Math.round((b - a) / 86_400_000);
}
