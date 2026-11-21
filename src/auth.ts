// Seller API authentication (documented in the Eldorado help article + dashboard):
//   POST /api/authentication/seller/token  { clientId, clientSecret }
//   -> { accessToken, expiresIn (seconds, 900), tokenType: "Bearer" }
// The token is cached, refreshed in the background before it expires (off the polling
// path), and never logged.
import { HttpStatusError, describeBody, parseRetryAfter, type HttpClient } from './http.js';

export const TOKEN_PATH = '/api/authentication/seller/token';

export interface TokenManagerOptions {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  now?: () => number;
  /** Treat the token as expired this long before its real expiry. Default 30s. */
  expiryMarginMs?: number;
  /** Refresh in the background this long before expiry. Default 120s. */
  refreshAheadMs?: number;
  onBackgroundError?: (err: unknown) => void;
}

export class TokenManager {
  private token: string | undefined;
  private expiresAt = 0;
  private inflight: Promise<string> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly url: string;

  constructor(private readonly o: TokenManagerOptions) {
    this.url = new URL(TOKEN_PATH, o.baseUrl).toString();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Seconds until the cached token expires (0 if none). */
  get secondsLeft(): number {
    return Math.max(0, Math.round((this.expiresAt - this.now()) / 1000));
  }

  /** Cached token if still valid, otherwise a fresh one. Concurrent callers share one request. */
  async getToken(): Promise<string> {
    if (this.token !== undefined && this.now() < this.expiresAt - (this.o.expiryMarginMs ?? 30_000)) return this.token;
    return this.refresh();
  }

  refresh(): Promise<string> {
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Drop the cached token (e.g. after the API answered 401). */
  invalidate(): void {
    this.token = undefined;
    this.expiresAt = 0;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async fetchToken(): Promise<string> {
    const res = await this.o.http({
      method: 'POST',
      url: this.url,
      body: JSON.stringify({ clientId: this.o.clientId, clientSecret: this.o.clientSecret }),
    });
    if (res.status !== 200) {
      throw new HttpStatusError('auth', res.status, parseRetryAfter(res.headers['retry-after']), describeBody(res.body));
    }
    let parsed: { accessToken?: unknown; expiresIn?: unknown };
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new HttpStatusError('auth', res.status, undefined, 'token response was not JSON');
    }
    const { accessToken, expiresIn } = parsed;
    if (typeof accessToken !== 'string' || !accessToken || typeof expiresIn !== 'number' || expiresIn <= 0) {
      throw new HttpStatusError('auth', res.status, undefined, 'unexpected token response shape');
    }
    this.token = accessToken;
    this.expiresAt = this.now() + expiresIn * 1000;
    this.scheduleBackgroundRefresh(Math.max(1_000, expiresIn * 1000 - (this.o.refreshAheadMs ?? 120_000)));
    return accessToken;
  }

  private scheduleBackgroundRefresh(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.refresh().catch((err) => {
        this.o.onBackgroundError?.(err);
        this.scheduleBackgroundRefresh(10_000); // the poll path also refreshes on demand
      });
    }, delayMs);
    this.timer.unref();
  }
}
