import { SESSION_COOKIE, USER_AGENT } from "../config.js";

export class SubstackError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "SubstackError";
  }
}

/** The request needed a login and either none was configured or Substack rejected it. */
export class AuthError extends SubstackError {
  constructor(
    readonly reason: "missing" | "expired",
    url?: string,
  ) {
    super(
      reason === "missing"
        ? "Not logged in to Substack. Run `substack-reader-mcp login` in a terminal, then retry."
        : "Your Substack session was rejected (expired or signed out). Run `substack-reader-mcp login` in a terminal to refresh it, then retry.",
      401,
      url,
    );
    this.name = "AuthError";
  }
}

export type FetchLike = typeof fetch;

export interface HttpOptions {
  sid?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected so tests don't actually wait on backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_REDIRECTS = 5;

type Method = "GET" | "POST" | "DELETE";

export interface RequestOptions {
  method?: Method;
  /** Sent as JSON. */
  body?: unknown;
  /** Fail fast without a session, and report 401/403 as an expired session. */
  requireAuth?: boolean;
}

/**
 * Thin fetch wrapper that knows how to talk to Substack.
 *
 * Session cookies are only ever attached to hosts that belong to Substack:
 *   - substack.com and *.substack.com get the `substack.sid` session.
 *   - Custom domains (registered via `trustHost`) don't accept that cookie. For
 *     them we run Substack's own cross-domain sign-in once, which gives the
 *     domain its own `connect.sid`, and send that instead.
 * Redirects are followed manually so a hop to a foreign host never carries a cookie.
 */
export class SubstackHttp {
  /** Custom domain -> the publication's substack subdomain (needed for the sign-in handoff). */
  private readonly customDomains = new Map<string, string | undefined>();
  private readonly hostSessions = new Map<string, Promise<string | null>>();
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HttpOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get authenticated(): boolean {
    return Boolean(this.opts.sid);
  }

  /** Mark a custom domain as a Substack publication so it may receive a session. */
  trustHost(host: string, subdomain?: string): void {
    const h = host.toLowerCase();
    if (isSubstackHost(h)) return;
    this.customDomains.set(h, subdomain ?? this.customDomains.get(h));
  }

  sendsSessionTo(host: string): boolean {
    const h = host.toLowerCase();
    return isSubstackHost(h) || this.customDomains.has(h);
  }

  async getJson<T>(url: string, opts: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.json<T>(url, { ...opts, method: "GET" });
  }

  async sendJson<T>(method: "POST" | "DELETE", url: string, body: unknown, opts: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.json<T>(url, { ...opts, method, body });
  }

  /** GET an HTML page (used to read the `window._preloads` data Substack embeds). */
  async getHtml(url: string): Promise<string> {
    const res = await this.request(url, { method: "GET" }, "text/html");
    if (!res.ok) throw new SubstackError(`Substack returned HTTP ${res.status} for ${url}`, res.status, url);
    return res.text();
  }

  private async json<T>(url: string, opts: RequestOptions): Promise<T> {
    if (opts.requireAuth && !this.opts.sid) throw new AuthError("missing", url);

    let res = await this.request(url, opts);
    const host = new URL(url).hostname.toLowerCase();
    if ((res.status === 401 || res.status === 403) && this.hostSessions.has(host)) {
      // A custom-domain session can expire independently; redo the handoff once.
      await res.body?.cancel();
      this.hostSessions.delete(host);
      res = await this.request(url, opts);
    }
    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }

    if (res.status === 401 || (opts.requireAuth && res.status === 403)) {
      if (this.opts.sid) throw new AuthError("expired", url);
      throw new AuthError("missing", url);
    }
    const detail = await errorDetail(res);
    if (res.status === 404) throw new SubstackError(`Not found: ${url}${detail}`, 404, url);
    throw new SubstackError(`Substack returned HTTP ${res.status} for ${url}${detail}`, res.status, url);
  }

  private async request(url: string, opts: RequestOptions, accept = "application/json"): Promise<Response> {
    const method = opts.method ?? "GET";
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.followRedirects(url, method, opts.body, accept);
      } catch (err) {
        // Only GETs are retried after network errors: a POST may have gone through.
        if (method === "GET" && attempt < this.maxRetries && isTransient(err)) {
          await this.sleep(backoff(attempt));
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new SubstackError(`Request to ${url} failed: ${msg}`, undefined, url);
      }
      const retryable = res.status === 429 || (method === "GET" && res.status >= 500);
      if (retryable && attempt < this.maxRetries) {
        await res.body?.cancel();
        await this.sleep(retryAfterMs(res) ?? backoff(attempt));
        continue;
      }
      return res;
    }
  }

  private async followRedirects(startUrl: string, method: Method, body: unknown, accept: string): Promise<Response> {
    let url = new URL(startUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== "https:") {
        throw new Error(`refusing non-HTTPS URL ${url.href}`);
      }
      const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: accept };
      const cookie = await this.cookieFor(url.hostname);
      if (cookie) headers.Cookie = cookie;
      if (body !== undefined) headers["Content-Type"] = "application/json";

      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const location = res.headers.get("location");
      // Writes are never replayed against a redirect target; callers use canonical URLs.
      if (method === "GET" && res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      return res;
    }
    throw new Error(`too many redirects starting from ${startUrl}`);
  }

  private async cookieFor(hostname: string): Promise<string | null> {
    const sid = this.opts.sid;
    if (!sid) return null;
    const host = hostname.toLowerCase();
    if (isSubstackHost(host)) return `${SESSION_COOKIE}=${sid}`;
    if (!this.customDomains.has(host)) return null;
    const subdomain = this.customDomains.get(host);
    if (!subdomain) return null;
    let session = this.hostSessions.get(host);
    if (!session) {
      session = this.customDomainSession(host, subdomain).catch(() => null);
      this.hostSessions.set(host, session);
    }
    return session;
  }

  /**
   * Substack's cross-domain sign-in: substack.com/sign-in?for_pub=<subdomain>
   * answers with a redirect to <custom domain>/api/v1/sign-in/local/complete?token=...,
   * which sets that domain's own `connect.sid`. The token is only followed to the
   * exact custom domain we asked about.
   */
  private async customDomainSession(host: string, subdomain: string): Promise<string | null> {
    const start = new URL(`https://substack.com/sign-in?redirect=%2F&for_pub=${encodeURIComponent(subdomain)}`);
    const first = await this.fetchImpl(start, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html", Cookie: `${SESSION_COOKIE}=${this.opts.sid}` },
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    await first.body?.cancel();
    const location = first.headers.get("location");
    if (!location) return null;
    const handoff = new URL(location, start);
    if (handoff.protocol !== "https:" || handoff.hostname.toLowerCase() !== host) return null;

    const second = await this.fetchImpl(handoff, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    await second.body?.cancel();
    const cookie = second.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!.trim())
      .find((c) => c.startsWith("connect.sid="));
    return cookie ?? null;
  }
}

function isSubstackHost(host: string): boolean {
  return host === "substack.com" || host.endsWith(".substack.com");
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "TimeoutError" || err.name === "AbortError" || /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(err.message + String((err as { cause?: unknown }).cause ?? ""));
}

function backoff(attempt: number): number {
  return 500 * 2 ** attempt;
}

function retryAfterMs(res: Response): number | null {
  const value = res.headers.get("retry-after");
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 30_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.min(Math.max(date - Date.now(), 0), 30_000);
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as { errors?: Array<{ msg?: string }>; error?: string };
    const msg = parsed.errors?.[0]?.msg ?? parsed.error;
    return msg ? ` (${msg})` : "";
  } catch {
    return "";
  }
}
