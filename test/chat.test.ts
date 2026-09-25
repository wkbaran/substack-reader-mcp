import { describe, expect, it } from "vitest";
import { SubstackClient } from "../src/substack/api.js";
import { renderThread, SubstackChat } from "../src/substack/chat.js";
import { SubstackHttp } from "../src/substack/http.js";
import { authed, fakeFetch, SID, type Route } from "./helpers.js";

const B = "https://substack.com/api/v1";
const alice = { id: 1, name: "Alice", handle: "alice" };
const bob = { id: 2, name: "Bob", handle: "bob" };

function reply(id: string, user = bob, extra: Record<string, unknown> = {}) {
  return { comment: { id, created_at: `2026-09-2${id.length}T00:00:00Z`, body: `message ${id}`, reaction_count: 0, reply_count: 0, ...extra }, user };
}

function thread(id: string, created: string, comments = 0) {
  return { communityPost: { id, created_at: created, body: `thread ${id}`, comment_count: comments, reaction_count: 1, user: alice }, user: alice };
}

function chat(routes: Record<string, Route | ((req: never) => Route)>) {
  const all: Record<string, Route | ((req: never) => Route)> = {
    [`${B}/user/profile/self`]: authed({
      id: 9,
      subscriptions: [{ membership_state: "subscribed", publication: { id: 77, name: "Nate's Substack", subdomain: "nate" } }],
    }),
    ...routes,
  };
  const { fetch, requests } = fakeFetch(all as never);
  const client = new SubstackClient(new SubstackHttp({ sid: SID, fetch, sleep: async () => {} }));
  return { chat: new SubstackChat(client), requests };
}

describe("SubstackChat", () => {
  it("normalizes the inbox into publication chats and DMs", async () => {
    const { chat: c } = chat({
      [`${B}/messages/inbox?tab=all`]: authed({
        directMessagesUnreadCount: 1,
        pubChatUnreadCount: 0,
        threads: [
          {
            type: "chat",
            id: "chat-abc",
            title: "Nate's Substack",
            timestamp: "2026-09-25T10:00:00Z",
            publication: { id: 77, name: "Nate's Substack" },
            subtitleName: "Nate",
            subtitleBody: "New thread about agents",
            communityPost: { id: "p1", publication_id: 77, has_unread_comments: true },
          },
          {
            type: "direct-message",
            id: "direct-message-dm1",
            title: "Carol Writes",
            timestamp: "2026-09-24T10:00:00Z",
            unreadCount: 2,
            messageThread: { id: "dm1" },
            subtitleBody: "hey there",
          },
        ],
      }),
    });
    const inbox = await c.inbox();
    expect(inbox.unread).toEqual({ directMessages: 1, publicationChats: 0 });
    expect(inbox.items).toEqual([
      { kind: "publication_chat", id: "77", title: "Nate's Substack", publication: "Nate's Substack", publicationId: 77, lastActivity: "2026-09-25T10:00:00Z", unread: true, preview: "Nate: New thread about agents", pinned: undefined },
      { kind: "direct_message", id: "dm1", title: "Carol Writes", lastActivity: "2026-09-24T10:00:00Z", unread: 2, preview: "hey there", pinned: undefined },
    ]);
  });

  it("pages chat threads with the `before` cursor and resolves publications by name", async () => {
    const { chat: c, requests } = chat({
      [`${B}/community/publications/77/posts`]: authed({ threads: [thread("t1", "2026-09-25T00:00:00Z", 3), thread("t2", "2026-09-24T00:00:00Z")], moreBefore: true }),
      [`${B}/community/publications/77/posts?before=2026-09-24T00%3A00%3A00Z`]: authed({ threads: [thread("t3", "2026-09-23T00:00:00Z")], moreBefore: false }),
    });
    const result = await c.threads("nate", { limit: 3 });
    expect(result.publication).toBe("Nate's Substack");
    expect(result.threads.map((t) => [t.id, t.replies, t.author])).toEqual([
      ["t1", 3, "Alice (@alice)"],
      ["t2", 0, "Alice (@alice)"],
      ["t3", 0, "Alice (@alice)"],
    ]);
    expect(result.nextBefore).toBeUndefined();
    expect(requests.filter((r) => r.url.includes("/community/")).length).toBe(2);
  });

  it("offers a cursor when there's more", async () => {
    const { chat: c } = chat({
      [`${B}/community/publications/77/posts`]: authed({ threads: [thread("t1", "2026-09-25T00:00:00Z"), thread("t2", "2026-09-24T00:00:00Z")], moreBefore: true }),
    });
    const result = await c.threads("77", { limit: 1 });
    expect(result.threads.map((t) => t.id)).toEqual(["t1"]);
    expect(result.nextBefore).toBe("2026-09-25T00:00:00Z");
  });

  it("explains when a publication has no chat", async () => {
    const { chat: c } = chat({ [`${B}/community/publications/77/posts`]: { status: 404, body: { status: "not found" } } });
    await expect(c.threads("nate")).rejects.toThrow(/Nate's Substack doesn't have a chat/);
  });

  it("reads a thread, pages the reply window both ways, and loads sub-replies", async () => {
    const post = { communityPost: { id: "t1", created_at: "2026-09-25T00:00:00Z", body: "What do you think?", comment_count: 4, reaction_count: 2 }, user: alice };
    const { chat: c } = chat({
      [`${B}/community/posts/t1/comments?order=asc&initial=true`]: authed({ post, replies: [reply("r2"), reply("r3", alice, { reply_count: 2 })], moreBefore: true, moreAfter: true }),
      [`${B}/community/posts/t1/comments?order=asc&before_id=r2`]: authed({ replies: [reply("r1")], moreBefore: false }),
      [`${B}/community/posts/t1/comments?order=asc&after_id=r3`]: authed({ replies: [reply("r4")], moreAfter: false }),
      [`${B}/community/comments/r3/comments?order=asc&initial=true`]: authed({ replies: [reply("s1"), reply("s2", alice)] }),
    });
    const t = await c.thread("t1");
    expect(t.replies.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(t.replies[2]!.replies.map((r) => r.id)).toEqual(["s1", "s2"]);
    expect(t.replies[2]!.unfetchedReplies).toBeUndefined();
    expect(t.truncated).toBe(false);

    const text = renderThread(t);
    expect(text).toMatch(/^# Chat thread by Alice \(@alice\)/);
    expect(text).toContain("What do you think?");
    expect(text).toContain("- **Bob (@bob)**");
    expect(text).toContain("  - **Alice (@alice)**"); // nested sub-reply
  });

  it("keeps the most recent replies when capped", async () => {
    const post = { communityPost: { id: "t1", comment_count: 3 }, user: alice };
    const { chat: c } = chat({
      [`${B}/community/posts/t1/comments?order=asc&initial=true`]: authed({ post, replies: [reply("r1"), reply("r2"), reply("r3")] }),
    });
    const t = await c.thread("t1", { maxReplies: 2, subReplies: false });
    expect(t.replies.map((r) => r.id)).toEqual(["r2", "r3"]);
    expect(t.truncated).toBe(true);
    expect(renderThread(t)).toMatch(/Older replies omitted/);
  });

  it("reads a DM conversation in chronological order", async () => {
    const { chat: c } = chat({
      [`${B}/messages/dm/dm1`]: authed({
        profile: { name: "Carol", handle: "carolwrites" },
        replies: [
          { comment: { id: "m2", created_at: "2026-09-24T12:00:00Z", body: "second" }, user: bob },
          { comment: { id: "m1", created_at: "2026-09-24T11:00:00Z", body: "first" }, user: alice },
        ],
      }),
    });
    const dm = await c.directMessages("direct-message-dm1");
    expect(dm.with).toBe("Carol (@carolwrites)");
    expect(dm.messages.map((m) => m.body)).toEqual(["first", "second"]);
  });

  it("requires a login", async () => {
    const { fetch } = fakeFetch({});
    const c = new SubstackChat(new SubstackClient(new SubstackHttp({ fetch })));
    await expect(c.inbox()).rejects.toThrow(/Not logged in/);
  });
});
