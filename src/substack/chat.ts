import { mapLimit, matchSubscription, SubstackClient } from "./api.js";
import { SubstackError } from "./http.js";

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

/** Render a thread as a readable transcript (cheaper for the model than JSON). */
export function renderThread(thread: { post: ChatThreadSummary; replies: ChatMessage[]; truncated: boolean }): string {
  const { post, replies } = thread;
  const lines = [
    `# Chat thread by ${post.author ?? "unknown"}`,
    `${post.createdAt ?? ""} · ${post.replies} replies · ${post.reactions} reactions`,
    "",
    post.body?.trim() || "(no text)",
    "",
    "---",
  ];
  if (thread.truncated) lines.push("_Older replies omitted; showing the most recent ones._", "");
  for (const r of replies) lines.push(...renderMessage(r, 0));
  if (replies.length === 0) lines.push("_No replies._");
  return lines.join("\n");
}

export function renderMessages(messages: ChatMessage[]): string {
  return messages.flatMap((m) => renderMessage(m, 0)).join("\n");
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
