import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { digestBegin, type RunFile } from "../src/digest/collect.js";
import { SubstackClient } from "../src/substack/api.js";
import { AuthError, SubstackHttp } from "../src/substack/http.js";
import { authed, fakeFetch, SID, type Route } from "./helpers.js";

const NOW = Date.parse("2026-10-02T12:00:24Z");
const LAST = "2026-10-01T12:00:11Z";

const PROFILE = {
  id: 42,
  subscriptions: [
    { membership_state: "free_signup", publication: { id: 1, name: "Alpha", subdomain: "alpha" } },
    { membership_state: "free_signup", publication: { id: 2, name: "Beta", subdomain: "beta" } },
    { membership_state: "free_signup", publication: { id: 3, name: "Gone", subdomain: "gone" } },
  ],
};

const archive = (sub: string, offset = 0, limit = 20) => `https://${sub}.substack.com/api/v1/archive?sort=new&offset=${offset}&limit=${limit}`;
const p = (sub: string, n: number, date: string, extra: Record<string, unknown> = {}) => ({
  id: n,
  title: `${sub} ${n}`,
  post_date: date,
  audience: "everyone",
  canonical_url: `https://${sub}.substack.com/p/post-${n}`,
  ...extra,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "substack-digest-"));
});

function setup(routes: Record<string, Route | ((req: never) => Route)>) {
  const { fetch, requests } = fakeFetch({
    "https://substack.com/api/v1/user/profile/self": authed(PROFILE),
    "https://substack.com/api/v1/messages/inbox?tab=all": authed({ threads: [] }),
    [archive("alpha")]: { body: [] },
    [archive("beta")]: { body: [] },
    [archive("gone")]: { status: 404 },
    ...routes,
  } as never);
  const sleeps: number[] = [];
  const client = new SubstackClient(new SubstackHttp({ sid: SID, fetch, sleep: async () => {} }));
  const begin = (opts = {}) => digestBegin({ dir, client, timezone: "America/Denver", now: () => NOW, sleep: async (ms) => void sleeps.push(ms) }, opts);
  return { begin, requests, sleeps };
}

async function writeState(state: unknown) {
  await writeFile(join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

async function runFile(): Promise<RunFile> {
  return JSON.parse(await readFile(join(dir, "current_run.json"), "utf8")) as RunFile;
}

describe("digestBegin", () => {
  it("collects new posts newest first, drops reported ones, writes only the run file", async () => {
    const state = { last_run: LAST, reported_posts: ["https://alpha.substack.com/p/post-2/"] };
    await writeState(state);
    const before = await readFile(join(dir, "state.json"), "utf8");
    const { begin } = setup({
      [archive("alpha")]: { body: [p("alpha", 1, "2026-10-02T10:00:00Z", { audience: "only_paid" }), p("alpha", 2, "2026-10-02T09:00:00Z"), p("alpha", 3, "2026-09-30T00:00:00Z")] },
      [archive("beta")]: { body: [p("beta", 4, "2026-10-02T11:00:00Z", { type: "podcast" })] },
    });
    const { text, run } = await begin();
    expect(run.posts.map((x) => [x.ref, x.title, x.paywalled])).toEqual([
      ["P1", "beta 4", false],
      ["P2", "alpha 1", true],
    ]);
    expect(run).toMatchObject({ fetch_start: "2026-10-02T12:00:24Z", since: LAST, state_last_run_at_begin: LAST, first_run: false });
    expect(text).toMatch(/^RUN_ID: 20261002-120024-[0-9a-f]{4}$/m);
    expect(text).toContain("SINCE: 2026-10-01T12:00:11Z (Thu, Oct 1, 6:00 AM MDT)");
    expect(text).toContain("P1 | beta 4 | Beta | Oct 2, 5:00 AM | free | podcast | https://beta.substack.com/p/post-4");
    expect(text).toContain("P2 | alpha 1 | Alpha | Oct 2, 4:00 AM | paid | newsletter | https://alpha.substack.com/p/post-1");
    expect(text).toMatch(/NEXT: .*digest_finish/);
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe(before);
    expect((await readdir(dir)).sort()).toEqual(["current_run.json", "state.json"]);
    expect((await runFile()).run_id).toBe(run.run_id);
  });

  it("uses a carried publication's own cutoff", async () => {
    await writeState({ version: 2, last_run: LAST, pending_publications: { "2": { name: "Beta", since: "2026-09-29T00:00:00Z", error: "HTTP 429", failures: 1 } }, reported_posts: [] });
    const { begin } = setup({
      [archive("alpha")]: { body: [p("alpha", 1, "2026-09-30T00:00:00Z")] },
      [archive("beta")]: { body: [p("beta", 2, "2026-09-30T00:00:00Z")] },
    });
    const { run, text } = await begin();
    expect(run.posts.map((x) => x.title)).toEqual(["beta 2"]);
    expect(run.publications.find((x) => x.id === "2")).toMatchObject({ outcome: "ok", carried: true, since: "2026-09-29T00:00:00Z" });
    expect(text).toMatch(/1 carried over from earlier runs/);
  });

  it("pages back at offset 20 when a whole page is new", async () => {
    const page1 = Array.from({ length: 20 }, (_, i) => p("alpha", 100 + i, `2026-10-02T${String(11 - Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}:00Z`));
    const { begin, requests } = setup({
      [archive("alpha")]: { body: page1 },
      [archive("alpha", 20)]: { body: [p("alpha", 200, "2026-10-01T13:00:00Z"), p("alpha", 201, "2026-09-01T00:00:00Z")] },
    });
    await writeState({ last_run: LAST, reported_posts: [] });
    const { run } = await begin();
    expect(run.posts).toHaveLength(21);
    expect(requests.some((r) => r.url === archive("alpha", 20))).toBe(true);
    expect(requests.some((r) => r.url === archive("alpha", 40))).toBe(false);
  });

  it("recovers a publication that returns 429 four times in the 15 s retry pass", async () => {
    let n = 0;
    const { begin, sleeps } = setup({
      [archive("beta")]: () => (++n <= 4 ? { status: 429 } : { body: [p("beta", 5, "2026-10-02T08:00:00Z")] }),
    });
    await writeState({ last_run: LAST, reported_posts: [] });
    const { run } = await begin();
    expect(n).toBe(5);
    expect(sleeps[0]).toBe(15000);
    expect(run.posts.map((x) => x.title)).toEqual(["beta 5"]);
    expect(run.publications.find((x) => x.id === "2")?.outcome).toBe("ok");
  });

  it("carries a publication that keeps failing with 429, and doesn't retry a 404", async () => {
    const { begin, requests } = setup({ [archive("beta")]: { status: 429 } });
    await writeState({ last_run: LAST, reported_posts: [] });
    const { run, text } = await begin();
    expect(run.publications.find((x) => x.id === "2")).toMatchObject({ outcome: "failed", error: "HTTP 429", since: LAST });
    expect(run.publications.find((x) => x.id === "3")).toMatchObject({ outcome: "failed", error: "not found (HTTP 404)" });
    expect(requests.filter((r) => r.url === archive("gone"))).toHaveLength(1);
    expect(requests.filter((r) => r.url === archive("beta"))).toHaveLength(12);
    expect(text).toContain("- Beta: HTTP 429; retrying from Oct 1");
  });

  it("gives up on a publication not checked for more than 7 days", async () => {
    await writeState({ version: 2, last_run: LAST, pending_publications: { "2": { name: "Beta", since: "2026-09-24T00:00:00Z", error: "HTTP 429", failures: 7 } }, reported_posts: [] });
    const { begin } = setup({ [archive("beta")]: { status: 429 } });
    const { run, text } = await begin();
    expect(run.give_ups).toEqual([{ id: "2", name: "Beta", from: "2026-09-24T00:00:00Z", to: "2026-10-02T12:00:24Z", error: "HTTP 429" }]);
    expect(text).toContain("- Beta: posts from Sep 23 to Oct 2 (HTTP 429)");
  });

  it("caps at max_posts and carries the publications that overflowed", async () => {
    const { begin } = setup({
      [archive("alpha")]: { body: [p("alpha", 1, "2026-10-02T10:00:00Z"), p("alpha", 2, "2026-10-02T06:00:00Z")] },
      [archive("beta")]: { body: [p("beta", 3, "2026-10-02T08:00:00Z")] },
    });
    await writeState({ last_run: LAST, reported_posts: [] });
    const { run, text } = await begin({ maxPosts: 2 });
    expect(run.posts.map((x) => x.title)).toEqual(["alpha 1", "beta 3"]);
    expect(run.publications.find((x) => x.id === "1")?.outcome).toBe("overflow");
    expect(run.publications.find((x) => x.id === "2")?.outcome).toBe("ok");
    expect(text).toContain("1 more new posts didn't fit in max_posts=2");
  });

  it("uses the first-run lookback when there is no state", async () => {
    const { begin } = setup({ [archive("alpha")]: { body: [p("alpha", 1, "2026-10-01T00:00:00Z"), p("alpha", 2, "2026-09-29T00:00:00Z")] } });
    const { run } = await begin();
    expect(run).toMatchObject({ first_run: true, since: "2026-09-30T12:00:24Z", state_last_run_at_begin: null });
    expect(run.posts.map((x) => x.title)).toEqual(["alpha 1"]);
  });

  it("lists chats with activity and the exact get_chat_activity arguments", async () => {
    const { begin } = setup({
      "https://substack.com/api/v1/messages/inbox?tab=all": authed({
        threads: [{ type: "chat", id: "chat-77", title: "Nate", timestamp: "2026-10-01T10:00:00Z", publication: { id: 77, name: "Nate's Substack" } }],
      }),
      "https://substack.com/api/v1/community/publications/77/posts": authed({
        threads: [{ communityPost: { id: "t1", created_at: "2026-09-20T00:00:00Z", most_recent_comment_created_at: "2026-10-02T00:49:00Z", comment_count: 4 } }],
        moreBefore: false,
      }),
    });
    await writeState({ last_run: LAST, reported_posts: [] });
    const { run, text } = await begin();
    expect(run.chats).toEqual([{ ref: "C1", id: "77", kind: "publication_chat", name: "Nate's Substack", newThreads: 0, repliedThreads: 1 }]);
    expect(text).toContain(`C1 | 77 | Nate's Substack | 0 new threads, 1 thread with new replies | {"since":"${LAST}","chat_id":"77","transcripts":true}`);
  });

  it("includes interests.md", async () => {
    await writeFile(join(dir, "interests.md"), "AI research, economics");
    const { begin } = setup({});
    const { text } = await begin();
    expect(text).toContain("INTERESTS (from interests.md):\nAI research, economics");
  });

  it("fails with an auth error before touching anything", async () => {
    const { fetch } = fakeFetch({ "https://substack.com/api/v1/user/profile/self": { status: 401 } });
    const client = new SubstackClient(new SubstackHttp({ sid: "s%3Astale", fetch, sleep: async () => {} }));
    await expect(digestBegin({ dir, client, timezone: "UTC", now: () => NOW })).rejects.toBeInstanceOf(AuthError);
    expect(await readdir(dir)).toEqual([]);
  });

  it("continues an unfinished run that is under 90 minutes old, without fetching or running a new one", async () => {
    await writeFile(join(dir, "interests.md"), "AI research, economics");
    const { begin, requests } = setup({ [archive("alpha")]: { body: [p("alpha", 1, "2026-10-02T09:00:00Z")] } });
    const first = await begin();
    const fetched = requests.length;
    const before = await readFile(join(dir, "current_run.json"), "utf8");
    const second = await begin();
    expect(second.run.run_id).toBe(first.run.run_id);
    expect(requests.length).toBe(fetched);
    expect(await readFile(join(dir, "current_run.json"), "utf8")).toBe(before);
    expect(second.text).toContain(`Continuing the open digest run ${first.run.run_id}`);
    expect(second.text).toContain(`RUN_ID: ${first.run.run_id}`);
    expect(second.text).toContain("P1 | alpha 1 | Alpha");
    expect(second.text).toContain("INTERESTS (from interests.md):\nAI research, economics");
    // a subagent that lands here isn't invited to finish the digest
    expect(second.text).not.toContain("NEXT:");
    expect(second.text).not.toContain("never finished");
    expect(first.text).toContain("NEXT:");
  });

  it("replaces an unfinished run that is 90 minutes old or more, and says so", async () => {
    const { begin } = setup({});
    const first = await begin();
    const later = NOW + 90 * 60_000;
    const { fetch } = fakeFetch({
      "https://substack.com/api/v1/user/profile/self": authed(PROFILE),
      "https://substack.com/api/v1/messages/inbox?tab=all": authed({ threads: [] }),
      [archive("alpha")]: { body: [] },
      [archive("beta")]: { body: [] },
      [archive("gone")]: { status: 404 },
    } as never);
    const client = new SubstackClient(new SubstackHttp({ sid: SID, fetch, sleep: async () => {} }));
    const second = await digestBegin({ dir, client, timezone: "America/Denver", now: () => later }, {});
    expect(second.run.run_id).not.toBe(first.run.run_id);
    expect(second.text).toContain(`Run ${first.run.run_id} (started 2026-10-02T12:00:24Z) never finished`);
  });

  it("starts a fresh run once the last one was finished, and ignores an unreadable leftover", async () => {
    const { begin } = setup({});
    await begin();
    await writeFile(join(dir, "current_run.json"), "{not json");
    const again = await begin();
    expect(again.text).not.toContain("Continuing");
    expect((await runFile()).run_id).toBe(again.run.run_id);
  });
});
