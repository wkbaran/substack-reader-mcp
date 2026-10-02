import { describe, expect, it } from "vitest";
import { normalizePostUrl, normalizeSubscriptions, postEndpoint, SubstackClient } from "../src/substack/api.js";
import { renderPost } from "../src/format.js";
import { parseSince } from "../src/server.js";
import { SubstackHttp } from "../src/substack/http.js";
import { authed, fakeFetch, SID } from "./helpers.js";

const SUBSCRIPTIONS = {
  publications: [
    { id: 1, name: "The Pragmatic Engineer", subdomain: "pragmaticengineer", custom_domain: "newsletter.pragmaticengineer.com", author_name: "Gergely Orosz" },
    { id: 2, name: "Astral Codex Ten", subdomain: "astralcodexten", custom_domain: null },
    { id: 3, name: "Broken", subdomain: "broken" },
  ],
  subscriptions: [
    { publication_id: 1, membership_state: "subscribed" },
    { publication_id: 2, membership_state: "free_signup" },
    { publication_id: 3, membership_state: "free_signup" },
  ],
};

// What /api/v1/user/profile/self returns: publications nested inside each subscription.
const SELF_PROFILE = {
  id: 42,
  handle: "tester",
  subscriptions: SUBSCRIPTIONS.subscriptions.map(({ publication_id, membership_state }) => ({
    membership_state,
    visibility: "visible",
    publication: SUBSCRIPTIONS.publications.find((p) => p.id === publication_id),
  })),
};

/** Custom domains only accept the connect.sid obtained through the sign-in handoff. */
function customAuthed(body: unknown) {
  return (req: { cookie: string | null }) => (req.cookie === "connect.sid=custom" ? { body } : { status: 401 });
}

function post(id: number, date: string, extra: Record<string, unknown> = {}) {
  return { id, title: `Post ${id}`, post_date: date, audience: "everyone", canonical_url: `https://x/p/${id}`, ...extra };
}

describe("postEndpoint", () => {
  it.each([
    ["https://example.substack.com/p/my-post", "https://example.substack.com/api/v1/posts/my-post"],
    ["https://example.substack.com/p/my-post?utm_source=email", "https://example.substack.com/api/v1/posts/my-post"],
    ["newsletter.pragmaticengineer.com/p/slug/comments", "https://newsletter.pragmaticengineer.com/api/v1/posts/slug"],
    ["https://substack.com/home/post/p-217245889", "https://substack.com/api/v1/posts/by-id/217245889"],
    ["https://substack.com/@someone/p-123", "https://substack.com/api/v1/posts/by-id/123"],
    ["https://open.substack.com/pub/platformer/p/some-slug?r=abc", "https://platformer.substack.com/api/v1/posts/some-slug"],
    ["217245889", "https://substack.com/api/v1/posts/by-id/217245889"],
  ])("%s", (input, expected) => {
    expect(postEndpoint(input)).toBe(expected);
  });

  it("rejects non-post URLs", () => {
    expect(() => postEndpoint("https://example.substack.com/archive")).toThrow(/Unrecognized post URL/);
  });
});

describe("normalizeSubscriptions", () => {
  it("joins subscriptions to publications and prefers custom domains", () => {
    const subs = normalizeSubscriptions(SUBSCRIPTIONS.subscriptions, SUBSCRIPTIONS.publications);
    expect(subs.map((s) => s.url)).toEqual([
      "https://astralcodexten.substack.com",
      "https://broken.substack.com",
      "https://newsletter.pragmaticengineer.com",
    ]);
    expect(subs[2]).toMatchObject({ author: "Gergely Orosz", membership: "subscribed" });
  });

  it("handles the public-profile shape (publication nested in subscription)", () => {
    const subs = normalizeSubscriptions([{ membership_state: "subscribed", publication: { id: 9, name: "Nested", subdomain: "nested" } }], []);
    expect(subs).toEqual([{ publicationId: 9, name: "Nested", url: "https://nested.substack.com", subdomain: "nested", author: undefined, membership: "subscribed" }]);
  });
});

describe("SubstackClient", () => {
  function client() {
    const { fetch, requests } = fakeFetch({
      "https://substack.com/api/v1/user/profile/self": authed(SELF_PROFILE),
      "https://substack.com/sign-in?redirect=%2F&for_pub=pragmaticengineer": {
        status: 303,
        headers: { location: "https://newsletter.pragmaticengineer.com/api/v1/sign-in/local/complete?token=t" },
      },
      "https://newsletter.pragmaticengineer.com/api/v1/sign-in/local/complete?token=t": {
        status: 303,
        headers: { location: "/", "set-cookie": "connect.sid=custom; Path=/" },
      },
      "https://newsletter.pragmaticengineer.com/api/v1/archive?sort=new&offset=0&limit=2": customAuthed([
        post(11, "2026-09-20T10:00:00Z"),
        post(12, "2026-09-01T10:00:00Z", { audience: "only_paid" }),
      ]),
      "https://astralcodexten.substack.com/api/v1/archive?sort=new&offset=0&limit=2": { body: [post(21, "2026-09-22T10:00:00Z")] },
      "https://broken.substack.com/api/v1/archive?sort=new&offset=0&limit=2": { status: 404 },
      "https://newsletter.pragmaticengineer.com/api/v1/archive?sort=new&offset=0&limit=5&search=kubernetes": { body: [post(31, "2025-05-14T00:00:00Z")] },
    });
    return { c: new SubstackClient(new SubstackHttp({ sid: SID, fetch, sleep: async () => {} })), requests };
  }

  it("builds a feed newest-first and isolates failing publications", async () => {
    const { c } = client();
    const feed = await c.feed({ perPublication: 2 });
    expect(feed.posts.map((p) => p.id)).toEqual([21, 11, 12]);
    expect(feed.posts[2]).toMatchObject({ paywalled: true, publication: "The Pragmatic Engineer" });
    expect(feed.failed).toEqual([{ publication: "Broken", error: expect.stringMatching(/Not found/), retryable: false }]);
    expect(feed.publications).toBe(3);
  });

  it("filters the feed by date", async () => {
    const { c } = client();
    const feed = await c.feed({ perPublication: 2, since: new Date("2026-09-10T00:00:00Z") });
    expect(feed.posts.map((p) => p.id)).toEqual([21, 11]);
  });

  it("uses the custom domain's own session, never substack.sid, on custom domains", async () => {
    const { c, requests } = client();
    await c.feed({ perPublication: 2 });
    const custom = requests.filter((r) => r.url.startsWith("https://newsletter.pragmaticengineer.com/api/v1/archive"));
    expect(custom.map((r) => r.cookie)).toEqual(["connect.sid=custom"]);
    expect(requests.filter((r) => r.cookie?.includes("substack.sid")).every((r) => new URL(r.url).hostname.endsWith("substack.com"))).toBe(true);
  });

  it("resolves publications by name, partial name, subdomain, and URL", async () => {
    const { c } = client();
    for (const ref of ["The Pragmatic Engineer", "pragmatic", "pragmaticengineer", "https://newsletter.pragmaticengineer.com/"]) {
      expect((await c.resolvePublication(ref)).baseUrl).toBe("https://newsletter.pragmaticengineer.com");
    }
    expect((await c.resolvePublication("someoneelse")).baseUrl).toBe("https://someoneelse.substack.com");
  });

  it("searches a publication's archive", async () => {
    const { c } = client();
    const posts = await c.posts("pragmaticengineer", { search: "kubernetes", limit: 5 });
    expect(posts.map((p) => p.id)).toEqual([31]);
  });

  it("caches subscriptions", async () => {
    const { c, requests } = client();
    await c.subscriptions();
    await c.subscriptions();
    expect(requests.filter((r) => r.url.endsWith("/profile/self"))).toHaveLength(1);
  });
});

describe("renderPost", () => {
  it("converts HTML to Markdown and strips Substack widgets", () => {
    const { body, truncated } = renderPost(
      {
        id: 1,
        title: "Hello",
        audience: "everyone",
        body_html:
          '<p>Intro with <a href="https://a.b">a link</a>.</p><div class="subscription-widget-wrap"><p>Subscribe now!</p></div><h2>Part two</h2><p class="button-wrapper"><a>Share</a></p><figure><img src="x.png" alt="A chart"><figcaption>Figure 1</figcaption></figure>',
      },
      "markdown",
    );
    expect(body).toContain("Intro with [a link](https://a.b).");
    expect(body).toContain("## Part two");
    expect(body).toContain("[image: A chart]");
    expect(body).toContain("_Figure 1_");
    expect(body).not.toMatch(/Subscribe now|Share/);
    expect(truncated).toBe(false);
  });

  it("flags paywalled previews", () => {
    const { header, truncated } = renderPost(
      { id: 2, title: "Paid", audience: "only_paid", wordcount: 4200, body_html: "<p>Just the first paragraph…</p>" },
      "markdown",
    );
    expect(truncated).toBe(true);
    expect(header).toMatch(/Only a preview/);
  });

  it("flags long previews that stop short of the paywall marker", () => {
    // Lenny's-style generous preview: ~85% of the words, but no paywall-jump marker.
    const words = Array.from({ length: 85 }, (_, i) => `w${i}`).join(" ");
    expect(renderPost({ id: 4, audience: "only_paid", wordcount: 100, body_html: `<p>${words}</p>` }, "markdown").truncated).toBe(true);
  });

  it("treats the paywall-jump marker as proof of full access", () => {
    const words = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ");
    const html = `<p>${words}</p><div class="paywall-jump" data-component-name="PaywallToDOM"></div><p>${words}</p>`;
    expect(renderPost({ id: 5, audience: "only_paid", wordcount: 100, body_html: html }, "markdown").truncated).toBe(false);
  });

  it("drops empty links left behind by linked images", () => {
    const { body } = renderPost({ id: 6, audience: "everyone", body_html: '<p>Before</p><a href="https://substackcdn.com/x.png"><img src="x.png"></a><p>After</p>' }, "markdown");
    expect(body).toBe("Before\n\nAfter");
  });

  it("doesn't flag full paid posts", () => {
    const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    expect(renderPost({ id: 3, audience: "only_paid", wordcount: 100, body_html: `<p>${words}</p>` }, "text").truncated).toBe(false);
  });
});

describe("parseSince", () => {
  const now = Date.parse("2026-09-25T00:00:00Z");
  it("handles relative and absolute values", () => {
    expect(parseSince("7d", now)?.toISOString()).toBe("2026-09-18T00:00:00.000Z");
    expect(parseSince("48h", now)?.toISOString()).toBe("2026-09-23T00:00:00.000Z");
    expect(parseSince("2026-09-01", now)?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(parseSince(undefined)).toBeUndefined();
    expect(() => parseSince("last tuesday")).toThrow();
  });
});

describe("postsSince and the feed retry pass", () => {
  const PROFILE = {
    id: 42,
    subscriptions: [
      { membership_state: "free_signup", publication: { id: 1, name: "Alpha", subdomain: "alpha" } },
      { membership_state: "free_signup", publication: { id: 2, name: "Beta", subdomain: "beta" } },
    ],
  };
  const archive = (sub: string, offset: number, limit: number) => `https://${sub}.substack.com/api/v1/archive?sort=new&offset=${offset}&limit=${limit}`;

  function setup(routes: Parameters<typeof fakeFetch>[0]) {
    const { fetch, requests } = fakeFetch({ "https://substack.com/api/v1/user/profile/self": authed(PROFILE), ...routes });
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    return { c: new SubstackClient(new SubstackHttp({ sid: SID, fetch, sleep: async () => {} })), requests, sleeps, sleep };
  }

  it("marks failures retryable and recovers them in the retry pass", async () => {
    let betaCalls = 0;
    const { c, sleeps, sleep } = setup({
      [archive("alpha", 0, 3)]: { body: [post(1, "2026-09-20T00:00:00Z")] },
      [archive("beta", 0, 3)]: () => (++betaCalls <= 4 ? { status: 429 } : { body: [post(2, "2026-09-21T00:00:00Z")] }),
    });
    const feed = await c.feed({ sleep });
    expect(betaCalls).toBe(5);
    expect(sleeps).toEqual([15000, 1000]);
    expect(feed.failed).toEqual([]);
    expect(feed.posts.map((p) => p.id)).toEqual([2, 1]);
  });

  it("reports a persistent 429 as retryable after both passes", async () => {
    const { c, sleeps, sleep } = setup({
      [archive("alpha", 0, 3)]: { body: [] },
      [archive("beta", 0, 3)]: { status: 429 },
    });
    const feed = await c.feed({ sleep });
    expect(sleeps).toEqual([15000, 1000, 30000, 1000]);
    expect(feed.failed).toEqual([{ publication: "Beta", error: expect.stringMatching(/HTTP 429/), retryable: true }]);
  });

  it("pages back while a page is full and new, using each publication's own cutoff", async () => {
    const full = Array.from({ length: 2 }, (_, i) => post(100 + i, `2026-09-2${5 - i}T00:00:00Z`));
    const { c, requests } = setup({
      [archive("alpha", 0, 2)]: { body: full },
      [archive("alpha", 2, 2)]: { body: [post(102, "2026-09-23T00:00:00Z"), post(103, "2026-09-10T00:00:00Z")] },
      [archive("beta", 0, 2)]: { body: [post(200, "2026-09-25T00:00:00Z"), post(201, "2026-09-24T00:00:00Z")] },
    });
    const subs = await c.subscriptions();
    const since: Record<string, Date> = { Alpha: new Date("2026-09-20T00:00:00Z"), Beta: new Date("2026-09-24T12:00:00Z") };
    const results = await c.postsSince(subs, (s) => since[s.name], { pageSize: 2, sleep: async () => {} });
    expect(results.map((r) => [r.sub.name, r.status, r.posts.map((p) => p.id)])).toEqual([
      ["Alpha", "ok", [100, 101, 102]],
      ["Beta", "ok", [200]],
    ]);
    expect(requests.filter((r) => r.url.includes("beta.substack.com"))).toHaveLength(1);
  });

  it("stops at the time budget and reports the rest as not checked", async () => {
    let clock = 0;
    const { c } = setup({
      [archive("alpha", 0, 20)]: () => ((clock += 200_000), { body: [] }),
      [archive("beta", 0, 20)]: { body: [] },
    });
    const subs = await c.subscriptions();
    const results = await c.postsSince(subs, () => undefined, { concurrency: 1, budgetMs: 100_000, now: () => clock, sleep: async () => {} });
    expect(results.map((r) => [r.status, r.error ?? null, r.retryable ?? null])).toEqual([
      ["ok", null, null],
      ["failed", "not checked (out of time)", true],
    ]);
  });
});

describe("normalizePostUrl", () => {
  it.each([
    ["https://Example.Substack.com/p/Slug/", "https://example.substack.com/p/Slug"],
    ["https://example.substack.com/p/slug?utm_source=x#footnote", "https://example.substack.com/p/slug"],
    ["  https://example.substack.com/p/slug  ", "https://example.substack.com/p/slug"],
  ])("%s", (input, expected) => {
    expect(normalizePostUrl(input)).toBe(expected);
  });
});
