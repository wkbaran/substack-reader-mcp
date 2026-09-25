import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadCredentials, type Credentials } from "./auth/credentials.js";
import { renderPost } from "./format.js";
import { SubstackClient } from "./substack/api.js";
import { renderMessages, renderThread, SubstackChat } from "./substack/chat.js";
import { AuthError, SubstackHttp, type FetchLike } from "./substack/http.js";

const VERSION = "0.2.0";

/**
 * Hands out a client for the current credentials. Credentials are re-read on
 * every call so that running `substack-reader-mcp login` while the server is up
 * takes effect immediately — no need to restart Claude Code.
 */
export class ClientProvider {
  private current: { sid: string | undefined; client: SubstackClient } | null = null;
  creds: Credentials | null = null;

  constructor(private readonly fetchImpl?: FetchLike) {}

  async get(): Promise<SubstackClient> {
    this.creds = await loadCredentials();
    const sid = this.creds?.sid;
    if (!this.current || this.current.sid !== sid) {
      this.current = { sid, client: new SubstackClient(new SubstackHttp({ sid, fetch: this.fetchImpl })) };
    }
    return this.current.client;
  }
}

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

export function createServer(provider = new ClientProvider()): McpServer {
  const server = new McpServer(
    { name: "substack-reader", version: VERSION },
    {
      instructions:
        "Read the user's Substack subscriptions. Start with list_subscriptions or get_feed; " +
        "subscribe/unsubscribe change the user's account (free subscriptions only) and should only be used when asked. " +
        "publications can be referred to by name, subdomain, or URL. If a tool reports an auth " +
        "problem, tell the user to run `substack-reader-mcp login` in a terminal — do not retry in a loop.",
    },
  );

  server.registerTool(
    "auth_status",
    {
      title: "Substack auth status",
      description: "Check whether a Substack session is configured and still valid, and which account it belongs to.",
      annotations: readOnly,
    },
    () =>
      run(async () => {
        const client = await provider.get();
        const creds = provider.creds;
        if (!creds) {
          return text(
            "Not logged in. Run `substack-reader-mcp login` in a terminal. Public posts can still be read without logging in.",
          );
        }
        const user = await client.whoami();
        return json({
          loggedIn: true,
          user,
          source: creds.source,
          expiresAt: creds.expiresAt,
        });
      }),
  );

  server.registerTool(
    "list_subscriptions",
    {
      title: "List subscriptions",
      description:
        "List every newsletter the logged-in user subscribes to (including subscriptions hidden from their public profile), with URL and membership state.",
      inputSchema: {
        username: z
          .string()
          .optional()
          .describe("Only used when not logged in: read this user's *public* subscription list instead."),
        refresh: z.boolean().optional().describe("Bypass the 10 minute cache."),
      },
      annotations: readOnly,
    },
    ({ username, refresh }) =>
      run(async () => {
        const client = await provider.get();
        const subs = await client.subscriptions({ username: username || process.env.SUBSTACK_USERNAME, refresh });
        return json({ count: subs.length, subscriptions: subs });
      }),
  );

  server.registerTool(
    "get_feed",
    {
      title: "Get subscription feed",
      description: "Recent posts across all subscriptions, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(25).describe("Total posts to return."),
        per_publication: z.number().int().min(1).max(20).default(3).describe("Posts to look at per publication."),
        since: z
          .string()
          .optional()
          .describe('Only posts after this point: an ISO date ("2026-09-01") or relative ("7d", "48h").'),
      },
      annotations: readOnly,
    },
    ({ limit, per_publication, since }) =>
      run(async () => {
        const client = await provider.get();
        const result = await client.feed({ limit, perPublication: per_publication, since: parseSince(since) });
        return json(result);
      }),
  );

  server.registerTool(
    "get_recent_posts",
    {
      title: "Get recent posts",
      description: "Recent posts from one publication.",
      inputSchema: {
        publication: z.string().describe('Publication name, subdomain, or URL (e.g. "Platformer", "platformer", "https://www.platformer.news").'),
        limit: z.number().int().min(1).max(50).default(10),
        offset: z.number().int().min(0).default(0).describe("Skip this many posts, for paging back through the archive."),
      },
      annotations: readOnly,
    },
    ({ publication, limit, offset }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.posts(publication, { limit, offset }));
      }),
  );

  server.registerTool(
    "search_posts",
    {
      title: "Search a publication",
      description: "Search one publication's archive by keyword.",
      inputSchema: {
        publication: z.string().describe("Publication name, subdomain, or URL."),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: readOnly,
    },
    ({ publication, query, limit }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.posts(publication, { limit, search: query }));
      }),
  );

  server.registerTool(
    "read_post",
    {
      title: "Read a post",
      description:
        "Read the full content of a Substack post as Markdown. Paid posts are returned in full when the logged-in account has access. Long posts are paged: pass `start` from the previous response to continue.",
      inputSchema: {
        url: z.string().describe("Post URL (any Substack link format, including substack.com/home/post/p-123) or numeric post id."),
        format: z.enum(["markdown", "text", "html"]).default("markdown"),
        start: z.number().int().min(0).default(0).describe("Character offset into the body, for paging."),
        max_chars: z.number().int().min(1000).max(200_000).default(40_000),
      },
      annotations: readOnly,
    },
    ({ url, format, start, max_chars }) =>
      run(async () => {
        const client = await provider.get();
        const post = await client.post(url);
        const { header, body } = renderPost(post, format);
        const chunk = body.slice(start, start + max_chars);
        const end = start + chunk.length;
        const more =
          end < body.length
            ? `\n\n---\n[Showing characters ${start}–${end} of ${body.length}. Call read_post again with start=${end} to continue.]`
            : "";
        const notLoggedIn =
          !client.authenticated && post.audience && post.audience !== "everyone"
            ? "\n- Note: not logged in; run `substack-reader-mcp login` to read posts you've paid for."
            : "";
        return text(`${start === 0 ? header + notLoggedIn + "\n\n" : ""}${chunk}${more}`);
      }),
  );

  server.registerTool(
    "list_chats",
    {
      title: "List chats",
      description:
        "The user's Substack chat inbox: publication chats they belong to and direct messages, most recent first, with unread state. Use the returned id with get_chat_threads (publication_chat) or read_dm (direct_message).",
      annotations: readOnly,
    },
    () =>
      run(async () => {
        const client = await provider.get();
        return json(await new SubstackChat(client).inbox());
      }),
  );

  server.registerTool(
    "get_chat_threads",
    {
      title: "Get chat threads",
      description: "Threads in a publication's chat, newest first, with reply counts. Pass `before` from a previous response to page back.",
      inputSchema: {
        publication: z.string().describe("Publication name, subdomain, URL, or numeric publication id (from list_chats)."),
        limit: z.number().int().min(1).max(100).default(20),
        before: z.string().optional().describe("Paging cursor: the nextBefore value from a previous call."),
      },
      annotations: readOnly,
    },
    ({ publication, limit, before }) =>
      run(async () => {
        const client = await provider.get();
        return json(await new SubstackChat(client).threads(publication, { limit, before }));
      }),
  );

  server.registerTool(
    "read_chat_thread",
    {
      title: "Read chat thread",
      description: "A chat thread with its replies (and replies to replies) as a readable transcript.",
      inputSchema: {
        thread_id: z.string().describe("Thread id from get_chat_threads."),
        max_replies: z.number().int().min(1).max(1000).default(200).describe("Most recent replies to include."),
        include_sub_replies: z.boolean().default(true).describe("Also load replies to replies."),
      },
      annotations: readOnly,
    },
    ({ thread_id, max_replies, include_sub_replies }) =>
      run(async () => {
        const client = await provider.get();
        const thread = await new SubstackChat(client).thread(thread_id, { maxReplies: max_replies, subReplies: include_sub_replies });
        return text(renderThread(thread));
      }),
  );

  server.registerTool(
    "read_dm",
    {
      title: "Read direct messages",
      description: "Messages in one of the user's direct-message conversations. Only use when the user asks about their DMs.",
      inputSchema: {
        conversation_id: z.string().describe("A direct_message id from list_chats."),
      },
      annotations: readOnly,
    },
    ({ conversation_id }) =>
      run(async () => {
        const client = await provider.get();
        const dm = await new SubstackChat(client).directMessages(conversation_id);
        const header = `# Direct messages${dm.with ? ` with ${dm.with}` : ""}

`;
        return text(header + (dm.messages.length ? renderMessages(dm.messages) : "_No messages._"));
      }),
  );

  server.registerTool(
    "subscribe",
    {
      title: "Subscribe (free)",
      description:
        "Free-subscribe the logged-in account to a publication. Never starts a paid plan. Does nothing if already subscribed. Only use when the user explicitly asks to subscribe.",
      inputSchema: {
        publication: z.string().describe('Publication URL, domain, or subdomain (e.g. "https://www.platformer.news", "platformer").'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ publication }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.subscribe(publication));
      }),
  );

  server.registerTool(
    "unsubscribe",
    {
      title: "Unsubscribe (free only)",
      description:
        "Remove one of the logged-in account's FREE subscriptions. Refuses paid subscriptions. Only use when the user explicitly asks to unsubscribe; if the name is ambiguous, ask them which one they mean.",
      inputSchema: {
        publication: z.string().describe("Name, subdomain, or URL of a publication the user is subscribed to."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ publication }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.unsubscribe(publication));
      }),
  );

  return server;
}

export async function serve(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

// ---- helpers ----

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: err instanceof AuthError ? `Authentication required: ${message}` : `Error: ${message}` }],
    };
  }
}

function text(t: string): CallToolResult {
  return { content: [{ type: "text", text: t }] };
}

function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2));
}

export function parseSince(since: string | undefined, now = Date.now()): Date | undefined {
  if (!since) return undefined;
  const rel = since.trim().match(/^(\d+)\s*([hdw])$/i);
  if (rel) {
    const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2]!.toLowerCase() as "h" | "d" | "w"];
    return new Date(now - Number(rel[1]) * unit);
  }
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new Error(`Couldn't understand since="${since}". Use an ISO date or e.g. "7d".`);
  return new Date(t);
}
