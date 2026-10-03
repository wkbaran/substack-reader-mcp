import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveCredentials } from "../src/auth/credentials.js";
import { ClientProvider, createServer } from "../src/server.js";
import { authed, fakeFetch, SID } from "./helpers.js";

const saved = { ...process.env };

async function connect(routes: Parameters<typeof fakeFetch>[0], opts: Parameters<typeof createServer>[1] = {}) {
  const { fetch } = fakeFetch(routes);
  const server = createServer(new ClientProvider(fetch, { sleep: async () => {} }), opts);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

describe("MCP server", () => {
  beforeEach(async () => {
    process.env.SUBSTACK_READER_HOME = await mkdtemp(join(tmpdir(), "substack-reader-"));
    delete process.env.SUBSTACK_SID;
    delete process.env.SUBSTACK_COOKIE;
    delete process.env.SUBSTACK_COOKIES_PATH;
    delete process.env.SUBSTACK_USERNAME;
    delete process.env.SUBSTACK_DIGEST_DIR;
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  const routes = {
    "https://substack.com/api/v1/user/profile/self": authed({
      id: 42,
      name: "Test User",
      handle: "tester",
      subscriptions: [{ membership_state: "subscribed", publication: { id: 1, name: "Example", subdomain: "example" } }],
    }),
    "https://example.substack.com/api/v1/posts/long": {
      body: {
        id: 5,
        title: "Long read",
        audience: "everyone",
        canonical_url: "https://example.substack.com/p/long",
        body_html: `<p>${"word ".repeat(600)}</p>`,
      },
    },
  };

  it("lists the expected read-only tools", async () => {
    const client = await connect(routes);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "auth_status",
      "get_chat_activity",
      "get_chat_threads",
      "get_feed",
      "get_liked_posts",
      "get_reading_history",
      "get_recent_posts",
      "get_saved_posts",
      "list_chats",
      "list_subscriptions",
      "read_chat_thread",
      "read_dm",
      "read_post",
      "search_posts",
      "subscribe",
      "unsubscribe",
    ]);
    expect(tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name).sort()).toEqual(["subscribe", "unsubscribe"]);
    expect(tools.find((t) => t.name === "unsubscribe")?.annotations?.destructiveHint).toBe(true);
  });

  it("returns an actionable isError result when not logged in", async () => {
    const client = await connect(routes);
    const result = await client.callTool({ name: "list_subscriptions", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/substack-reader-mcp login/);
  });

  it("picks up a new login without restarting", async () => {
    const client = await connect(routes);
    expect((await client.callTool({ name: "list_subscriptions", arguments: {} })).isError).toBe(true);

    await saveCredentials({ sid: SID });

    const result = await client.callTool({ name: "list_subscriptions", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toMatchObject({ count: 1, subscriptions: [{ name: "Example" }] });

    const status = await client.callTool({ name: "auth_status", arguments: {} });
    expect(JSON.parse(textOf(status))).toMatchObject({ loggedIn: true, user: { id: 42, handle: "tester" } });
  });

  it("reports an expired session distinctly", async () => {
    await saveCredentials({ sid: "s%3Astale" });
    const client = await connect(routes);
    const result = await client.callTool({ name: "auth_status", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/expired or signed out/);
  });

  it("pages long posts", async () => {
    const client = await connect(routes);
    const first = textOf(await client.callTool({ name: "read_post", arguments: { url: "https://example.substack.com/p/long", max_chars: 1000 } }));
    expect(first).toMatch(/^# Long read/);
    expect(first).toMatch(/Call read_post again with start=1000/);

    const second = textOf(await client.callTool({ name: "read_post", arguments: { url: "https://example.substack.com/p/long", start: 1000, max_chars: 5000 } }));
    expect(second).not.toMatch(/^# Long read/);
    expect(second).not.toMatch(/Call read_post again/);
  });
});

describe("digest tools", () => {
  const NOW = Date.parse("2026-10-02T12:00:24Z");
  let dir: string;
  beforeEach(async () => {
    process.env.SUBSTACK_READER_HOME = await mkdtemp(join(tmpdir(), "substack-reader-"));
    process.env.SUBSTACK_SID = SID;
    delete process.env.SUBSTACK_DIGEST_DIR;
    dir = await mkdtemp(join(tmpdir(), "substack-digest-"));
    await writeFile(join(dir, "state.json"), JSON.stringify({ last_run: "2026-10-01T12:00:11Z", reported_posts: ["https://example.substack.com/p/old"] }, null, 2) + "\n");
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  const routes = {
    "https://substack.com/api/v1/user/profile/self": authed({
      id: 42,
      subscriptions: [{ membership_state: "free_signup", publication: { id: 1, name: "Example", subdomain: "example" } }],
    }),
    "https://example.substack.com/api/v1/archive?sort=new&offset=0&limit=20": {
      body: [
        { id: 2, title: "Fresh take", post_date: "2026-10-02T09:00:00Z", audience: "only_paid", canonical_url: "https://example.substack.com/p/fresh" },
        { id: 3, title: "Second", post_date: "2026-10-02T08:00:00Z", audience: "everyone", canonical_url: "https://example.substack.com/p/second" },
        { id: 1, title: "Old", post_date: "2026-10-01T13:00:00Z", audience: "everyone", canonical_url: "https://example.substack.com/p/old" },
      ],
    },
    "https://substack.com/api/v1/messages/inbox?tab=all": authed({ threads: [] }),
    "https://example.substack.com/api/v1/posts/second": {
      body: { id: 3, title: "Second", audience: "everyone", canonical_url: "https://example.substack.com/p/second", body_html: "<p>Second body.</p>" },
    },
  };
  const connectDigest = () => connect(routes, { digestDir: dir, timezone: "America/Denver", now: () => NOW, sleep: async () => {} });
  const runIdOf = (t: string) => t.match(/^RUN_ID: (\S+)$/m)![1]!;

  it("are registered only with a digest dir, with the right annotations", async () => {
    const plain = await connect(routes);
    expect((await plain.listTools()).tools.some((t) => t.name.startsWith("digest_"))).toBe(false);

    const client = await connectDigest();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).filter((n) => /digest|mark_reported/.test(n)).sort()).toEqual(["digest_begin", "digest_finish", "digest_status", "mark_reported"]);
    expect(byName.digest_status!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.digest_begin!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.digest_finish!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(byName.mark_reported!.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    expect(tools.every((t) => !t.outputSchema)).toBe(true);
  });

  it("ranks and skips with Jev when SUBSTACK_CLASSIFIER=jev: sorted list, skipped posts need no entry, low-ranked ones go under Also new", async () => {
    process.env.SUBSTACK_CLASSIFIER = "jev";
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.SUBSTACK_DIGEST_RANK_FLOOR = "0.3";
    await writeFile(join(dir, "interests.md"), "# Interests\n\n## Interests\n- Economics\n\n## Skip\n- Podcast show notes\n");
    const sent: Array<{ state: { reader: unknown; headline: { title: string; publication: string } } }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
      const body = JSON.parse(init.body);
      sent.push(body);
      const t = body.state.headline.title as string;
      const score = t === "Second" ? 2.7 : t === "Fresh take" ? 0.6 : 0;
      return new Response(JSON.stringify({ answers: { importance: { type: "score", score }, skip_ctx: { type: "noul", noul: t === "Episode 12" ? 0.95 : 0.1 } } }));
    });
    const withPodcast = {
      ...routes,
      "https://example.substack.com/api/v1/archive?sort=new&offset=0&limit=20": {
        body: [
          { id: 4, title: "Episode 12", post_date: "2026-10-02T10:00:00Z", audience: "everyone", canonical_url: "https://example.substack.com/p/ep12" },
          ...(routes["https://example.substack.com/api/v1/archive?sort=new&offset=0&limit=20"].body as unknown[]),
        ],
      },
    };
    const client = await connect(withPodcast, { digestDir: dir, timezone: "America/Denver", now: () => NOW, sleep: async () => {} });
    const begin = textOf(await client.callTool({ name: "digest_begin", arguments: {} }));
    expect(sent).toHaveLength(3);
    expect(sent[0]!.state.reader).toEqual({ interests: ["Economics"], skips: ["Podcast show notes"] });
    expect(begin).toContain("CLASSIFIER: jev (typesafe/jev-1.13): 3 ranked · 1 skipped (threshold 70%) · 1 below rank floor 30%");
    expect(begin).toMatch(/POSTS, best-ranked first .*\nP3 \| 90 \| Second \| Example/);
    expect(begin).toMatch(/RANKED LOW \(below 30;.*\nP2 \| 20 \| Fresh take/);
    expect(begin).toContain("SKIPPED BY CLASSIFIER (match the user's Skip list; don't read them, no entry needed):\nP1 Episode 12");
    expect(begin).toContain("NEXT: Read every post (the 1 under POSTS, best-ranked first)");

    const out = textOf(await client.callTool({ name: "digest_finish", arguments: { run_id: runIdOf(begin), posts: [{ ref: "P3", section: "pick", gist: "Good.", why: "Yes." }], chats: [] } }));
    expect(out).toContain("COUNTS: 3 posts (1 picks, 0 other, 0 couldn't read, 0 not summarized, 1 skipped, 1 ranked low and unread)");
    expect(out).toContain("WARNINGS: none");
    expect(out).toContain("📎 **Also new** _(ranked low, not read)_\n• Fresh take — Example [paid] https://example.substack.com/p/fresh");
    expect(out).toMatch(/🗑 Skipped 1 by the classifier$/);
    expect(out).not.toContain("Couldn't read");
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).reported_posts).toHaveLength(4);
    expect(textOf(await client.callTool({ name: "digest_status", arguments: {} }))).toContain("CLASSIFIER CONFIG: jev (typesafe/jev-1.13) · skip threshold 70% · rank floor 30%");
  });

  it("runs begin -> finish, saves state, and repeats the result for the same run_id", async () => {
    const client = await connectDigest();
    const begin = textOf(await client.callTool({ name: "digest_begin", arguments: {} }));
    expect(begin).toContain("P1 | Fresh take | Example");
    expect(begin).not.toContain("| Old |");
    const runId = runIdOf(begin);

    const finish = await client.callTool({
      name: "digest_finish",
      arguments: { run_id: runId, posts: [{ ref: "P1", section: "pick", gist: "A fresh argument.", why: "Original." }, { ref: "p2", section: "other", gist: "Short." }], chats: [] },
    });
    expect(finish.isError).toBeFalsy();
    const out = textOf(finish);
    expect(out).toMatch(/^STATE SAVED: yes \(last_run 2026-10-02T12:00:24Z; 3 reported posts; 0 publications pending\)/);
    expect(out).toContain("WARNINGS: none");
    const message = out.split("===== DIGEST: reply with exactly the text below, nothing before or after =====\n")[1]!;
    expect(message.startsWith("📬 **Substack** — 2 new posts, 0 chats with new activity (since Thu, Oct 1, 6:00 AM MDT)")).toBe(true);

    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    expect(state.last_run).toBe("2026-10-02T12:00:24Z");
    expect(state.reported_posts).toEqual(["https://example.substack.com/p/old", "https://example.substack.com/p/fresh", "https://example.substack.com/p/second"]);
    expect(Object.keys(state).at(-1)).toBe("reported_posts");
    expect((await readdir(dir)).sort()).toEqual(["previous_run.json", "runs", "state.json"]);
    const archived = JSON.parse(await readFile(join(dir, "runs", `${runId}.json`), "utf8"));
    expect(archived).toMatchObject({ run_id: runId, judged: { picks: ["P1"], others: ["P2"] } });
    expect(archived.posts.map((p: { title: string }) => p.title)).toEqual(["Fresh take", "Second"]);
    expect(begin).not.toContain("CLASSIFIER:"); // off by default

    const again = await client.callTool({ name: "digest_finish", arguments: { run_id: runId, posts: [], chats: [] } });
    expect(again.isError).toBeFalsy();
    expect(textOf(again)).toMatch(/^ALREADY COMMITTED/);
    expect(textOf(again)).toContain(message);

    const status = textOf(await client.callTool({ name: "digest_status", arguments: {} }));
    expect(status).toContain("LAST RUN: 2026-10-02T12:00:24Z (Fri, Oct 2, 6:00 AM MDT)");
    expect(status).toContain(`- ${runId} |`);
  });

  it("read_post resolves a digest ref to that run's post", async () => {
    const client = await connectDigest();
    const begin = textOf(await client.callTool({ name: "digest_begin", arguments: {} }));
    expect(begin).toContain("P2 | Second | Example");
    const read = textOf(await client.callTool({ name: "read_post", arguments: { url: "p2" } }));
    expect(read).toMatch(/^# Second/);
    expect(read).toContain("- Digest ref: P2");
    expect(read).toContain("Second body.");

    const missing = await client.callTool({ name: "read_post", arguments: { url: "P9" } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/P9 isn't in digest run .*; its post refs are P1–P2/);
  });

  it("rejects an unknown run_id", async () => {
    const client = await connectDigest();
    await client.callTool({ name: "digest_begin", arguments: {} });
    const result = await client.callTool({ name: "digest_finish", arguments: { run_id: "nope", posts: [] } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Unknown run_id "nope"/);
  });

  it("leaves state byte-identical on a dry run", async () => {
    const client = await connectDigest();
    const before = await readFile(join(dir, "state.json"));
    const runId = runIdOf(textOf(await client.callTool({ name: "digest_begin", arguments: {} })));
    const result = textOf(await client.callTool({ name: "digest_finish", arguments: { run_id: runId, posts: [{ ref: "P1", section: "other" }], dry_run: true } }));
    expect(result).toMatch(/^DRY RUN: nothing saved/);
    expect(result).toMatch(/1 post has no entry \(P2\)/);
    expect((await readFile(join(dir, "state.json"))).equals(before)).toBe(true);
    // The run is still open, so the real finish works afterwards.
    expect((await client.callTool({ name: "digest_finish", arguments: { run_id: runId, posts: [] } })).isError).toBeFalsy();
  });

  it("refuses to commit when state changed after begin", async () => {
    const client = await connectDigest();
    const runId = runIdOf(textOf(await client.callTool({ name: "digest_begin", arguments: {} })));
    await client.callTool({ name: "mark_reported", arguments: { urls: [], last_run: "2026-10-02T00:00:00Z" } });
    const result = await client.callTool({ name: "digest_finish", arguments: { run_id: runId, posts: [] } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/state.json changed after digest_begin/);
  });

  it("returns [SILENT] for an empty run and still saves last_run", async () => {
    const client = await connect(
      { ...routes, "https://example.substack.com/api/v1/archive?sort=new&offset=0&limit=20": { body: [] } },
      { digestDir: dir, timezone: "UTC", now: () => NOW, sleep: async () => {} },
    );
    const runId = runIdOf(textOf(await client.callTool({ name: "digest_begin", arguments: {} })));
    const out = textOf(await client.callTool({ name: "digest_finish", arguments: { run_id: runId } }));
    expect(out.endsWith("=====\n[SILENT]")).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).last_run).toBe("2026-10-02T12:00:24Z");
  });

  it("mark_reported adds URLs idempotently", async () => {
    const client = await connectDigest();
    const first = textOf(await client.callTool({ name: "mark_reported", arguments: { urls: ["https://example.substack.com/p/new", "https://example.substack.com/p/old/"] } }));
    expect(first).toMatch(/^MARKED: 1 added, 1 already reported/);
    const second = textOf(await client.callTool({ name: "mark_reported", arguments: { urls: ["https://example.substack.com/p/new"] } }));
    expect(second).toMatch(/^NOTHING CHANGED/);
  });

  it("reports an auth problem from digest_begin as an error", async () => {
    delete process.env.SUBSTACK_SID;
    const client = await connectDigest();
    const result = await client.callTool({ name: "digest_begin", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/substack-reader-mcp login/);
  });
});

describe("reader shelves", () => {
  let dir: string;
  beforeEach(async () => {
    process.env.SUBSTACK_READER_HOME = await mkdtemp(join(tmpdir(), "substack-reader-"));
    process.env.SUBSTACK_SID = SID;
    dir = await mkdtemp(join(tmpdir(), "substack-digest-"));
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const post = (id: number, title: string, pub = 1, extra: Record<string, unknown> = {}) => ({ id, title, publication_id: pub, canonical_url: `https://example.substack.com/p/${id}`, audience: "everyone", ...extra });
  const page = (posts: unknown[], extra: Record<string, unknown> = {}) => ({ posts, publications: [{ id: 1, name: "Example" }, { id: 2, name: "Paid Pub" }], inboxItems: [], postReactions: [], savedPosts: [], more: false, ...extra });
  const routes = {
    "https://substack.com/api/v1/user/profile/self": authed({
      id: 42,
      subscriptions: [
        { membership_state: "free_signup", publication: { id: 1, name: "Example", subdomain: "example" } },
        { membership_state: "subscribed", publication: { id: 2, name: "Paid Pub", subdomain: "paidpub" } },
      ],
    }),
    "https://substack.com/api/v1/reader/posts?inboxType=seen&limit=20": authed(
      page([post(10, "Finished essay", 2), post(11, "Half read"), post(12, "Bounced off")], {
        inboxItems: [{ post_id: 10, max_read_progress: 0.95, seen_at: "2026-10-01T10:00:00Z" }, { post_id: 11, max_read_progress: 0.5 }, { post_id: 12, max_read_progress: 0.04 }],
        postReactions: [{ post_id: 10, user_id: 42 }],
        more: true,
        cursor: "c2",
      }),
    ),
    "https://substack.com/api/v1/reader/posts?inboxType=seen&limit=20&cursor=c2": authed(page([post(13, "Older read")], { inboxItems: [{ post_id: 13, max_read_progress: 1 }] })),
    "https://substack.com/api/v1/reader/posts?inboxType=saved&limit=20": authed(page([post(20, "Saved for later")])),
    "https://substack.com/api/v1/reader/posts?inboxType=archived&limit=20": authed(page([post(30, "$10k trade alert")])),
    "https://substack.com/api/v1/reader/feed/profile/42?types=like": authed({
      items: [{ type: "post", context: { type: "post_like" }, post: post(40, "Hearted post"), publication: { name: "Example" } }, { type: "comment", context: { type: "note_like" } }],
      nextCursor: null,
    }),
  };

  it("lists reading history with read progress, and saved and liked posts", async () => {
    const client = await connect(routes);
    const seen = JSON.parse(textOf(await client.callTool({ name: "get_reading_history", arguments: { limit: 10 } })));
    expect(seen.items.map((p: { title: string; readProgress?: number }) => [p.title, p.readProgress])).toEqual([["Finished essay", 0.95], ["Half read", 0.5], ["Bounced off", 0.04], ["Older read", 1]]);
    expect(seen.items[0]).toMatchObject({ publication: "Paid Pub", hearted: true, seenAt: "2026-10-01T10:00:00Z" });
    expect(seen.nextCursor).toBeUndefined();
    const savedPosts = JSON.parse(textOf(await client.callTool({ name: "get_saved_posts", arguments: {} })));
    expect(savedPosts.items).toMatchObject([{ title: "Saved for later", saved: true, publication: "Example" }]);
    const liked = JSON.parse(textOf(await client.callTool({ name: "get_liked_posts", arguments: {} })));
    expect(liked.items.map((p: { title: string }) => p.title)).toEqual(["Hearted post"]);
  });
});
