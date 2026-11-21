// Notifications retrieval + new-notification detection.
//
// Official Seller API operation (swagger tag "UserNotificationsPrivate"):
//   GET /api/notifications/me
//     ?notificationReadStatuses=IsUnread&notificationReadStatuses=IsRead   (array, enum IsRead|IsUnread)
//     &pageSize=1..50 &cursorValue=<nextPageCursor> &pageDirection=Next|Previous
// Live responses are cursor-paged, newest first:
//   { cursor, pageDirection, previousPageCursor, nextPageCursor, pageSize,
//     results: [ { notification: NotificationGetDTO|null, customNotification: CustomNotificationGetDTO|null } ] }
// Both DTOs carry `id` (uuid) and `notificationDate` (date-time).
//
// This module only ever issues GET requests: it never marks notifications as read.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HttpStatusError, NetworkError, describeBody, parseRetryAfter, type HttpClient } from './http.js';
import type { TokenManager } from './auth.js';

export const NOTIFICATIONS_PATH = '/api/notifications/me';

export interface NotificationRecord {
  id?: string;
  notificationDate?: string;
  [key: string]: unknown;
}

export interface NotificationItem {
  notification?: NotificationRecord | null;
  customNotification?: NotificationRecord | null;
  [key: string]: unknown;
}

export interface NotificationPage {
  results: NotificationItem[];
  nextPageCursor: string | null;
  rttMs: number;
}

export interface PageFetcher {
  fetchPage(cursor?: string): Promise<NotificationPage>;
}

export function itemId(item: NotificationItem): string | undefined {
  const id = item.notification?.id ?? item.customNotification?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** notificationDate as epoch ms. The API sends 7 fractional digits; trim to ms for Date.parse. */
export function itemDate(item: NotificationItem): number | undefined {
  const raw = item.notification?.notificationDate ?? item.customNotification?.notificationDate;
  if (typeof raw !== 'string') return undefined;
  const t = Date.parse(raw.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(t) ? undefined : t;
}

type TokenSource = Pick<TokenManager, 'getToken' | 'refresh' | 'invalidate'>;

export class NotificationsClient implements PageFetcher {
  private readonly endpoint: string;
  private readonly baseQuery: URLSearchParams;
  private readonly firstPageUrl: string; // prebuilt: the hot path does no URL work

  constructor(
    private readonly http: HttpClient,
    private readonly tokens: TokenSource,
    baseUrl: string,
    pageSize: number,
  ) {
    this.endpoint = new URL(NOTIFICATIONS_PATH, baseUrl).toString();
    const q = new URLSearchParams();
    // Without a status filter the endpoint returns an empty list, so request both.
    q.append('notificationReadStatuses', 'IsUnread');
    q.append('notificationReadStatuses', 'IsRead');
    q.set('pageSize', String(pageSize));
    this.baseQuery = q;
    this.firstPageUrl = `${this.endpoint}?${q}`;
  }

  private urlFor(cursor?: string): string {
    if (!cursor) return this.firstPageUrl;
    const q = new URLSearchParams(this.baseQuery);
    q.set('cursorValue', cursor);
    q.set('pageDirection', 'Next');
    return `${this.endpoint}?${q}`;
  }

  async fetchPage(cursor?: string): Promise<NotificationPage> {
    const url = this.urlFor(cursor);
    let res = await this.get(url, await this.tokens.getToken());
    if (res.status === 401) {
      // Token expired or revoked: get a new one and retry once.
      this.tokens.invalidate();
      res = await this.get(url, await this.tokens.refresh());
    }
    if (res.status !== 200) {
      throw new HttpStatusError('api', res.status, parseRetryAfter(res.headers['retry-after']), describeBody(res.body));
    }
    let body: { results?: unknown; nextPageCursor?: unknown };
    try {
      body = JSON.parse(res.body);
    } catch {
      throw new NetworkError('notifications response was not valid JSON');
    }
    if (!Array.isArray(body.results)) throw new NetworkError('notifications response has no results array');
    const next = typeof body.nextPageCursor === 'string' && body.nextPageCursor ? body.nextPageCursor : null;
    return { results: body.results as NotificationItem[], nextPageCursor: next, rttMs: res.rttMs };
  }

  private get(url: string, token: string) {
    return this.http({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  }
}

// ---------------------------------------------------------------------------------------
// Seen-ID store (bounded Set + newest-date watermark), persisted across restarts.

export interface SeenState {
  version: 1;
  watermarkMs: number;
  ids: string[];
}

export class SeenStore {
  private readonly ids = new Set<string>();
  watermarkMs = 0;

  constructor(readonly maxIds = 5000) {}

  get size(): number {
    return this.ids.size;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  remember(item: NotificationItem): void {
    const id = itemId(item);
    if (id === undefined) return;
    if (!this.ids.has(id)) {
      this.ids.add(id);
      if (this.ids.size > this.maxIds) this.ids.delete(this.ids.values().next().value as string);
    }
    const d = itemDate(item);
    if (d !== undefined && d > this.watermarkMs) this.watermarkMs = d;
  }

  /** True if the item is clearly older than anything already seen (guards against an evicted ID resurfacing). */
  isOlderThanWatermark(item: NotificationItem, graceMs: number): boolean {
    const d = itemDate(item);
    return this.watermarkMs > 0 && d !== undefined && d < this.watermarkMs - graceMs;
  }

  toJSON(): SeenState {
    return { version: 1, watermarkMs: this.watermarkMs, ids: [...this.ids] };
  }

  static fromJSON(state: SeenState, maxIds = 5000): SeenStore {
    const s = new SeenStore(maxIds);
    for (const id of state.ids.slice(-maxIds)) s.ids.add(id);
    s.watermarkMs = Number(state.watermarkMs) || 0;
    return s;
  }
}

export async function loadState(path: string, warn: (msg: string) => void): Promise<SeenStore> {
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as SeenState;
    if (state?.version !== 1 || !Array.isArray(state.ids)) throw new Error('unrecognised format');
    return SeenStore.fromJSON(state);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warn(`[STATE] Ignoring unreadable state file (${(e as Error).message}); a fresh baseline will be taken`);
    return new SeenStore();
  }
}

/** Debounced, atomic (write temp + rename), never blocks the polling loop. */
export class StateWriter {
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly store: SeenStore,
    private readonly warn: (msg: string) => void,
    private readonly debounceMs = 500,
  ) {}

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.write();
    }, this.debounceMs);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.write();
  }

  private write(): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp`;
        await writeFile(tmp, JSON.stringify(this.store.toJSON()));
        await rename(tmp, this.path);
      } catch (e) {
        this.warn(`[STATE] Could not save state: ${(e as Error).message}`);
      }
    });
    return this.chain;
  }
}

// ---------------------------------------------------------------------------------------
// Polling listener.

export interface NewNotificationInfo {
  id: string;
  /** Wall-clock epoch ms when the response containing this notification was received. */
  detectedAt: number;
  /** Round-trip time of the request that returned it. */
  rttMs: number;
}

export interface ListenerHooks {
  onNew(item: NotificationItem, info: NewNotificationInfo): void;
  onWarn(message: string): void;
  onPoll?(rttMs: number): void;
  onStateChange?(): void;
}

export interface ListenerOptions {
  client: PageFetcher;
  store: SeenStore;
  hooks: ListenerHooks;
  pollIntervalMs: number;
  maxCatchupPages?: number;
  maxBackoffMs?: number;
  /** Clock-skew tolerance for the watermark guard. Default 10 minutes. */
  graceMs?: number;
  /** Ceiling the interval may be raised to after HTTP 429. Default 30s. */
  maxRateLimitedIntervalMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class Listener {
  /** Current effective poll interval (raised automatically after HTTP 429). */
  intervalMs: number;
  private failures = 0;
  private readonly now: () => number;

  constructor(private readonly o: ListenerOptions) {
    this.intervalMs = o.pollIntervalMs;
    this.now = o.now ?? Date.now;
  }

  /**
   * First contact. With no saved state, every notification currently returned is recorded
   * as already-seen (baseline) and nothing is reported. With saved state, this is a normal
   * poll, so notifications that arrived while the listener was stopped are reported once.
   */
  async start(): Promise<{ resumed: boolean; known: number; reported: number; rttMs: number; firstPage: NotificationItem[] }> {
    if (this.o.store.size === 0) {
      const page = await this.o.client.fetchPage();
      for (const item of sortOldestFirst(page.results)) this.o.store.remember(item);
      this.o.hooks.onStateChange?.();
      this.o.hooks.onPoll?.(page.rttMs);
      return { resumed: false, known: this.o.store.size, reported: 0, rttMs: page.rttMs, firstPage: page.results };
    }
    const r = await this.pollOnce();
    return { resumed: true, known: this.o.store.size, reported: r.newCount, rttMs: r.rttMs, firstPage: r.firstPage };
  }

  async pollOnce(): Promise<{ rttMs: number; newCount: number; firstPage: NotificationItem[] }> {
    const { client, store, hooks } = this.o;
    const graceMs = this.o.graceMs ?? 600_000;
    const maxPages = this.o.maxCatchupPages ?? 5;

    let page = await client.fetchPage();
    const detectedAt = this.now();
    const rttMs = page.rttMs;
    const firstPage = page.results;
    const fresh: NotificationItem[] = [];
    const batch = new Set<string>();
    let silentlyRemembered = false;

    for (let pages = 1; ; pages++) {
      let reachedKnown = false;
      for (const item of page.results) {
        const id = itemId(item);
        if (id === undefined || batch.has(id)) continue;
        if (store.has(id)) {
          reachedKnown = true;
          continue;
        }
        if (store.isOlderThanWatermark(item, graceMs)) {
          store.remember(item);
          silentlyRemembered = true;
          reachedKnown = true;
          continue;
        }
        batch.add(id);
        fresh.push(item);
      }
      // A page made entirely of new IDs means there may be more beyond it (burst): follow the cursor.
      if (reachedKnown || !page.nextPageCursor || page.results.length === 0 || pages >= maxPages) break;
      page = await client.fetchPage(page.nextPageCursor);
    }

    hooks.onPoll?.(rttMs);
    for (const item of sortOldestFirst(fresh)) {
      store.remember(item);
      hooks.onNew(item, { id: itemId(item)!, detectedAt, rttMs });
    }
    if (fresh.length > 0 || silentlyRemembered) hooks.onStateChange?.();
    return { rttMs, newCount: fresh.length, firstPage };
  }

  /** Poll until aborted. Polls never overlap: the next one is scheduled only after the previous finished. */
  async run(signal: AbortSignal): Promise<void> {
    const sleep = this.o.sleep ?? abortableSleep;
    while (!signal.aborted) {
      const started = this.now();
      let delay: number;
      try {
        await this.pollOnce();
        this.failures = 0;
        delay = Math.max(0, this.intervalMs - (this.now() - started));
      } catch (err) {
        if (signal.aborted) break;
        delay = this.backoffDelay(err);
      }
      if (signal.aborted) break;
      await sleep(delay, signal);
    }
  }

  /** Delay before the next attempt after a failure. Reports the reason through onWarn. */
  backoffDelay(err: unknown): number {
    this.failures++;
    const maxBackoff = this.o.maxBackoffMs ?? 60_000;
    const exp = Math.min(maxBackoff, 1000 * 2 ** Math.min(this.failures - 1, 16));
    const jittered = Math.round(exp * (0.8 + 0.4 * (this.o.random ?? Math.random)()));
    const warn = this.o.hooks.onWarn;

    if (err instanceof HttpStatusError) {
      if (err.status === 429) {
        const prev = this.intervalMs;
        this.intervalMs = Math.min(Math.max(prev * 2, 1000), Math.max(prev, this.o.maxRateLimitedIntervalMs ?? 30_000));
        const wait = Math.max(err.retryAfterMs ?? jittered, this.intervalMs);
        warn(
          `[RATE] HTTP 429 from ${err.source === 'auth' ? 'token' : 'notifications'} endpoint - waiting ${wait}ms` +
            `${err.retryAfterMs !== undefined ? ` (Retry-After ${err.retryAfterMs}ms)` : ''}; poll interval ${prev}ms -> ${this.intervalMs}ms`,
        );
        return wait;
      }
      if (err.status >= 500) {
        const wait = err.retryAfterMs ?? jittered;
        warn(`[RETRY] ${err.message} - retrying in ${wait}ms`);
        return wait;
      }
      if (err.source === 'auth') {
        const wait = Math.max(jittered, 5_000);
        warn(`[AUTH] ${err.message} - check that the credential is not revoked or expired; retrying in ${wait}ms`);
        return wait;
      }
      const wait = err.retryAfterMs ?? jittered;
      warn(`[RETRY] ${err.message} - retrying in ${wait}ms`);
      return wait;
    }
    warn(`[RETRY] ${(err as Error)?.message ?? String(err)} - retrying in ${jittered}ms`);
    return jittered;
  }
}

function sortOldestFirst(items: NotificationItem[]): NotificationItem[] {
  return [...items].sort((a, b) => (itemDate(a) ?? Infinity) - (itemDate(b) ?? Infinity));
}
