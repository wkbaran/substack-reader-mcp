import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      "get_recent_posts",
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
    expect((await readdir(dir)).sort()).toEqual(["previous_run.json", "state.json"]);

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
