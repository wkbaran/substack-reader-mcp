import { mapLimit, matchSubscription, SubstackClient } from "./api.js";
import { AuthError, SubstackError } from "./http.js";

// Substack Chat: publication community chats and direct messages. Everything
// lives on substack.com (no custom-domain handoff needed) and requires a login.

const BASE = "https://substack.com/api/v1";

// ---- Raw shapes (only the fields we read) ----

interface RawUser {
  id?: number;
  name?: string;
  handle?: string;
}

interface RawCommunityPost {
  id: string;
  created_at?: string;
  body?: string;
  comment_count?: number;
  reaction_count?: number;
  most_recent_comment_created_at?: string;
  publication_id?: number;
  audience?: string;
  is_locked?: boolean;
  user?: RawUser;
}

interface RawComment {
  id: string;
  created_at?: string;
  body?: string;
  reply_count?: number;
  reaction_count?: number;
  parent_id?: string | null;
}

interface RawReply {
  comment: RawComment;
  user?: RawUser;
}

interface RawInboxItem {
  type: string;
  id: string;
  title?: string;
  subtitleName?: string;
  subtitleBody?: string;
  timestamp?: string;
  unreadCount?: number;
  isPinned?: boolean;
  publication?: { id?: number; name?: string; subdomain?: string };
  communityPost?: RawCommunityPost & { has_unread_comments?: boolean };
  messageThread?: { id: string; is_one_on_one?: boolean };
  recentMessage?: { body?: string; created_at?: string };
}

// ---- Normalized shapes ----

export interface InboxItem {
  kind: "publication_chat" | "direct_message" | string;
  /** Pass to get_chat_threads (publication chats) or read_dm (direct messages). */
  id: string;
  title?: string;
  publication?: string;
  publicationId?: number;
  lastActivity?: string;
  unread?: number | boolean;
  preview?: string;
  pinned?: boolean;
}

export interface ChatThreadSummary {
  id: string;
  author?: string;
  createdAt?: string;
  body?: string;
  replies: number;
  reactions: number;
  lastReplyAt?: string;
  locked?: boolean;
}

export interface ChatMessage {
  id: string;
  author?: string;
  createdAt?: string;
  body: string;
  reactions: number;
  replies: ChatMessage[];
  /** Sub-replies Substack reports but that weren't fetched (limits). */
  unfetchedReplies?: number;
}

export interface ThreadActivity {
  id: string;
  author?: string;
  createdAt?: string;
  lastReplyAt?: string;
  replies: number;
  /** new_thread: started after `since`; new_replies: older thread with replies after `since`. */
  status: "new_thread" | "new_replies";
}

export interface ChatActivity {
  kind: "publication_chat" | "direct_message";
  /** Publication id (publication chats) or conversation id (DMs). */
  id: string;
  name: string;
  lastActivity?: string;
  /** Active threads, for publication chats. */
  threads: ThreadActivity[];
}

export interface ChatActivityResult {
  since: string;
  chats: ChatActivity[];
  /** Chats that couldn't be checked (no chat, no access, errors). */
  errors: Array<{ id: string; name: string; error: string }>;
}

// ---- API ----

export class SubstackChat {
  constructor(private readonly client: SubstackClient) {}

  private get http() {
    return this.client.http;
  }

  /** The chat inbox: publication chats the user belongs to plus direct messages. */
  async inbox(): Promise<{ items: InboxItem[]; unread: { directMessages?: number; publicationChats?: number } }> {
    const raw = await this.http.getJson<{
      threads?: RawInboxItem[];
      directMessagesUnreadCount?: number;
      pubChatUnreadCount?: number;
    }>(`${BASE}/messages/inbox?tab=all`, { requireAuth: true });
    return {
      items: (raw.threads ?? []).map(normalizeInboxItem),
      unread: { directMessages: raw.directMessagesUnreadCount, publicationChats: raw.pubChatUnreadCount },
    };
  }

  /** Threads in a publication's chat, newest first. `before` pages further back. */
  async threads(publication: string, { limit = 20, before }: { limit?: number; before?: string } = {}): Promise<{
    publication: string;
    threads: ChatThreadSummary[];
    nextBefore?: string;
  }> {
    const { id, name } = await this.resolvePublication(publication);
    const threads: ChatThreadSummary[] = [];
    let cursor = before;
    let more = true;
    while (threads.length < limit && more) {
      const url = `${BASE}/community/publications/${id}/posts${cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`;
      const raw = await this.http
        .getJson<{ threads?: Array<{ communityPost: RawCommunityPost; user?: RawUser }>; moreBefore?: boolean }>(url, { requireAuth: true })
        .catch((err: unknown) => {
          if (err instanceof SubstackError && err.status === 404) {
            throw new SubstackError(`${name} doesn't have a chat (or you don't have access to it).`, 404, url);
          }
          throw chatAccessError(err, name);
        });
      const page = raw.threads ?? [];
      for (const t of page) threads.push(summarizeThread(t.communityPost, t.user));
      more = Boolean(raw.moreBefore) && page.length > 0;
      cursor = page.at(-1)?.communityPost.created_at;
    }
    const out = threads.slice(0, limit);
    const last = out.at(-1)?.createdAt;
    return { publication: name, threads: out, nextBefore: more || threads.length > limit ? last : undefined };
  }

  /**
   * A chat thread with its replies and, optionally, replies to those replies.
   * Pages through Substack's windowed comment API in both directions.
   */
  async thread(threadId: string, { maxReplies = 200, subReplies = true, maxSubReplyFetches = 25 } = {}): Promise<{
    post: ChatThreadSummary;
    replies: ChatMessage[];
    truncated: boolean;
  }> {
    const id = threadId.trim();
    const first = await this.http
      .getJson<CommentsPage & { post?: { communityPost: RawCommunityPost; user?: RawUser } }>(
        `${BASE}/community/posts/${encodeURIComponent(id)}/comments?order=asc&initial=true`,
        { requireAuth: true },
      )
      .catch((err: unknown) => {
        throw chatAccessError(err, "this thread");
      });
    if (!first.post) throw new SubstackError(`Chat thread ${id} not found.`, 404);

    const { replies, truncated } = await this.pageComments(`${BASE}/community/posts/${encodeURIComponent(id)}/comments`, first, maxReplies);
    const messages = replies.map(toMessage);

    if (subReplies) {
      const parents = messages.filter((m) => (m.unfetchedReplies ?? 0) > 0).slice(0, maxSubReplyFetches);
      await mapLimit(parents, 4, async (parent) => {
        const url = `${BASE}/community/comments/${encodeURIComponent(parent.id)}/comments`;
        const page = await this.http.getJson<CommentsPage>(`${url}?order=asc&initial=true`, { requireAuth: true }).catch(() => null);
        if (!page) return;
        const sub = await this.pageComments(url, page, 100);
        parent.replies = sub.replies.map(toMessage);
        parent.unfetchedReplies = Math.max(0, (parent.unfetchedReplies ?? 0) - parent.replies.length) || undefined;
      });
    }

    return { post: summarizeThread(first.post.communityPost, first.post.user), replies: messages, truncated };
  }

  /** A direct-message conversation. `id` comes from list_chats. */
  async directMessages(conversationId: string): Promise<{ with?: string; messages: ChatMessage[] }> {
    const id = conversationId.trim().replace(/^direct-message-/, "");
    const raw = await this.http
      .getJson<{ replies?: RawReply[]; profile?: RawUser }>(`${BASE}/messages/dm/${encodeURIComponent(id)}`, { requireAuth: true })
      .catch((err: unknown) => {
        throw chatAccessError(err, "this conversation");
      });
    const messages = (raw.replies ?? [])
      .map(toMessage)
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    return { with: describeUser(raw.profile), messages };
  }

  /**
   * Chats and DMs with activity after `since`. The inbox's unread flags are never
   * set and its timestamp doesn't move when someone replies to an older thread, so
   * each publication chat's thread list is checked instead: a thread counts when
   * it was created, or last replied to, after `since`. DMs count by the inbox
   * timestamp. Publication chats quiet for `lookbackDays` before `since` are skipped.
   */
  async activity(since: Date, { chatId, lookbackDays = 60, maxPages = 3 }: { chatId?: string; lookbackDays?: number; maxPages?: number } = {}): Promise<ChatActivityResult> {
    const { items } = await this.inbox();
    const wanted = chatId?.trim().replace(/^direct-message-/, "");
    const quietBefore = since.getTime() - lookbackDays * 86_400_000;
    const candidates = items.filter((item) => {
      if (wanted !== undefined && item.id !== wanted) return false;
      if (item.kind === "direct_message") return timeOf(item.lastActivity) > since.getTime();
      if (item.kind !== "publication_chat") return false;
      return item.lastActivity === undefined || timeOf(item.lastActivity) >= quietBefore;
    });

    const errors: ChatActivityResult["errors"] = [];
    const results = await mapLimit(candidates, 2, async (item): Promise<ChatActivity | null> => {
      const name = item.kind === "direct_message" ? `DM with ${item.title ?? "unknown"}` : (item.publication ?? item.title ?? `publication ${item.id}`);
      if (item.kind === "direct_message") {
        return { kind: "direct_message", id: item.id, name, lastActivity: item.lastActivity, threads: [] };
      }
      try {
        const threads = await this.activeThreads(item.id, since, maxPages);
        return threads.length ? { kind: "publication_chat", id: item.id, name, lastActivity: item.lastActivity, threads } : null;
      } catch (err) {
        if (err instanceof AuthError) throw err;
        errors.push({ id: item.id, name, error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    });
    return { since: since.toISOString(), chats: results.filter((c): c is ChatActivity => c !== null), errors };
  }

  /** Threads in a publication chat created or replied to after `since`. */
  private async activeThreads(publicationId: string, since: Date, maxPages: number): Promise<ThreadActivity[]> {
    const cutoff = since.getTime();
    const out: ThreadActivity[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const url = `${BASE}/community/publications/${encodeURIComponent(publicationId)}/posts${cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`;
      const raw = await this.http
        .getJson<{ threads?: Array<{ communityPost: RawCommunityPost; user?: RawUser }>; moreBefore?: boolean }>(url, { requireAuth: true })
        .catch((err: unknown) => {
          if (err instanceof SubstackError && err.status === 404) throw new SubstackError("no chat (HTTP 404)", 404, url);
          throw chatAccessError(err, "this chat");
        });
      const list = raw.threads ?? [];
      for (const t of list) {
        const s = summarizeThread(t.communityPost, t.user);
        const created = timeOf(s.createdAt);
        const replied = timeOf(s.lastReplyAt);
        if (created > cutoff || replied > cutoff) {
          out.push({ id: s.id, author: s.author, createdAt: s.createdAt, lastReplyAt: s.lastReplyAt, replies: s.replies, status: created > cutoff ? "new_thread" : "new_replies" });
        }
      }
      // Threads come newest-created first. Once a page reaches threads created
      // before `since`, every new thread has been seen.
      const oldest = list.at(-1)?.communityPost.created_at;
      if (!raw.moreBefore || list.length === 0 || timeOf(oldest) <= cutoff) break;
      cursor = oldest;
    }
    return out;
  }

  /**
   * Transcripts of the activity after `since`: for each active thread, its opening
   * post and only the replies after `since`; for each active DM, the messages after
   * `since`. Truncated to `maxChars`.
   */
  async activityTranscript(since: Date, { chatId, maxChars = 40_000, lookbackDays }: { chatId?: string; maxChars?: number; lookbackDays?: number } = {}): Promise<{ text: string; activity: ChatActivityResult }> {
    const activity = await this.activity(since, { chatId, lookbackDays });
    const parts: string[] = [];
    for (const chat of activity.chats) {
      if (chat.kind === "direct_message") {
        const dm = await this.directMessages(chat.id).catch((err: unknown) => {
          if (err instanceof AuthError) throw err;
          return err instanceof Error ? err.message : String(err);
        });
        if (typeof dm === "string") {
          parts.push(`# ${chat.name}\n\n_Couldn't read: ${dm}_`);
          continue;
        }
        const recent = dm.messages.filter((m) => timeOf(m.createdAt) > since.getTime());
        const earlier = dm.messages.length - recent.length;
        parts.push(
          [`# ${dm.with ? `DM with ${dm.with}` : chat.name}`, "", earlier ? `_(${earlier} earlier messages)_` : null, recent.length ? renderMessages(recent) : "_No messages after the cutoff._"]
            .filter((l): l is string => l !== null)
            .join("\n"),
        );
        continue;
      }
      const threads = await mapLimit(chat.threads, 2, (t) =>
        this.thread(t.id).catch((err: unknown) => {
          if (err instanceof AuthError) throw err;
          return err instanceof Error ? err.message : String(err);
        }),
      );
      const body = threads.map((t, i) =>
        typeof t === "string"
          ? `# Chat thread ${chat.threads[i]!.id}\n\n_Couldn't read: ${t}_`
          : renderThread(t, { since, label: chat.threads[i]!.status === "new_thread" ? "new thread" : "new replies" }),
      );
      parts.push(`# ${chat.name} (publication chat ${chat.id})\n\n${body.join("\n\n")}`);
    }
    let text = parts.join("\n\n======\n\n");
    if (text.length > maxChars) {
      const note = `\n\n_[Truncated at ${maxChars} characters. Call again with chat_id to read one chat at a time.]_`;
      text = text.slice(0, Math.max(0, maxChars - note.length)) + note;
    }
    return { text, activity };
  }

  private async pageComments(url: string, first: CommentsPage, max: number): Promise<{ replies: RawReply[]; truncated: boolean }> {
    let replies = [...(first.replies ?? [])];
    let page = first;
    while (page.moreBefore && replies.length > 0 && replies.length < max) {
      page = await this.http.getJson<CommentsPage>(`${url}?order=asc&before_id=${encodeURIComponent(replies[0]!.comment.id)}`, { requireAuth: true });
      if (!page.replies?.length) break;
      replies = [...page.replies, ...replies];
    }
    const moreBefore = Boolean(page.moreBefore);
    page = first;
    while (page.moreAfter && replies.length > 0 && replies.length < max) {
      page = await this.http.getJson<CommentsPage>(`${url}?order=asc&after_id=${encodeURIComponent(replies.at(-1)!.comment.id)}`, { requireAuth: true });
      if (!page.replies?.length) break;
      replies = [...replies, ...page.replies];
    }
    const truncated = replies.length > max || moreBefore || Boolean(page.moreAfter);
    // Keep the newest `max` when trimming: in a chat, recent messages matter most.
    return { replies: replies.slice(-max), truncated };
  }

  private async resolvePublication(input: string): Promise<{ id: number; name: string }> {
    const value = input.trim();
    if (/^\d+$/.test(value)) return { id: Number(value), name: `publication ${value}` };
    const subs = await this.client.subscriptions();
    const matches = matchSubscription(value, subs);
    if (matches.length === 1) return { id: matches[0]!.publicationId, name: matches[0]!.name };
    if (matches.length > 1) {
      throw new SubstackError(`"${input}" matches several subscriptions (${matches.map((m) => m.name).join(", ")}). Be more specific.`);
    }
    const info = await this.client.publicationInfo(value);
    return { id: info.id, name: info.name };
  }
}

interface CommentsPage {
  replies?: RawReply[];
  moreBefore?: boolean;
  moreAfter?: boolean;
}

// ---- helpers ----

function timeOf(date?: string): number {
  const t = date ? Date.parse(date) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// Note: `unread` for publication chats is not reliable. `has_unread_comments` has
// never been seen set, and the inbox's `pubChatUnreadCount` never goes down because
// nothing here marks chats as seen. Use `SubstackChat.activity` (activity since a
// time) to find what's new.
function normalizeInboxItem(t: RawInboxItem): InboxItem {
  if (t.type === "direct-message") {
    return {
      kind: "direct_message",
      id: t.messageThread?.id ?? t.id.replace(/^direct-message-/, ""),
      title: t.title,
      lastActivity: t.timestamp ?? t.recentMessage?.created_at,
      unread: t.unreadCount || undefined,
      preview: clip(t.subtitleBody ?? t.recentMessage?.body, 140),
      pinned: t.isPinned || undefined,
    };
  }
  return {
    kind: t.type === "chat" ? "publication_chat" : t.type,
    id: String(t.publication?.id ?? t.communityPost?.publication_id ?? t.id),
    title: t.title,
    publication: t.publication?.name,
    publicationId: t.publication?.id ?? t.communityPost?.publication_id,
    lastActivity: t.timestamp,
    unread: t.communityPost?.has_unread_comments || undefined,
    preview: clip([t.subtitleName, t.subtitleBody].filter(Boolean).join(": "), 140),
    pinned: t.isPinned || undefined,
  };
}

function summarizeThread(p: RawCommunityPost, user?: RawUser): ChatThreadSummary {
  return {
    id: p.id,
    author: describeUser(user ?? p.user),
    createdAt: p.created_at,
    body: p.body,
    replies: p.comment_count ?? 0,
    reactions: p.reaction_count ?? 0,
    lastReplyAt: p.most_recent_comment_created_at,
    locked: p.is_locked || undefined,
  };
}

function toMessage(r: RawReply): ChatMessage {
  return {
    id: r.comment.id,
    author: describeUser(r.user),
    createdAt: r.comment.created_at,
    body: r.comment.body ?? "",
    reactions: r.comment.reaction_count ?? 0,
    replies: [],
    unfetchedReplies: r.comment.reply_count || undefined,
  };
}

function describeUser(u?: RawUser): string | undefined {
  if (!u) return undefined;
  if (u.name && u.handle) return `${u.name} (@${u.handle})`;
  return u.name ?? (u.handle ? `@${u.handle}` : undefined);
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function chatAccessError(err: unknown, what: string): unknown {
  if (err instanceof SubstackError && err.status === 402) {
    return new SubstackError(`Access to ${what} requires a paid subscription.`, 402);
  }
  if (err instanceof SubstackError && err.status === 403) {
    return new SubstackError(`You don't have permission to view ${what}.`, 403);
  }
  return err;
}

/**
 * Render a thread as a readable transcript (cheaper for the model than JSON).
 * With `since`, replies from before it are collapsed into a count, except ones
 * that have newer replies under them.
 */
export function renderThread(
  thread: { post: ChatThreadSummary; replies: ChatMessage[]; truncated: boolean },
  { since, label }: { since?: Date; label?: string } = {},
): string {
  const { post } = thread;
  const lines = [
    `# Chat thread by ${post.author ?? "unknown"}${label ? ` (${label})` : ""}`,
    `${post.createdAt ?? ""} · ${post.replies} replies · ${post.reactions} reactions`,
    "",
    post.body?.trim() || "(no text)",
    "",
    "---",
  ];
  if (thread.truncated) lines.push("_Older replies omitted; showing the most recent ones._", "");
  const { messages, hidden } = since ? onlySince(thread.replies, since) : { messages: thread.replies, hidden: 0 };
  if (hidden) lines.push(`_(${hidden} earlier replies)_`);
  for (const r of messages) lines.push(...renderMessage(r, 0));
  if (thread.replies.length === 0) lines.push("_No replies._");
  else if (messages.length === 0) lines.push("_No replies after the cutoff._");
  return lines.join("\n");
}

export function renderMessages(messages: ChatMessage[], { since }: { since?: Date } = {}): string {
  const { messages: shown, hidden } = since ? onlySince(messages, since) : { messages, hidden: 0 };
  const lines = shown.flatMap((m) => renderMessage(m, 0));
  if (hidden) lines.unshift(`_(${hidden} earlier messages)_`);
  return lines.join("\n");
}

/** Messages after `since`, plus older ones that have newer replies (kept for context). */
function onlySince(messages: ChatMessage[], since: Date): { messages: ChatMessage[]; hidden: number } {
  let hidden = 0;
  const walk = (list: ChatMessage[]): ChatMessage[] => {
    const out: ChatMessage[] = [];
    for (const m of list) {
      const replies = walk(m.replies);
      if (timeOf(m.createdAt) > since.getTime() || replies.length > 0) out.push({ ...m, replies });
      else hidden += 1 + countAll(m.replies);
    }
    return out;
  };
  const kept = walk(messages);
  return { messages: kept, hidden };
}

function countAll(list: ChatMessage[]): number {
  return list.reduce((n, m) => n + 1 + countAll(m.replies), 0);
}

function renderMessage(m: ChatMessage, depth: number): string[] {
  const indent = "  ".repeat(depth);
  const reactions = m.reactions ? ` · ${m.reactions}♥` : "";
  const body = (m.body.trim() || "(attachment or empty message)").replace(/\n/g, `\n${indent}  `);
  const out = [`${indent}- **${m.author ?? "unknown"}** (${m.createdAt ?? "?"}${reactions}): ${body}`];
  for (const r of m.replies) out.push(...renderMessage(r, depth + 1));
  if (m.unfetchedReplies) out.push(`${indent}  - _(${m.unfetchedReplies} more replies not loaded)_`);
  return out;
}

/** Plain-text listing of chat activity, one line per chat and per active thread. */
export function renderChatActivity(result: ChatActivityResult, when: (iso: string) => string = (iso) => iso): string {
  const lines = [`CHAT ACTIVITY since ${when(result.since)}: ${result.chats.length} chat${result.chats.length === 1 ? "" : "s"} with activity`];
  for (const c of result.chats) {
    if (c.kind === "direct_message") {
      lines.push(`- ${c.name} | DM id ${c.id} | last message ${c.lastActivity ?? "?"}`);
      continue;
    }
    const fresh = c.threads.filter((t) => t.status === "new_thread").length;
    const replied = c.threads.length - fresh;
    lines.push(`- ${c.name} | publication chat id ${c.id} | ${fresh} new thread${fresh === 1 ? "" : "s"}, ${replied} thread${replied === 1 ? "" : "s"} with new replies`);
    for (const t of c.threads) {
      lines.push(`  - thread ${t.id} | ${t.status} | by ${t.author ?? "unknown"} | created ${t.createdAt ?? "?"} | last reply ${t.lastReplyAt ?? "none"} | ${t.replies} replies`);
    }
  }
  for (const e of result.errors) lines.push(`! couldn't check ${e.name} (id ${e.id}): ${e.error}`);
  return lines.join("\n");
}
