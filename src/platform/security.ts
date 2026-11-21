// Security helpers for the multi-customer platform: password hashing, encryption of
// customers' Eldorado API keys, signed session cookies and login rate limiting.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

function scrypt(password: string, salt: Buffer, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, len, (err, key) => (err ? reject(err) : resolve(key))));
}

/** "scrypt$<salt hex>$<hash hex>" */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  const [kind, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) {
    await scrypt(password, Buffer.alloc(16), 32); // same cost either way
    return false;
  }
  const got = await scrypt(password, Buffer.from(salt, 'hex'), 32);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** AES-256-GCM. Output: "v1:<iv>:<tag>:<ciphertext>" (base64 parts). */
export function encryptSecret(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(key: Buffer, box: string): string {
  const [v, iv, tag, ct] = String(box).split(':');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

/** Easy-to-type random password (no 0/O, 1/l/I). */
export function generatePassword(length = 16): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;

/** Session token: "<user>.<version>.<expiresAtMs>.<hmac>". Bumping an account's version logs it out everywhere. */
export class SessionSigner {
  constructor(private readonly key: Buffer) {}

  sign(username: string, version: number, ttlMs: number, now = Date.now()): string {
    const payload = `${username}.${version}.${now + ttlMs}`;
    return `${payload}.${this.mac(payload)}`;
  }

  verify(token: string | undefined, now = Date.now()): { username: string; version: number } | undefined {
    if (!token) return undefined;
    const parts = token.split('.');
    if (parts.length !== 4) return undefined;
    const [username, version, exp, mac] = parts;
    const want = Buffer.from(this.mac(`${username}.${version}.${exp}`));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
    if (!(Number(exp) > now) || !USERNAME_RE.test(username)) return undefined;
    return { username, version: Number(version) };
  }

  private mac(s: string): string {
    return createHmac('sha256', this.key).update(s).digest('base64url');
  }
}

/** Sliding-window counter: at most `max` hits per `windowMs` per key. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  hit(key: string, now = Date.now()): void {
    const a = this.recent(key, now);
    a.push(now);
    this.hits.set(key, a);
    if (this.hits.size > 10_000) this.hits.clear(); // memory guard
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private recent(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
  }
}

/** Replace any of the given secrets in text (defence in depth for logs shown in the admin panel). */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[hidden]');
  return out;
}
