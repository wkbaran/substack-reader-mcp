import { describe, expect, it } from "vitest";
import type { RunFile, RunPost } from "../src/digest/collect.js";
import { reconcile, renderDigest } from "../src/digest/render.js";
import { formatDay, formatLocal } from "../src/time.js";

function post(n: number, publication: string, extra: Partial<RunPost> = {}): RunPost {
  return { ref: `P${n}`, url: `https://${publication.toLowerCase().replace(/\W/g, "")}.substack.com/p/post-${n}`, title: `Post ${n}`, publication, publicationId: n, date: `2026-10-02T0${n % 10}:00:00Z`, paywalled: false, ...extra };
}

function run(extra: Partial<RunFile> = {}): RunFile {
  return {
    version: 1,
    run_id: "r1",
    fetch_start: "2026-10-02T12:00:24Z",
    since: "2026-10-01T12:00:11Z",
    state_last_run_at_begin: "2026-10-01T12:00:11Z",
    first_run: false,
    timezone: "America/Denver",
    posts: [post(1, "Zeta", { paywalled: true }), post(2, "alpha"), post(3, "Beta"), post(4, "alpha"), post(5, "Beta")],
    chats: [
      { ref: "C1", id: "77", kind: "publication_chat", name: "Nate's Substack", newThreads: 1, repliedThreads: 0 },
      { ref: "C2", id: "dm1", kind: "direct_message", name: "DM with Carol", newThreads: 0, repliedThreads: 0 },
    ],
    publications: [],
    give_ups: [],
    max_posts: 100,
    overflow_posts: 0,
    warnings: [],
    ...extra,
  };
}

describe("time formatting", () => {
  it("formats local times with the zone abbreviation", () => {
    expect(formatLocal("2026-10-02T12:00:24Z", "America/Denver")).toBe("Fri, Oct 2, 6:00 AM MDT");
    expect(formatLocal("2026-12-02T12:00:24Z", "America/Denver")).toBe("Wed, Dec 2, 5:00 AM MST");
    expect(formatLocal("2026-10-02T12:00:24Z", "UTC")).toBe("Fri, Oct 2, 12:00 PM UTC");
    expect(formatDay("2026-10-02T03:00:00Z", "America/Denver")).toBe("Oct 1");
  });
});

describe("reconcile", () => {
  it("accepts refs in any case, numbers, and URLs", () => {
    const r = run({ chats: [] });
    const rec = reconcile(r, [
      { ref: "p2", section: "pick" },
      { ref: "1", section: "Other" },
      { url: "https://beta.substack.com/p/post-3/?utm=x", section: "other" },
      { ref: "P4", section: "unreadable", error: "HTTP 500" },
      { ref: "P5", section: "OTHER" },
    ], []);
    expect(rec.picks.map((e) => e.post.ref)).toEqual(["P2"]);
    expect(rec.others.map((e) => e.post.ref)).toEqual(["P1", "P3", "P5"]);
    expect(rec.unreadable.map((e) => [e.post.ref, e.error])).toEqual([["P4", "HTTP 500"]]);
    expect(rec.warnings).toEqual([]);
  });

  it("resolves duplicates pick > other > unreadable, drops unknown refs, flags missing posts", () => {
    const rec = reconcile(run(), [
      { ref: "P1", section: "other", gist: "from other" },
      { ref: "P1", section: "pick", why: "deep" },
      { ref: "P2", section: "pick" },
      { ref: "P2", section: "unreadable" },
      { ref: "P99", section: "pick" },
      { ref: "P3", section: "weird" },
    ], []);
    expect(rec.picks.map((e) => e.post.ref)).toEqual(["P1", "P2"]);
    expect(rec.picks[0]).toMatchObject({ gist: "from other", why: "deep" });
    expect(rec.others.map((e) => e.post.ref)).toEqual(["P3"]);
    expect(rec.missing.map((p) => p.ref)).toEqual(["P4", "P5"]);
    expect(rec.warnings.join("\n")).toMatch(/P1 was listed more than once; kept it as pick/);
    expect(rec.warnings.join("\n")).toMatch(/P2 was listed more than once; kept it as pick/);
    expect(rec.warnings.join("\n")).toMatch(/unknown post \(P99\)/);
    expect(rec.warnings.join("\n")).toMatch(/P3 had section "weird"; treated it as other/);
    expect(rec.warnings.join("\n")).toMatch(/2 posts have no entry \(P4, P5\)/);
  });

  it("matches chats by id, ref or name and normalizes for_user", () => {
    const rec = reconcile(run(), [], [
      { id: "c2", topics: "Carol asks about the meetup", for_user: "Are you coming?" },
      { id: "77", topics: "Agents", for_user: "none" },
      { id: "nope", topics: "?" },
    ]);
    expect(rec.chats.map((c) => [c.chat.id, c.forUser ?? null])).toEqual([["77", null], ["dm1", "Are you coming?"]]);
    expect(rec.warnings.join("\n")).toMatch(/unknown chat \(nope\)/);
  });
});

describe("renderDigest", () => {
  it("lays out picks, grouped others, chats, and couldn't-read", () => {
    const r = run();
    const rec = reconcile(r, [
      { ref: "P3", section: "pick", gist: "Beta's argument.", why: "Original data.", preview_only: "true" },
      { ref: "P1", section: "pick", gist: "Zeta's argument.", why: "Dense." },
      { ref: "P2", section: "other", gist: "Short one." },
      { ref: "P4", section: "other" },
      { ref: "P5", section: "unreadable", error: "HTTP 500" },
    ], [
      { id: "77", topics: "Agents", for_user: "none" },
      { id: "dm1", topics: "Meetup", for_user: "Are you coming?" },
    ]);
    expect(renderDigest(r, rec)).toBe(
      [
        "📬 **Substack** — 5 new posts, 2 chats with new activity (since Thu, Oct 1, 6:00 AM MDT)",
        "",
        "⭐ **Read in full**",
        "1. **Post 3** — Beta (preview only)",
        "   Beta's argument.",
        "   _Why:_ Original data.",
        "   https://beta.substack.com/p/post-3",
        "2. **Post 1** — Zeta [paid]",
        "   Zeta's argument.",
        "   _Why:_ Dense.",
        "   https://zeta.substack.com/p/post-1",
        "",
        "📰 **Everything else**",
        "**alpha**",
        "• Post 4 https://alpha.substack.com/p/post-4",
        "• Post 2 — Short one. https://alpha.substack.com/p/post-2",
        "",
        "💬 **Chats**",
        "• DM with Carol: Meetup ← _Are you coming?_",
        "• Nate's Substack: Agents",
        "",
        "⚠ **Couldn't read**",
        "• Post 5 — Beta (HTTP 500) https://beta.substack.com/p/post-5",
      ].join("\n"),
    );
  });

  it("sorts publication groups case-insensitively and marks missing posts and chats", () => {
    const r = run();
    const rec = reconcile(r, [{ ref: "P1", section: "other" }, { ref: "P3", section: "other" }, { ref: "P2", section: "other" }], []);
    const text = renderDigest(r, rec);
    const groups = text.split("\n").filter((l) => /^\*\*\w+\*\*$/.test(l));
    expect(groups).toEqual(["**alpha**", "**Beta**", "**Zeta**"]);
    expect(text).toContain("_Nothing stood out this time._");
    expect(text).toContain("• Post 4 — alpha (not summarized) https://alpha.substack.com/p/post-4");
    expect(text).toContain("• Nate's Substack: new activity (not summarized)");
  });

  it("lists publications it couldn't check and ones it gives up on", () => {
    const r = run({
      posts: [],
      chats: [],
      publications: [
        { id: "1", name: "The Pragmatic Engineer", outcome: "failed", since: "2026-10-02T12:00:00Z", error: "HTTP 429" },
        { id: "2", name: "Big Pub", outcome: "overflow", since: "2026-10-01T12:00:11Z", error: "more than 100 new posts in this run" },
        { id: "3", name: "Old Pub", outcome: "failed", since: "2026-09-24T12:00:00Z", error: "HTTP 429" },
        { id: "4", name: "Fine", outcome: "ok" },
      ],
      give_ups: [{ id: "3", name: "Old Pub", from: "2026-09-24T12:00:00Z", to: "2026-10-02T12:00:24Z", error: "HTTP 429" }],
    });
    const text = renderDigest(r, reconcile(r, [], []));
    expect(text).toBe(
      [
        "📬 **Substack** — 0 new posts, 0 chats with new activity (since Thu, Oct 1, 6:00 AM MDT)",
        "",
        "⚠ **Couldn't check**",
        "• The Pragmatic Engineer (HTTP 429) — retrying from Oct 2",
        "• Big Pub (too many new posts) — the rest come next time, from Oct 1",
        "• Giving up on Old Pub posts from Sep 24–Oct 2 (HTTP 429)",
      ].join("\n"),
    );
  });

  it("is exactly [SILENT] when there is nothing at all", () => {
    const r = run({ posts: [], chats: [], publications: [{ id: "4", name: "Fine", outcome: "ok" }] });
    expect(renderDigest(r, reconcile(r, [], []))).toBe("[SILENT]");
  });

  it("renders plain text without Discord markup", () => {
    const r = run({ chats: [] });
    const text = renderDigest(r, reconcile(r, [{ ref: "P1", section: "pick", why: "x" }], []), { markdown: false });
    expect(text).not.toMatch(/\*\*|_Why/);
    expect(text).toMatch(/^📬 Substack — 5 new posts/);
  });

  it("uses singular nouns for one post and one chat", () => {
    const r = run({ posts: [post(1, "Zeta")], chats: [run().chats[0]!] });
    expect(renderDigest(r, reconcile(r, [], [])).split("\n")[0]).toBe("📬 **Substack** — 1 new post, 1 chat with new activity (since Thu, Oct 1, 6:00 AM MDT)");
  });
});
