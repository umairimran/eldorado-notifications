// Local web page with live push (Server-Sent Events) and the auto-offer settings panel.
// Bound to 127.0.0.1 only: the page shows buyer usernames and order details, so it is
// never exposed to the network.
import http from 'node:http';
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

export interface OfferPanel {
  get(): OfferSettings;
  /** Validate + apply + persist. Returns an error message for the page on failure. */
  save(input: unknown): Promise<{ ok: true; value: OfferSettings } | { ok: false; error: string }>;
  categoryLabel: string;
  deliveryTimes: readonly string[];
  currencies: readonly string[];
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

export class WebServer {
  private readonly clients = new Set<http.ServerResponse>();
  private readonly feed: FeedEntry[] = [];
  private readonly server: http.Server;
  private heartbeat: NodeJS.Timeout | undefined;
  stats: LiveStats;

  constructor(
    private readonly htmlPath: string,
    intervalMs: number,
    private readonly panel: OfferPanel,
    private readonly maxFeed = 200,
  ) {
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
      settings: this.panel.get(),
      categoryLabel: this.panel.categoryLabel,
      deliveryTimes: this.panel.deliveryTimes,
      currencies: this.panel.currencies,
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
    if (req.headers['x-eldo-page'] !== '1' || !String(req.headers['content-type']).startsWith('application/json') || (origin && origin !== `http://${req.headers.host}`)) {
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
    reply(res, 200, { ok: true, settings: r.value });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
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
