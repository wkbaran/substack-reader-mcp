import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveCredentials } from "../src/auth/credentials.js";
import { ClientProvider, createServer } from "../src/server.js";
import { authed, fakeFetch, SID } from "./helpers.js";

const saved = { ...process.env };

async function connect(routes: Parameters<typeof fakeFetch>[0]) {
  const { fetch } = fakeFetch(routes);
  const server = createServer(new ClientProvider(fetch));
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
