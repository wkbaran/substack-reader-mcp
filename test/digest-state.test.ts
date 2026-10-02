import { mkdtemp, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunFile, RunPublication } from "../src/digest/collect.js";
import { applyRun } from "../src/digest/finish.js";
import { addReported, atomicWrite, emptyState, LockBusyError, loadState, serializeState, withLock, type DigestState } from "../src/digest/state.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "substack-digest-"));
});

function run(extra: Partial<RunFile> = {}): RunFile {
  return {
    version: 1,
    run_id: "r1",
    fetch_start: "2026-10-02T12:00:24Z",
    since: "2026-10-01T12:00:11Z",
    state_last_run_at_begin: "2026-10-01T12:00:11Z",
    first_run: false,
    timezone: "UTC",
    posts: [],
    chats: [],
    publications: [],
    give_ups: [],
    max_posts: 100,
    overflow_posts: 0,
    warnings: [],
    ...extra,
  };
}

const post = (n: number, url = `https://a.substack.com/p/post-${n}`) => ({ ref: `P${n}`, url, title: `Post ${n}`, publication: "A", publicationId: 1, paywalled: false });
const pub = (id: string, outcome: RunPublication["outcome"], since = "2026-10-01T12:00:11Z", error?: string): RunPublication => ({ id, name: `Pub ${id}`, outcome, since, error });

describe("loadState", () => {
  it("treats a missing file as a first run", async () => {
    expect(await loadState(dir)).toEqual({ state: emptyState(), exists: false, warnings: [] });
  });

  it("migrates v1 and keeps unknown keys", async () => {
    await writeFile(join(dir, "state.json"), JSON.stringify({ last_run: "2026-10-01T12:00:11Z", note: "keep me", reported_posts: ["https://a/p/1"] }));
    const { state, exists } = await loadState(dir);
    expect(exists).toBe(true);
    expect(state).toEqual({ version: 2, last_run: "2026-10-01T12:00:11Z", note: "keep me", pending_publications: {}, reported_posts: ["https://a/p/1"] });
  });

  it("reports a corrupt file without touching it", async () => {
    await writeFile(join(dir, "state.json"), "{ nope");
    const loaded = await loadState(dir);
    expect(loaded.state).toEqual(emptyState());
    expect(loaded.corrupt).toBe("{ nope");
    expect(loaded.warnings[0]).toMatch(/couldn't be parsed/);
    expect(await readdir(dir)).toEqual(["state.json"]);
  });
});

describe("serializeState", () => {
  it("orders keys with reported_posts last, indent 2, trailing newline", () => {
    const text = serializeState({ reported_posts: ["u"], extra: 1, pending_publications: {}, last_run: "t", version: 2 } as DigestState);
    expect(Object.keys(JSON.parse(text))).toEqual(["version", "last_run", "pending_publications", "extra", "reported_posts"]);
    expect(text).toMatch(/^\{\n  "version": 2,/);
    expect(text.endsWith("]\n}\n")).toBe(true);
  });
});

describe("addReported", () => {
  it("dedups normalized URLs, keeps order, trims to the newest 500", () => {
    const { list, added } = addReported(["https://a.substack.com/p/one"], [
      "https://A.substack.com/p/one/?utm_source=x",
      "https://a.substack.com/p/two",
      "https://a.substack.com/p/two#c",
    ]);
    expect(list).toEqual(["https://a.substack.com/p/one", "https://a.substack.com/p/two"]);
    expect(added).toBe(1);

    const many = Array.from({ length: 499 }, (_, i) => `https://a/p/${i}`);
    const trimmed = addReported(many, ["https://a/p/new1", "https://a/p/new2"]).list;
    expect(trimmed).toHaveLength(500);
    expect(trimmed[0]).toBe("https://a/p/1");
    expect(trimmed.at(-1)).toBe("https://a/p/new2");
  });
});

describe("applyRun", () => {
  const base: DigestState = { version: 2, last_run: "2026-10-01T12:00:11Z", pending_publications: {}, reported_posts: ["https://a.substack.com/p/old"] };

  it("moves last_run to fetch_start and appends every work-list URL", () => {
    const next = applyRun(base, run({ posts: [post(1), post(2), post(3, "https://a.substack.com/p/old/")] }), "2026-10-02T12:10:00Z");
    expect(next.last_run).toBe("2026-10-02T12:00:24Z");
    expect(next.reported_posts).toEqual(["https://a.substack.com/p/old", "https://a.substack.com/p/post-1", "https://a.substack.com/p/post-2"]);
    expect(next.runs).toEqual([{ run_id: "r1", fetch_start: "2026-10-02T12:00:24Z", committed_at: "2026-10-02T12:10:00Z", posts: 3, chats: 0 }]);
  });

  it("never moves last_run backwards", () => {
    expect(applyRun({ ...base, last_run: "2026-10-03T00:00:00Z" }, run(), "x").last_run).toBe("2026-10-03T00:00:00Z");
  });

  it("carries failed and overflowing publications and clears ones that succeeded", () => {
    const state: DigestState = { ...base, pending_publications: { "7": { name: "Pub 7", since: "2026-09-30T00:00:00Z", error: "HTTP 429", failures: 1 }, "8": { name: "Pub 8", since: "2026-09-30T00:00:00Z", failures: 1 } } };
    const next = applyRun(
      state,
      run({ publications: [pub("7", "failed", "2026-09-30T00:00:00Z", "HTTP 429"), pub("8", "ok", "2026-09-30T00:00:00Z"), pub("9", "overflow", "2026-10-01T12:00:11Z", "more than 100 new posts in this run"), pub("10", "unsubscribed")] }),
      "x",
    );
    expect(next.pending_publications).toEqual({
      "7": { name: "Pub 7", since: "2026-09-30T00:00:00Z", error: "HTTP 429", failures: 2 },
      "9": { name: "Pub 9", since: "2026-10-01T12:00:11Z", error: "more than 100 new posts in this run", failures: 1 },
    });
  });

  it("gives up on publications listed in give_ups", () => {
    const state: DigestState = { ...base, pending_publications: { "7": { name: "Pub 7", since: "2026-09-24T00:00:00Z", error: "HTTP 429", failures: 6 } } };
    const next = applyRun(
      state,
      run({ publications: [pub("7", "failed", "2026-09-24T00:00:00Z", "HTTP 429")], give_ups: [{ id: "7", name: "Pub 7", from: "2026-09-24T00:00:00Z", to: "2026-10-02T12:00:24Z", error: "HTTP 429" }] }),
      "x",
    );
    expect(next.pending_publications).toEqual({});
  });
});

describe("atomicWrite", () => {
  it("writes 0644, keeps an existing mode, leaves no temp files", async () => {
    await atomicWrite(dir, "state.json", "one\n");
    expect((await stat(join(dir, "state.json"))).mode & 0o777).toBe(0o644);
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe("one\n");
    const { chmod } = await import("node:fs/promises");
    await chmod(join(dir, "state.json"), 0o600);
    await atomicWrite(dir, "state.json", "two\n");
    expect((await stat(join(dir, "state.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  it("refuses to write through a symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await writeFile(join(outside, "target"), "original");
    await symlink(join(outside, "target"), join(dir, "state.json"));
    await expect(atomicWrite(dir, "state.json", "evil")).rejects.toThrow(/symlink/);
    expect(await readFile(join(outside, "target"), "utf8")).toBe("original");
  });

  it("creates the digest directory when missing", async () => {
    const nested = join(dir, "sub", "digest");
    await atomicWrite(nested, "state.json", "{}\n");
    expect(await readFile(join(nested, "state.json"), "utf8")).toBe("{}\n");
  });
});

describe("withLock", () => {
  it("waits for a held lock, then reports it busy", async () => {
    await writeFile(join(dir, "state.lock"), "123");
    let clock = 0;
    await expect(withLock(dir, async () => "ran", { now: () => clock, sleep: async (ms) => void (clock += ms), waitMs: 1000 })).rejects.toBeInstanceOf(LockBusyError);
  });

  it("takes over a stale lock and releases it afterwards", async () => {
    await writeFile(join(dir, "state.lock"), "123");
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(join(dir, "state.lock"), old, old);
    expect(await withLock(dir, async () => "ran")).toBe("ran");
    expect(await readdir(dir)).toEqual([]);
  });

  it("serializes concurrent callers", async () => {
    const order: string[] = [];
    const slow = (name: string) => async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${name}:end`);
    };
    await Promise.all([withLock(dir, slow("a")), withLock(dir, slow("b"))]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });
});
