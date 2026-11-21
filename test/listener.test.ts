import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenManager } from '../src/auth.js';
import { HttpStatusError, NetworkError, parseRetryAfter, type HttpClient, type HttpRequest, type HttpResponse } from '../src/http.js';
import {
  Listener,
  NotificationsClient,
  SeenStore,
  type NotificationItem,
  type NotificationPage,
  type PageFetcher,
} from '../src/notifications.js';

// ---- helpers ---------------------------------------------------------------------------

const n = (id: string, iso: string, event = 'OrderCreated'): NotificationItem => ({
  customNotification: null,
  notification: { id, type: 'Success', event, notificationDate: iso },
});
const page = (results: NotificationItem[], nextPageCursor: string | null = null): NotificationPage => ({ results, nextPageCursor, rttMs: 42 });

class FakeFetcher implements PageFetcher {
  calls: (string | undefined)[] = [];
  constructor(public responses: Array<NotificationPage | Error | ((cursor?: string) => NotificationPage)>) {}
  async fetchPage(cursor?: string): Promise<NotificationPage> {
    this.calls.push(cursor);
    const r = this.responses.length > 1 ? this.responses.shift()! : this.responses[0];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(cursor) : r;
  }
}

function makeListener(client: PageFetcher, extra: Partial<ConstructorParameters<typeof Listener>[0]> = {}) {
  const seen: NotificationItem[] = [];
  const warnings: string[] = [];
  const store = new SeenStore();
  const listener = new Listener({
    client,
    store,
    pollIntervalMs: 1000,
    random: () => 0.5, // no jitter in tests
    hooks: { onNew: (item) => seen.push(item), onWarn: (m) => warnings.push(m) },
    ...extra,
  });
  return { listener, seen, warnings, store };
}

const A = n('a', '2026-11-21T10:00:00.0000000Z');
const B = n('b', '2026-11-21T10:01:00.0000000Z');
const C = n('c', '2026-11-21T10:02:00.1234567Z');
const D = n('d', '2026-11-21T10:03:00.0000000Z');

// ---- detection -------------------------------------------------------------------------

test('initial notifications are not treated as new', async () => {
  const { listener, seen, store } = makeListener(new FakeFetcher([page([B, A])]));
  const r = await listener.start();
  assert.equal(r.resumed, false);
  assert.equal(r.known, 2);
  assert.equal(seen.length, 0);
  assert.ok(store.has('a') && store.has('b'));
});

test('new notification IDs are reported exactly once, oldest first', async () => {
  const fetcher = new FakeFetcher([page([B, A]), page([D, C, B, A])]);
  const { listener, seen } = makeListener(fetcher);
  await listener.start();
  const r1 = await listener.pollOnce();
  assert.equal(r1.newCount, 2);
  assert.deepEqual(seen.map((i) => i.notification?.id), ['c', 'd']);
  await listener.pollOnce(); // same page again
  await listener.pollOnce();
  assert.equal(seen.length, 2);
});

test('duplicate notifications (within a page and across polls) are ignored', async () => {
  const fetcher = new FakeFetcher([page([A]), page([C, C, A]), page([C, A])]);
  const { listener, seen } = makeListener(fetcher);
  await listener.start();
  await listener.pollOnce();
  await listener.pollOnce();
  assert.deepEqual(seen.map((i) => i.notification?.id), ['c']);
});

test('custom notifications are keyed by customNotification.id', async () => {
  const custom: NotificationItem = { notification: null, customNotification: { id: 'x1', notificationDate: '2026-11-21T10:05:00Z', subject: 'Hi' } };
  const fetcher = new FakeFetcher([page([A]), page([custom, A])]);
  const { listener, seen } = makeListener(fetcher);
  await listener.start();
  await listener.pollOnce();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].customNotification?.id, 'x1');
});

test('a page made entirely of new notifications follows the cursor until a known ID', async () => {
  const fetcher = new FakeFetcher([
    page([A]),
    (cursor) => (cursor === undefined ? page([D, C], 'cur-2') : page([B, A], 'cur-3')),
  ]);
  const { listener, seen } = makeListener(fetcher);
  await listener.start();
  await listener.pollOnce();
  assert.deepEqual(fetcher.calls, [undefined, undefined, 'cur-2']);
  assert.deepEqual(seen.map((i) => i.notification?.id), ['b', 'c', 'd']);
});

test('restart with saved state does not re-report old notifications', async () => {
  const first = makeListener(new FakeFetcher([page([B, A])]));
  await first.listener.start();
  const saved = JSON.parse(JSON.stringify(first.store.toJSON()));

  const restored = SeenStore.fromJSON(saved);
  const seen: NotificationItem[] = [];
  const second = new Listener({
    client: new FakeFetcher([page([C, B, A])]),
    store: restored,
    pollIntervalMs: 1000,
    hooks: { onNew: (i) => seen.push(i), onWarn: () => {} },
  });
  const r = await second.start();
  assert.equal(r.resumed, true);
  assert.deepEqual(seen.map((i) => i.notification?.id), ['c']); // only the one that arrived while stopped
});

test('an unknown ID much older than the watermark is not reported', async () => {
  const ancient = n('z', '2026-11-01T00:00:00Z');
  const fetcher = new FakeFetcher([page([D]), page([D, ancient])]);
  const { listener, seen } = makeListener(fetcher);
  await listener.start();
  await listener.pollOnce();
  assert.equal(seen.length, 0);
});

// ---- auth ------------------------------------------------------------------------------

function fakeHttp(handler: (req: HttpRequest) => Partial<HttpResponse> & { status: number }) {
  const requests: HttpRequest[] = [];
  const http: HttpClient = async (req) => {
    requests.push(req);
    const r = handler(req);
    return { headers: {}, body: '', rttMs: 1, ...r };
  };
  return { http, requests };
}

test('token is cached, then refreshed after it expires', async () => {
  let clock = 0;
  let issued = 0;
  const { http, requests } = fakeHttp(() => ({ status: 200, body: JSON.stringify({ accessToken: `tok${++issued}`, expiresIn: 900, tokenType: 'Bearer' }) }));
  const tm = new TokenManager({ http, baseUrl: 'https://x.test', clientId: 'id', clientSecret: 'secret', now: () => clock });
  try {
    assert.equal(await tm.getToken(), 'tok1');
    clock = 60_000;
    assert.equal(await tm.getToken(), 'tok1'); // cached
    clock = 900_000; // past expiry
    assert.equal(await tm.getToken(), 'tok2');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, 'https://x.test/api/authentication/seller/token');
    assert.deepEqual(JSON.parse(requests[0].body!), { clientId: 'id', clientSecret: 'secret' });
  } finally {
    tm.stop();
  }
});

test('HTTP 401 from the notifications endpoint refreshes the token and retries once', async () => {
  let issued = 0;
  const { http, requests } = fakeHttp((req) => {
    if (req.method === 'POST') return { status: 200, body: JSON.stringify({ accessToken: `tok${++issued}`, expiresIn: 900, tokenType: 'Bearer' }) };
    if (req.headers?.authorization === 'Bearer tok1') return { status: 401, body: '' };
    return { status: 200, body: JSON.stringify({ results: [A], nextPageCursor: null }) };
  });
  const tm = new TokenManager({ http, baseUrl: 'https://x.test', clientId: 'id', clientSecret: 'secret' });
  try {
    const client = new NotificationsClient(http, tm, 'https://x.test', 20);
    const p = await client.fetchPage();
    assert.equal(p.results.length, 1);
    const gets = requests.filter((r) => r.method === 'GET');
    assert.equal(gets.length, 2);
    assert.equal(gets[1].headers?.authorization, 'Bearer tok2');
    assert.match(gets[0].url, /\/api\/notifications\/me\?notificationReadStatuses=IsUnread&notificationReadStatuses=IsRead&pageSize=20$/);
    assert.ok(requests.every((r) => r.method === 'GET' || r.url.endsWith('/api/authentication/seller/token')), 'read-only: only GETs besides the token call');
  } finally {
    tm.stop();
  }
});

test('cursor pages are requested with cursorValue and pageDirection=Next', async () => {
  const { http, requests } = fakeHttp((req) =>
    req.method === 'POST'
      ? { status: 200, body: JSON.stringify({ accessToken: 't', expiresIn: 900, tokenType: 'Bearer' }) }
      : { status: 200, body: JSON.stringify({ results: [], nextPageCursor: null }) },
  );
  const tm = new TokenManager({ http, baseUrl: 'https://x.test', clientId: 'id', clientSecret: 's' });
  try {
    await new NotificationsClient(http, tm, 'https://x.test', 50).fetchPage('2026-11-20 22:58:52.0935466EA43B6EB');
    const url = new URL(requests.find((r) => r.method === 'GET')!.url);
    assert.equal(url.searchParams.get('cursorValue'), '2026-11-20 22:58:52.0935466EA43B6EB');
    assert.equal(url.searchParams.get('pageDirection'), 'Next');
  } finally {
    tm.stop();
  }
});

// ---- rate limiting / backoff -----------------------------------------------------------

test('HTTP 429 honors Retry-After and raises the poll interval', () => {
  const { listener, warnings } = makeListener(new FakeFetcher([page([])]));
  const wait = listener.backoffDelay(new HttpStatusError('api', 429, 7000, ''));
  assert.equal(wait, 7000);
  assert.equal(listener.intervalMs, 2000);
  assert.match(warnings[0], /429/);
});

test('HTTP 429 without Retry-After and 5xx use exponential backoff', () => {
  const { listener } = makeListener(new FakeFetcher([page([])]), { pollIntervalMs: 100 });
  const w1 = listener.backoffDelay(new HttpStatusError('api', 503, undefined, ''));
  const w2 = listener.backoffDelay(new HttpStatusError('api', 502, undefined, ''));
  const w3 = listener.backoffDelay(new NetworkError('ECONNRESET'));
  assert.deepEqual([w1, w2, w3], [1000, 2000, 4000]);
  const w4 = listener.backoffDelay(new HttpStatusError('api', 429, undefined, ''));
  assert.equal(w4, 8000);
});

test('run() never overlaps polls and backs off after 429, then recovers', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let call = 0;
  const client: PageFetcher = {
    async fetchPage() {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      call++;
      if (call === 3) throw new HttpStatusError('api', 429, 3000, '');
      return page([A]);
    },
  };
  const delays: number[] = [];
  const ctrl = new AbortController();
  const { listener } = makeListener(client, {
    sleep: async (ms) => {
      delays.push(ms);
      if (delays.length >= 5) ctrl.abort();
    },
  });
  await listener.start();
  await listener.run(ctrl.signal);
  assert.equal(maxInFlight, 1);
  assert.ok(delays.includes(3000), `expected a 3000ms Retry-After wait, got ${delays}`);
  assert.ok(delays.filter((d) => d !== 3000).every((d) => d <= 2000));
});

test('parseRetryAfter handles delta-seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter('1.5'), 1500);
  const now = Date.parse('2026-11-21T10:00:00Z');
  assert.equal(parseRetryAfter('Sat, 21 Nov 2026 10:00:10 GMT', now), 10_000);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter('garbage'), undefined);
});
