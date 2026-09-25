import { AuthError, SubstackError, SubstackHttp } from "./http.js";
import type { SubstackUser } from "../auth/credentials.js";

// ---- Raw Substack shapes (only the fields we use; everything else is ignored) ----

interface RawPublication {
  id: number;
  name?: string;
  subdomain?: string;
  custom_domain?: string | null;
  author_name?: string;
  author?: { name?: string };
}

interface RawSubscription {
  publication_id?: number;
  membership_state?: string;
  publication?: RawPublication;
}

interface RawByline {
  name?: string;
}

export interface RawPost {
  id: number;
  title?: string;
  subtitle?: string | null;
  slug?: string;
  post_date?: string;
  audience?: string;
  canonical_url?: string;
  wordcount?: number;
  body_html?: string | null;
  truncated_body_text?: string | null;
  publication_id?: number;
  publishedBylines?: RawByline[];
  type?: string;
}

// ---- Normalized shapes returned to MCP clients ----

export interface Subscription {
  publicationId: number;
  name: string;
  url: string;
  subdomain?: string;
  author?: string;
  membership?: string;
}

export interface PostSummary {
  id: number;
  title: string;
  subtitle?: string;
  date?: string;
  url?: string;
  author?: string;
  audience?: string;
  paywalled: boolean;
  wordcount?: number;
  type?: string;
  publication?: string;
}

const SUBSCRIPTIONS_TTL_MS = 10 * 60_000;
const MAX_PAGE = 50;

export class SubstackClient {
  private subsCache: { at: number; subs: Subscription[] } | null = null;

  constructor(readonly http: SubstackHttp) {}

  get authenticated(): boolean {
    return this.http.authenticated;
  }

  /** Who the session belongs to. Throws AuthError if the session is missing or rejected. */
  async whoami(): Promise<SubstackUser> {
    const raw = await this.http.getJson<Record<string, unknown>>(
      "https://substack.com/api/v1/user/profile/self",
      { requireAuth: true },
    );
    const id = Number(raw.id ?? raw.user_id);
    if (!Number.isFinite(id)) {
      throw new SubstackError("Unexpected response from Substack profile endpoint (no user id).");
    }
    return {
      id,
      name: typeof raw.name === "string" ? raw.name : undefined,
      handle: typeof raw.handle === "string" ? raw.handle : undefined,
    };
  }

  /**
   * Subscriptions for the logged-in user (including ones hidden from their public
   * profile). Without a session, falls back to the public profile of `username`.
   */
  async subscriptions({ username, refresh = false }: { username?: string; refresh?: boolean } = {}): Promise<Subscription[]> {
    if (!this.authenticated) {
      if (!username) throw new AuthError("missing");
      return this.publicSubscriptions(username);
    }
    if (!refresh && this.subsCache && Date.now() - this.subsCache.at < SUBSCRIPTIONS_TTL_MS) {
      return this.subsCache.subs;
    }
    // The logged-in user's own profile lists every subscription, hidden ones included,
    // with full publication details. (/api/v1/subscriptions looks like the obvious
    // endpoint but returns an unrelated subset and needs a `tvOnly` param.)
    const raw = await this.http.getJson<{ subscriptions?: RawSubscription[] }>(
      "https://substack.com/api/v1/user/profile/self",
      { requireAuth: true },
    );
    const subs = normalizeSubscriptions(raw.subscriptions ?? [], []);
    // Custom domains of subscribed publications may receive a session.
    for (const s of subs) this.http.trustHost(new URL(s.url).hostname, s.subdomain);
    this.subsCache = { at: Date.now(), subs };
    return subs;
  }

  private async publicSubscriptions(username: string): Promise<Subscription[]> {
    const handle = username.replace(/^@/, "");
    const raw = await this.http.getJson<{ subscriptions?: RawSubscription[] }>(
      `https://substack.com/api/v1/user/${encodeURIComponent(handle)}/public_profile`,
    );
    return normalizeSubscriptions(raw.subscriptions ?? [], []);
  }

  /**
   * Turn whatever the caller gave us into a publication base URL. Accepts a URL,
   * a bare host, a subdomain ("platformer"), or the name of a subscription.
   */
  async resolvePublication(input: string): Promise<{ baseUrl: string; name?: string }> {
    const value = input.trim();
    if (!value) throw new SubstackError("Publication must not be empty.");

    if (this.authenticated) {
      const subs = await this.subscriptions().catch(() => [] as Subscription[]);
      const hit = matchSubscription(value, subs)[0];
      if (hit) return { baseUrl: hit.url, name: hit.name };
    }

    const host = hostOf(value) ?? (/^[a-z0-9-]+$/i.test(value) ? `${value.toLowerCase()}.substack.com` : null);
    if (!host) {
      throw new SubstackError(
        `Couldn't resolve "${input}" to a publication. Pass its URL (e.g. https://example.substack.com) or run list_subscriptions to see names.`,
      );
    }
    return { baseUrl: `https://${host}` };
  }

  async posts(publication: string, { limit = 10, offset = 0, search }: { limit?: number; offset?: number; search?: string } = {}): Promise<PostSummary[]> {
    const { baseUrl, name } = await this.resolvePublication(publication);
    const params = new URLSearchParams({
      sort: "new",
      offset: String(Math.max(0, offset)),
      limit: String(clamp(limit, 1, MAX_PAGE)),
    });
    if (search) params.set("search", search);
    const raw = await this.http.getJson<RawPost[]>(`${baseUrl}/api/v1/archive?${params}`).catch((err: unknown) => {
      if (err instanceof SubstackError && err.status === 404) {
        throw new SubstackError(
          `No Substack publication found for "${publication}" (tried ${baseUrl}). Use list_subscriptions to see names, or pass the publication's URL.`,
          404,
          baseUrl,
        );
      }
      throw err;
    });
    return raw.map((p) => summarize(p, name));
  }

  /**
   * Recent posts across all subscriptions, newest first. Publications are fetched
   * concurrently; ones that fail are reported instead of aborting the whole feed.
   */
  async feed({ limit = 25, perPublication = 3, since, concurrency = 6 }: { limit?: number; perPublication?: number; since?: Date; concurrency?: number } = {}): Promise<{ posts: PostSummary[]; failed: Array<{ publication: string; error: string }>; publications: number }> {
    const subs = await this.subscriptions();
    const failed: Array<{ publication: string; error: string }> = [];
    const perPub = clamp(perPublication, 1, 20);

    const results = await mapLimit(subs, concurrency, async (sub) => {
      try {
        const raw = await this.http.getJson<RawPost[]>(
          `${sub.url}/api/v1/archive?sort=new&offset=0&limit=${perPub}`,
        );
        return raw.map((p) => summarize(p, sub.name));
      } catch (err) {
        // The account session was already validated by subscriptions(); an auth
        // failure here is specific to this publication, so don't sink the feed.
        failed.push({ publication: sub.name, error: err instanceof Error ? err.message : String(err) });
        return [];
      }
    });

    const cutoff = since?.getTime() ?? -Infinity;
    const posts = results
      .flat()
      .filter((p) => timeOf(p.date) >= cutoff)
      .sort((a, b) => timeOf(b.date) - timeOf(a.date))
      .slice(0, clamp(limit, 1, 200));
    return { posts, failed, publications: subs.length };
  }

  // ---- account changes ----

  /**
   * Free-subscribe the logged-in user to a publication. Idempotent: an existing
   * subscription (free or paid) is left untouched.
   */
  async subscribe(publication: string): Promise<SubscriptionChange> {
    const pub = await this.publicationInfo(publication);
    const existing = await this.subscriptionState(pub.id);
    if (existing) {
      return { result: "already_subscribed", publication: pub.name, url: pub.baseUrl, membership: existing.membership_state };
    }
    const email = await this.accountEmail();
    const here = `${pub.baseUrl}/`;
    // Same payload the publication's own Subscribe button sends.
    const res = await this.http
      .sendJson<{ requires_confirmation?: boolean }>(
        "POST",
        `${pub.baseUrl}/api/v1/free`,
        { email, source: "menu", first_url: here, first_referrer: "", current_url: here, current_referrer: "", first_session_url: here, first_session_referrer: "" },
        { requireAuth: true },
      )
      .catch((err: unknown) => {
        // Some publications answer with the form flow's redirect (302) instead of
        // JSON. That still means "accepted"; the check below confirms it.
        if (err instanceof SubstackError && err.status !== undefined && err.status >= 300 && err.status < 400) return { requires_confirmation: undefined };
        throw err;
      });
    this.subsCache = null;
    const after = await this.subscriptionState(pub.id);
    if (after) return { result: "subscribed", publication: pub.name, url: pub.baseUrl, membership: after.membership_state };
    if (res.requires_confirmation) {
      return { result: "pending_confirmation", publication: pub.name, url: pub.baseUrl, note: "Substack sent a confirmation email; the subscription starts once it's confirmed." };
    }
    throw new SubstackError(`Substack accepted the request but ${pub.name} doesn't show up as subscribed.`);
  }

  /**
   * Remove a *free* subscription. Refuses anything with a payment attached,
   * checking with the publication itself before deleting anything.
   */
  async unsubscribe(publication: string): Promise<SubscriptionChange> {
    const subs = await this.subscriptions({ refresh: true });
    const matches = matchSubscription(publication, subs);
    if (matches.length === 0) {
      throw new SubstackError(`You're not subscribed to anything matching "${publication}". Use list_subscriptions to see names.`);
    }
    if (matches.length > 1) {
      throw new SubstackError(`"${publication}" matches several subscriptions (${matches.map((m) => m.name).join(", ")}). Be more specific or pass the URL.`);
    }
    const sub = matches[0]!;

    const detail = await this.http
      .getJson<PublicationSubscription>(`${sub.url}/api/v1/subscription`, { requireAuth: true })
      .catch((err: unknown) => {
        if (err instanceof AuthError) throw err;
        throw new SubstackError(`Couldn't verify that ${sub.name} is a free subscription, so nothing was changed. (${err instanceof Error ? err.message : String(err)})`);
      });
    const paidReason = paidSignal(detail);
    if (paidReason) {
      throw new SubstackError(
        `Refusing to unsubscribe from ${sub.name}: it's a paid subscription (${paidReason}). Cancel paid plans yourself at ${sub.url}/account.`,
      );
    }

    // What the publication's account page sends. (DELETE /api/v1/subscription looks
    // right but is the *paid* cancellation endpoint: for a free subscription it
    // returns 200 and changes nothing.)
    await this.http.sendJson("DELETE", `${sub.url}/api/v1/free`, { publication_id: sub.publicationId, source: "account" }, { requireAuth: true });
    this.subsCache = null;
    if (await this.subscriptionState(sub.publicationId)) {
      throw new SubstackError(`Substack accepted the request but ${sub.name} still shows as subscribed.`);
    }
    return { result: "unsubscribed", publication: sub.name, url: sub.url };
  }

  /** The user's subscription to a publication, or null. Works for custom domains too. */
  async subscriptionState(publicationId: number): Promise<{ membership_state?: string } | null> {
    try {
      const raw = await this.http.getJson<{ subscription?: { membership_state?: string } | null }>(
        `https://substack.com/api/v1/subscription/${publicationId}`,
        { requireAuth: true },
      );
      return raw.subscription ?? null;
    } catch (err) {
      if (err instanceof SubstackError && err.status === 404) return null;
      throw err;
    }
  }

  /** Canonical details for any publication, read from the data its homepage embeds. */
  async publicationInfo(publication: string): Promise<{ id: number; name: string; subdomain: string; baseUrl: string }> {
    const { baseUrl } = await this.resolvePublication(publication);
    const html = await this.http.getHtml(`${baseUrl}/`).catch((err: unknown) => {
      if (err instanceof SubstackError && err.status === 404) {
        throw new SubstackError(`No Substack publication found at ${baseUrl}.`, 404, baseUrl);
      }
      throw err;
    });
    const pub = parsePreloads(html)?.pub as { id?: number; name?: string; subdomain?: string; custom_domain?: string | null } | undefined;
    if (!pub?.id || !pub.subdomain) throw new SubstackError(`${baseUrl} doesn't look like a Substack publication.`);
    const host = pub.custom_domain || `${pub.subdomain}.substack.com`;
    this.http.trustHost(host, pub.subdomain);
    return { id: pub.id, name: pub.name ?? host, subdomain: pub.subdomain, baseUrl: `https://${host}` };
  }

  private emailCache: string | null = null;

  /** The logged-in account's email; Substack's subscribe endpoint requires it. */
  private async accountEmail(): Promise<string> {
    if (this.emailCache) return this.emailCache;
    if (!this.authenticated) throw new AuthError("missing");
    const user = parsePreloads(await this.http.getHtml("https://substack.com/settings"))?.user as { email?: string } | undefined;
    if (!user?.email) throw new AuthError("expired");
    this.emailCache = user.email;
    return user.email;
  }

  /** Fetch a single post by URL (any common Substack URL shape) or numeric id. */
  async post(ref: string): Promise<RawPost> {
    if (this.authenticated) {
      // Populates the custom-domain allowlist so paid posts on custom domains get the session.
      await this.subscriptions().catch(() => undefined);
    }
    const endpoint = postEndpoint(ref);
    const raw = await this.http.getJson<RawPost | { post: RawPost }>(endpoint);
    return "post" in raw && raw.post ? raw.post : (raw as RawPost);
  }
}

// ---- helpers ----

export function normalizeSubscriptions(subs: RawSubscription[], pubs: RawPublication[]): Subscription[] {
  const byId = new Map(pubs.map((p) => [p.id, p]));
  const out: Subscription[] = [];
  const seen = new Set<number>();
  for (const s of subs) {
    const pub = s.publication ?? (s.publication_id != null ? byId.get(s.publication_id) : undefined);
    if (!pub || seen.has(pub.id)) continue;
    const host = pub.custom_domain || (pub.subdomain ? `${pub.subdomain}.substack.com` : null);
    if (!host) continue;
    seen.add(pub.id);
    out.push({
      publicationId: pub.id,
      name: pub.name ?? host,
      url: `https://${host}`,
      subdomain: pub.subdomain,
      author: pub.author_name ?? pub.author?.name,
      membership: s.membership_state,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function summarize(p: RawPost, publication?: string): PostSummary {
  return {
    id: p.id,
    title: p.title ?? "(untitled)",
    subtitle: p.subtitle || undefined,
    date: p.post_date,
    url: p.canonical_url,
    author: p.publishedBylines?.map((b) => b.name).filter(Boolean).join(", ") || undefined,
    audience: p.audience,
    paywalled: isPaywalled(p.audience),
    wordcount: p.wordcount,
    type: p.type && p.type !== "newsletter" ? p.type : undefined,
    publication,
  };
}

export function isPaywalled(audience?: string): boolean {
  return audience === "only_paid" || audience === "founding";
}

/** Map any supported post reference to the JSON API endpoint that serves it. */
export function postEndpoint(ref: string): string {
  const value = ref.trim();
  if (/^\d+$/.test(value)) return `https://substack.com/api/v1/posts/by-id/${value}`;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new SubstackError(`Not a valid post URL: ${ref}`);
  }
  const path = url.pathname;

  // substack.com/home/post/p-123, substack.com/@handle/p-123, links with ?utm... etc.
  const byId = path.match(/\/p-(\d+)(?:\/|$)/);
  if (byId) return `https://substack.com/api/v1/posts/by-id/${byId[1]}`;

  // open.substack.com/pub/<subdomain>/p/<slug>
  const open = path.match(/^\/pub\/([^/]+)\/p\/([^/]+)/);
  if (open) return `https://${open[1]}.substack.com/api/v1/posts/${open[2]}`;

  const slug = path.match(/^\/p\/([^/]+)/);
  if (slug) return `https://${url.host}/api/v1/posts/${slug[1]}`;

  throw new SubstackError(
    `Unrecognized post URL: ${ref}. Expected something like https://example.substack.com/p/post-slug.`,
  );
}

export interface SubscriptionChange {
  result: "subscribed" | "already_subscribed" | "pending_confirmation" | "unsubscribed";
  publication: string;
  url: string;
  membership?: string;
  note?: string;
}

/** Shape of <publication>/api/v1/subscription (only the fields that reveal payment). */
export interface PublicationSubscription {
  membership_state?: string;
  is_subscribed?: boolean;
  is_founding?: boolean;
  stripe_subscription_id?: string | null;
  bundle_id?: number | null;
  gift_user_id?: number | null;
  expiry?: number | null;
}

/** Why a subscription counts as paid, or null if every signal says it's free. */
export function paidSignal(d: PublicationSubscription): string | null {
  if (d.membership_state !== "free_signup") return `membership is "${d.membership_state ?? "unknown"}"`;
  if (d.is_subscribed) return "marked as a paid subscriber";
  if (d.stripe_subscription_id) return "has a Stripe subscription";
  if (d.is_founding) return "founding member";
  if (d.bundle_id) return "part of a bundle";
  if (d.gift_user_id) return "gifted subscription";
  if (d.expiry) return "has a paid-through date";
  return null;
}

/**
 * Subscriptions matching what the user typed, best match first. Exact name,
 * host, or subdomain wins; otherwise every subscription whose name contains it.
 */
export function matchSubscription(input: string, subs: Subscription[]): Subscription[] {
  const value = input.trim();
  const needle = value.toLowerCase();
  const host = hostOf(value);
  const exact = subs.find(
    (s) => s.name.toLowerCase() === needle || (host !== null && new URL(s.url).hostname === host) || s.subdomain?.toLowerCase() === needle,
  );
  if (exact) return [exact];
  return subs.filter((s) => s.name.toLowerCase().includes(needle));
}

/** Parse the `window._preloads = JSON.parse("...")` blob Substack embeds in pages. */
export function parsePreloads(html: string): Record<string, unknown> | null {
  const m = html.match(/window\._preloads\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\)/);
  if (!m) return null;
  try {
    return JSON.parse(JSON.parse(m[1]!) as string) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hostOf(value: string): string | null {
  if (!value.includes(".")) return null;
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function timeOf(date?: string): number {
  const t = date ? Date.parse(date) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}
