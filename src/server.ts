import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadCredentials, type Credentials } from "./auth/credentials.js";
import { renderPost } from "./format.js";
import { SubstackClient } from "./substack/api.js";
import { renderChatActivity, renderMessages, renderThread, SubstackChat } from "./substack/chat.js";
import { AuthError, SubstackHttp, type FetchLike } from "./substack/http.js";
import { digestDir as envDigestDir, digestTimezone } from "./config.js";
import { digestBegin } from "./digest/collect.js";
import { digestFinish, digestStatus, isPostRef, markReported, resolvePostRef } from "./digest/finish.js";
import { formatLocal, isoSeconds, parseSince } from "./time.js";

const VERSION = "0.3.1";

/**
 * Hands out a client for the current credentials. Credentials are re-read on
 * every call so that running `substack-reader-mcp login` while the server is up
 * takes effect immediately — no need to restart Claude Code.
 */
export class ClientProvider {
  private current: { sid: string | undefined; client: SubstackClient } | null = null;
  creds: Credentials | null = null;

  constructor(
    private readonly fetchImpl?: FetchLike,
    private readonly httpOpts: { sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
  ) {}

  async get(): Promise<SubstackClient> {
    this.creds = await loadCredentials();
    const sid = this.creds?.sid;
    if (!this.current || this.current.sid !== sid) {
      this.current = { sid, client: new SubstackClient(new SubstackHttp({ sid, fetch: this.fetchImpl, ...this.httpOpts })) };
    }
    return this.current.client;
  }
}

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

export interface ServerOptions {
  /** Enables the digest tools. Defaults to SUBSTACK_DIGEST_DIR. */
  digestDir?: string;
  /** IANA time zone for digest times. Defaults to SUBSTACK_DIGEST_TZ, then UTC. */
  timezone?: string;
  /** Injected for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createServer(provider = new ClientProvider(), opts: ServerOptions = {}): McpServer {
  const dir = opts.digestDir ?? envDigestDir();
  const tzConfig = digestTimezone(opts.timezone);
  const server = new McpServer(
    { name: "substack-reader", version: VERSION },
    {
      instructions:
        "Read the user's Substack subscriptions. Start with list_subscriptions or get_feed; " +
        "subscribe/unsubscribe change the user's account (free subscriptions only) and should only be used when asked. " +
        "publications can be referred to by name, subdomain, or URL. If a tool reports an auth " +
        "problem, tell the user to run `substack-reader-mcp login` in a terminal — do not retry in a loop." +
        (dir
          ? " For the scheduled digest: call digest_begin once, read the posts and chats it lists, then call digest_finish once with " +
            "a judgment for every post and chat, and reply with exactly the text after its ===== DIGEST line. " +
            "Never read or edit the digest's state files directly; digest_status and mark_reported are for debugging and repair."
          : ""),
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
      description:
        "Recent posts across all subscriptions, newest first. Publications listed under `failed` were not checked, so their new posts are missing from this result; `retryable: true` means a rate limit or temporary error, worth trying again later.",
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
        url: z
          .string()
          .describe(
            dir
              ? 'Post URL (any Substack link format, including substack.com/home/post/p-123), numeric post id, or a digest ref such as "P3" from digest_begin.'
              : "Post URL (any Substack link format, including substack.com/home/post/p-123) or numeric post id.",
          ),
        format: z.enum(["markdown", "text", "html"]).default("markdown"),
        start: z.number().int().min(0).default(0).describe("Character offset into the body, for paging."),
        max_chars: z.number().int().min(1000).max(200_000).default(40_000),
      },
      annotations: readOnly,
    },
    ({ url, format, start, max_chars }) =>
      run(async () => {
        const client = await provider.get();
        const digestPost = dir && isPostRef(url) ? await resolvePostRef(dir, url) : undefined;
        const post = await client.post(digestPost?.url ?? url);
        const rendered = renderPost(post, format);
        const { body } = rendered;
        const header = digestPost ? `${rendered.header}\n- Digest ref: ${digestPost.ref}` : rendered.header;
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
    "get_chat_activity",
    {
      title: "Get chat activity",
      description:
        "Publication chats and DMs with activity since a point in time: threads created or replied to after `since`, and DMs with new messages. " +
        "With `transcripts: true`, returns each active thread's opening post plus only the replies after `since`, and each DM's new messages. " +
        "More reliable than list_chats' unread flags, which Substack doesn't keep up to date.",
      inputSchema: {
        since: z.string().min(1).describe('ISO time ("2026-10-01T12:00:00Z") or relative ("24h", "7d").'),
        chat_id: z.string().optional().describe("Only this chat: a publication id or DM id from list_chats."),
        transcripts: z.boolean().default(false).describe("Include the new messages, not just the list."),
        max_chars: z.number().int().min(2000).max(45_000).default(40_000),
      },
      annotations: readOnly,
    },
    ({ since, chat_id, transcripts, max_chars }) =>
      run(async () => {
        const client = await provider.get();
        const when = parseSince(since)!;
        const chat = new SubstackChat(client);
        const tz = tzConfig.timeZone;
        if (!transcripts) return text(renderChatActivity(await chat.activity(when, { chatId: chat_id }), (iso) => `${isoSeconds(new Date(iso))} (${formatLocal(iso, tz)})`));
        const result = await chat.activityTranscript(when, { chatId: chat_id, maxChars: max_chars });
        if (result.activity.chats.length === 0) return text(renderChatActivity(result.activity, (iso) => isoSeconds(new Date(iso))));
        return text(result.text);
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

  if (dir) registerDigestTools(server, provider, dir, tzConfig, opts);

  return server;
}

function registerDigestTools(server: McpServer, provider: ClientProvider, dir: string, tz: { timeZone: string; warning?: string }, opts: ServerOptions): void {
  const lenientBool = z.union([z.boolean(), z.string()]).optional();

  server.registerTool(
    "digest_begin",
    {
      title: "Begin a digest run",
      description:
        "Start a digest run: fetch every post published since the last digest (minus ones already reported), the chats with new activity, and the user's interests, " +
        "and save the work list for digest_finish. Returns plain text with a RUN_ID, one line per post (ref P1, P2, …) and per chat, and what to do next. " +
        "Doesn't change the digest state; only digest_finish does.",
      inputSchema: {
        max_posts: z.number().int().min(1).max(200).default(100).describe("At most this many posts (newest first); the rest carry over to the next run."),
        include_chats: z.boolean().default(true),
        first_run_lookback: z.string().default("48h").describe('How far back to look when there is no saved state yet ("48h", "7d").'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ max_posts, include_chats, first_run_lookback }) =>
      run(async () => {
        const client = await provider.get();
        const { text: out } = await digestBegin(
          { dir, client, timezone: tz.timeZone, configWarnings: tz.warning ? [tz.warning] : [], now: opts.now, sleep: opts.sleep },
          { maxPosts: max_posts, includeChats: include_chats, firstRunLookback: first_run_lookback },
        );
        return text(out);
      }),
  );

  server.registerTool(
    "digest_finish",
    {
      title: "Finish a digest run",
      description:
        "Finish the run from digest_begin: give one entry per post (ref like \"P3\", or its URL) and one per chat (its id). " +
        "The server checks the entries against the run, lays out the final message, and saves state (every listed post counts as reported). " +
        "Returns status lines, then a line starting \"===== DIGEST\", then the message: reply with exactly that message, or exactly [SILENT] when that's the message. " +
        "Calling it again with the same run_id repeats the result without saving twice.",
      inputSchema: {
        run_id: z.string().min(1).describe("RUN_ID from digest_begin."),
        posts: z
          .array(
            z.object({
              ref: z.string().optional().describe('Post ref from digest_begin, e.g. "P3".'),
              url: z.string().optional().describe("The post URL, if you don't have the ref."),
              section: z.string().describe('"pick" (read in full), "other" (everything else), or "unreadable" (read_post failed).'),
              gist: z.string().optional().describe("1–2 sentences: the actual argument or findings."),
              why: z.string().optional().describe("For picks: one sentence on why it's worth reading in full."),
              preview_only: lenientBool.describe("true when read_post returned only a preview."),
              error: z.string().optional().describe("For unreadable posts: the error."),
            }),
          )
          .default([])
          .describe("Picks in the order they should appear; other entries in any order."),
        chats: z
          .array(
            z.object({
              id: z.string().describe("Chat id from digest_begin."),
              topics: z.string().optional().describe("1–3 sentences on what's being discussed."),
              for_user: z.string().optional().describe('Any question or mention directed at the user, else "none".'),
            }),
          )
          .default([]),
        render: z.boolean().default(true).describe("false: plain-text sections instead of the Discord message."),
        dry_run: z.boolean().default(false).describe("Show the result without saving anything."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ run_id, posts, chats, render, dry_run }) =>
      run(async () => {
        const result = await digestFinish(
          dir,
          { runId: run_id, posts, chats, render, dryRun: dry_run },
          { now: opts.now },
        );
        return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) };
      }),
  );

  server.registerTool(
    "digest_status",
    {
      title: "Digest status",
      description: "Read-only: the digest's last run, number of reported posts, publications waiting to be re-checked, and the current and recent runs. For debugging.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run(async () => text(await digestStatus(dir, tz.timeZone))),
  );

  server.registerTool(
    "mark_reported",
    {
      title: "Mark posts as reported",
      description:
        "Manual repair of the digest state: add post URLs to the reported list so future digests skip them, and optionally set last_run. Idempotent. Not part of a normal digest run.",
      inputSchema: {
        urls: z.array(z.string()).default([]).describe("Post URLs."),
        last_run: z.string().optional().describe("Set last_run to this ISO time."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ urls, last_run }) =>
      run(async () => {
        const result = await markReported(dir, { urls, lastRun: last_run }, { now: opts.now });
        return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) };
      }),
  );
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

export { parseSince };
