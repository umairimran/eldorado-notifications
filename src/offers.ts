// Auto-offer for boosting requests in one category (default: Fortnite 🔥Pirate Shop Access,
// gameId 16 / boostingCategoryId 6).
//
// Official Seller API operation (swagger tag "BoostingOfferSellerPrivate"):
//   POST /api/boostingOffers
//   { details: { boostingRequestId, guaranteedDeliveryTime, pricing: { quantity, minQuantity,
//                pricePerUnit: { amount, currency } }, message } }
//   -> 201 BoostingOfferGetPublicDTO
// The notification's `details.detailsId` is the boosting request ID (verified against
// GET /api/boostingOffers/me/boostingRequests/received).
//
// Safety: at most ONE offer per boosting request (persisted across restarts); only
// requests detected live are offered, never ones that existed at startup.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describeBody, parseRetryAfter, type HttpClient } from './http.js';
import type { TokenManager } from './auth.js';
import type { NotificationItem } from './notifications.js';

export const OFFERS_PATH = '/api/boostingOffers';

export interface OfferConfig {
  gameId: string;
  boostingCategoryId: string;
  priceAmount: number;
  currency: string;
  quantity: number;
  minQuantity: number;
  deliveryTime: string;
  message: string;
}

export interface OfferResult {
  boostingRequestId: string;
  ok: boolean;
  status: number;
  offerId?: string;
  rttMs?: number;
  error?: string;
  attempts: number;
}

type TokenSource = Pick<TokenManager, 'getToken' | 'refresh' | 'invalidate'>;

/** The boosting request ID if this notification is a new request in the configured category. */
export function matchBoostingRequest(item: NotificationItem, cfg: Pick<OfferConfig, 'gameId' | 'boostingCategoryId'>): string | undefined {
  const n = item.notification as
    | { event?: unknown; details?: { detailsId?: unknown; gameId?: unknown } | null; customNotificationData?: { gameId?: unknown; boostingCategoryId?: unknown } | null }
    | null
    | undefined;
  if (!n || n.event !== 'BoostingRequestCreated') return undefined;
  const gameId = String(n.customNotificationData?.gameId ?? n.details?.gameId ?? '');
  const categoryId = String(n.customNotificationData?.boostingCategoryId ?? '');
  if (gameId !== cfg.gameId || categoryId !== cfg.boostingCategoryId) return undefined;
  const id = n.details?.detailsId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export function buildOfferBody(boostingRequestId: string, cfg: OfferConfig): string {
  return JSON.stringify({
    details: {
      boostingRequestId,
      guaranteedDeliveryTime: cfg.deliveryTime,
      pricing: {
        quantity: cfg.quantity,
        minQuantity: cfg.minQuantity,
        pricePerUnit: { amount: cfg.priceAmount, currency: cfg.currency },
      },
      message: cfg.message,
    },
  });
}

// ---------------------------------------------------------------------------------------
// Editable offer settings (changed from the web page, persisted to disk).

/** GuaranteedDeliveryTime enum values from the Seller API spec that make sense for a manual service. */
export const DELIVERY_TIMES = [
  'Minute5', 'Minute20', 'Hour1', 'Hour2', 'Hour3', 'Hour5', 'Hour8', 'Hour12',
  'Day1', 'Day2', 'Day3', 'Day5', 'Day7', 'Day10', 'Day14', 'Day28',
] as const;

/** Currency enum values from the Seller API spec. */
export const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'JPY', 'BRL', 'SGD', 'CHF', 'SEK', 'DKK', 'NOK', 'NZD', 'THB', 'HKD', 'CZK', 'SAR',
  'PLN', 'AED', 'MXN', 'RON', 'ILS', 'ARS', 'TRY', 'QAR', 'HUF', 'PEN', 'KWD', 'BGN', 'CLP', 'COP', 'IDR', 'PHP',
] as const;

export interface OfferSettings {
  enabled: boolean;
  priceAmount: number;
  currency: string;
  quantity: number;
  minQuantity: number;
  deliveryTime: string;
  message: string;
}

export type ValidationResult = { ok: true; value: OfferSettings } | { ok: false; error: string };

export function validateOfferSettings(input: unknown): ValidationResult {
  const o = (input ?? {}) as Record<string, unknown>;
  const enabled = o.enabled === true;
  const priceAmount = Math.round(Number(o.priceAmount) * 100) / 100;
  const quantity = Number(o.quantity);
  const minQuantity = Number(o.minQuantity);
  const currency = String(o.currency ?? '');
  const deliveryTime = String(o.deliveryTime ?? '');
  const message = typeof o.message === 'string' ? o.message.trim() : '';

  if (!Number.isFinite(priceAmount) || priceAmount <= 0 || priceAmount > 100_000) return { ok: false, error: 'Price must be a number above 0' };
  if (!(CURRENCIES as readonly string[]).includes(currency)) return { ok: false, error: 'Unknown currency' };
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) return { ok: false, error: 'Quantity must be a whole number of at least 1' };
  if (!Number.isInteger(minQuantity) || minQuantity < 1 || minQuantity > quantity) return { ok: false, error: 'Min quantity must be at least 1 and not more than quantity' };
  if (!(DELIVERY_TIMES as readonly string[]).includes(deliveryTime)) return { ok: false, error: 'Unknown delivery time' };
  if (!message) return { ok: false, error: 'Message cannot be empty' };
  if (message.length > 1000) return { ok: false, error: 'Message is too long (max 1000 characters)' };
  return { ok: true, value: { enabled, priceAmount, currency, quantity, minQuantity, deliveryTime, message } };
}

export async function loadOfferSettings(path: string): Promise<OfferSettings | undefined> {
  try {
    const r = validateOfferSettings(JSON.parse(await readFile(path, 'utf8')));
    return r.ok ? r.value : undefined;
  } catch {
    return undefined;
  }
}

export async function saveOfferSettings(path: string, s: OfferSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(s, null, 2));
  await rename(`${path}.tmp`, path);
}

export class OfferSender {
  private readonly url: string;
  private readonly offered = new Set<string>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly http: HttpClient,
    private readonly tokens: TokenSource,
    baseUrl: string,
    readonly cfg: OfferConfig,
    private readonly statePath?: string,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.url = new URL(OFFERS_PATH, baseUrl).toString();
  }

  async loadState(): Promise<void> {
    if (!this.statePath) return;
    try {
      const ids = JSON.parse(await readFile(this.statePath, 'utf8')) as unknown;
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') this.offered.add(id);
    } catch {
      /* no state yet */
    }
  }

  hasOffered(boostingRequestId: string): boolean {
    return this.offered.has(boostingRequestId);
  }

  /**
   * Submit one offer. Returns undefined if this request was already offered (never sends twice).
   * Retries only on HTTP 429 / 5xx responses (the server answered, so no duplicate risk from a lost
   * response is introduced beyond what Eldorado itself rejects); 4xx errors are reported, not retried.
   */
  async send(boostingRequestId: string): Promise<OfferResult | undefined> {
    if (this.offered.has(boostingRequestId)) return undefined;
    this.offered.add(boostingRequestId); // claim first: concurrent calls cannot double-send
    void this.persist();

    const body = buildOfferBody(boostingRequestId, this.cfg);
    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        let res = await this.post(body, await this.tokens.getToken());
        if (res.status === 401) {
          this.tokens.invalidate();
          res = await this.post(body, await this.tokens.refresh());
        }
        if (res.status === 200 || res.status === 201) {
          let offerId: string | undefined;
          try {
            offerId = (JSON.parse(res.body) as { id?: string }).id;
          } catch {
            /* body is informational only */
          }
          return { boostingRequestId, ok: true, status: res.status, offerId, rttMs: res.rttMs, attempts };
        }
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempts < 3) {
          await this.sleep(parseRetryAfter(res.headers['retry-after']) ?? 1000 * attempts);
          continue;
        }
        return { boostingRequestId, ok: false, status: res.status, error: describeBody(res.body) || `HTTP ${res.status}`, rttMs: res.rttMs, attempts };
      } catch (e) {
        // Network failure: the offer may or may not have reached Eldorado, so do not resend.
        return { boostingRequestId, ok: false, status: 0, error: (e as Error).message, attempts };
      }
    }
  }

  private post(body: string, token: string) {
    return this.http({ method: 'POST', url: this.url, headers: { authorization: `Bearer ${token}` }, body });
  }

  private persist(): Promise<void> {
    if (!this.statePath) return Promise.resolve();
    const path = this.statePath;
    this.chain = this.chain.then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, JSON.stringify([...this.offered].slice(-5000)));
        await rename(`${path}.tmp`, path);
      } catch {
        /* best effort; in-memory set still prevents duplicates this run */
      }
    });
    return this.chain;
  }
}
