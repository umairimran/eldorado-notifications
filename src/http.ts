// Minimal HTTPS client: one keep-alive agent, persistent TLS connections, RTT measured
// from request start until the full response body has been received.
import https from 'node:https';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import type { IncomingHttpHeaders } from 'node:http';

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  rttMs: number;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

/** Connection-level failure (DNS, reset, timeout, bad payload). Always retryable. */
export class NetworkError extends Error {
  override name = 'NetworkError';
}

/** Non-2xx HTTP response from the token or notifications endpoint. */
export class HttpStatusError extends Error {
  override name = 'HttpStatusError';
  constructor(
    readonly source: 'auth' | 'api',
    readonly status: number,
    readonly retryAfterMs: number | undefined,
    detail: string,
  ) {
    super(`${source === 'auth' ? 'Token request' : 'Notifications request'} failed: HTTP ${status}${detail ? ` - ${detail}` : ''}`);
  }
}

/** Retry-After is either delta-seconds or an HTTP date. Returns milliseconds to wait. */
export function parseRetryAfter(value: string | string[] | undefined, nowMs = Date.now()): number | undefined {
  const v = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - nowMs);
}

/** Short, safe description of an error body (ProblemDetails title/detail, else a truncated snippet). */
export function describeBody(body: string): string {
  try {
    const j = JSON.parse(body) as { title?: unknown; detail?: unknown };
    const parts = [j?.title, j?.detail].filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (parts.length) return parts.join(': ').slice(0, 200);
  } catch {
    /* not JSON */
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function decode(buf: Buffer, encoding: string | undefined): string {
  switch (encoding) {
    case 'gzip':
      return zlib.gunzipSync(buf).toString('utf8');
    case 'br':
      return zlib.brotliDecompressSync(buf).toString('utf8');
    case 'deflate':
      return zlib.inflateSync(buf).toString('utf8');
    default:
      return buf.toString('utf8');
  }
}

export function createHttpClient(timeoutMs: number): { request: HttpClient; close(): void } {
  const agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 15_000,
    maxSockets: 4,
    maxFreeSockets: 2,
    scheduling: 'lifo', // always reuse the most recently used (warmest) socket
  });

  const request: HttpClient = (r) =>
    new Promise<HttpResponse>((resolve, reject) => {
      const u = new URL(r.url);
      const headers: Record<string, string> = {
        accept: 'application/json',
        'accept-encoding': 'gzip, br',
        'user-agent': 'eldorado-notification-listener/1.0',
        ...r.headers,
      };
      if (r.body !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(r.body));
      } else if (r.method === 'POST') {
        headers['content-length'] = '0';
      }
      const start = performance.now();
      const req = https.request(
        { agent, method: r.method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const rttMs = performance.now() - start;
            try {
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body: decode(Buffer.concat(chunks), res.headers['content-encoding']), rttMs });
            } catch (e) {
              reject(new NetworkError(`could not decode response: ${(e as Error).message}`));
            }
          });
          res.on('error', (e) => reject(new NetworkError(e.message)));
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new NetworkError(`request timed out after ${timeoutMs}ms`)));
      req.on('error', (e) => reject(e instanceof NetworkError ? e : new NetworkError(e.message)));
      req.end(r.body);
    });

  return { request, close: () => agent.destroy() };
}
