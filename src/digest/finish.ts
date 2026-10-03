import { isoSeconds } from "../time.js";
import type { RunFile, RunPost } from "./collect.js";
import { reconcile, renderDigest, renderStatus, type ChatJudgment, type PostJudgment, type Reconciled } from "./render.js";
import {
  addReported,
  archiveRun,
  atomicWrite,
  FILES,
  laterOf,
  loadState,
  readDigestFile,
  removeDigestFile,
  serializeState,
  withLock,
  type DigestState,
} from "./state.js";

export const DIGEST_MARKER = "===== DIGEST: reply with exactly the text below, nothing before or after =====";
const STATE_NOT_SAVED = "⚠ state not saved; the next digest may repeat posts";
const MAX_RUN_HISTORY = 10;

export interface FinishArgs {
  runId: string;
  posts: PostJudgment[];
  chats: ChatJudgment[];
  render?: boolean;
  dryRun?: boolean;
}

export interface ToolText {
  text: string;
  isError?: boolean;
}

interface PreviousRun extends RunFile {
  committed_at?: string;
  result?: string;
}

/** Apply a finished run to the state: pure, so it can be tested on its own. */
export function applyRun(state: DigestState, run: RunFile, committedAt: string): DigestState {
  const pending = { ...state.pending_publications };
  const givenUp = new Set(run.give_ups.map((g) => g.id));
  for (const p of run.publications) {
    if (p.outcome === "ok" || p.outcome === "unsubscribed" || givenUp.has(p.id)) {
      delete pending[p.id];
      continue;
    }
    const existing = pending[p.id];
    const since = p.since ?? run.since;
    pending[p.id] = {
      name: p.name,
      since: existing && Date.parse(existing.since) < Date.parse(since) ? existing.since : since,
      error: p.error,
      failures: (existing?.failures ?? 0) + 1,
    };
  }
  const runs = [...(state.runs ?? []), { run_id: run.run_id, fetch_start: run.fetch_start, committed_at: committedAt, posts: run.posts.length, chats: run.chats.length }].slice(-MAX_RUN_HISTORY);
  return {
    ...state,
    version: 2,
    last_run: laterOf(state.last_run, run.fetch_start),
    pending_publications: pending,
    runs,
    // Every post in the work list counts as reported, including ones that couldn't be read.
    reported_posts: addReported(state.reported_posts, run.posts.map((p) => p.url)).list,
  };
}

async function readRun(dir: string, name: string): Promise<PreviousRun | null> {
  const raw = await readDigestFile(dir, name);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PreviousRun;
  } catch {
    return null;
  }
}

const sameId = (a: string | undefined, b: string) => a !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

const POST_REF = /^P\d+$/i;

export function isPostRef(s: string): boolean {
  return POST_REF.test(s.trim());
}

/**
 * Resolve a post ref such as "P3" for read_post, against the run in progress (or the
 * last committed one). Subagents read by ref, so a ref the main model renumbers still
 * fetches the post that ref names, and its gist can't land under another title.
 */
export async function resolvePostRef(dir: string, ref: string): Promise<RunPost> {
  const want = ref.trim().toUpperCase();
  const run = (await readRun(dir, FILES.currentRun)) ?? (await readRun(dir, FILES.previousRun));
  if (!run) throw new Error(`"${want}" looks like a digest ref, but there is no digest run. Call digest_begin first, or pass the post URL.`);
  const post = run.posts.find((p) => p.ref.toUpperCase() === want);
  if (!post) {
    const range = run.posts.length ? `P1–P${run.posts.length}` : "none";
    throw new Error(`${want} isn't in digest run ${run.run_id}; its post refs are ${range}.`);
  }
  return post;
}

export async function digestFinish(dir: string, args: FinishArgs, { now = Date.now }: { now?: () => number } = {}): Promise<ToolText> {
  const work = async (): Promise<ToolText> => {
    const current = await readRun(dir, FILES.currentRun);
    if (!current || !sameId(current.run_id, args.runId)) {
      const previous = await readRun(dir, FILES.previousRun);
      if (previous && sameId(previous.run_id, args.runId) && previous.result) {
        return { text: `ALREADY COMMITTED: run ${previous.run_id} was saved at ${previous.committed_at ?? "?"}; nothing was changed. Its result is repeated below.\n${previous.result}` };
      }
      return {
        isError: true,
        text: current
          ? `Unknown run_id "${args.runId}". The run in progress is "${current.run_id}". Use that run_id, or call digest_begin again.`
          : `Unknown run_id "${args.runId}" and no run is in progress. Call digest_begin again.`,
      };
    }

    const loaded = await loadState(dir);
    if (loaded.state.runs?.some((r) => sameId(r.run_id, current.run_id))) {
      return { text: `ALREADY COMMITTED: run ${current.run_id} is already in state.json; nothing was changed.` };
    }
    if ((loaded.state.last_run ?? null) !== current.state_last_run_at_begin) {
      return {
        isError: true,
        text: `state.json changed after digest_begin (last_run was ${current.state_last_run_at_begin ?? "unset"}, now ${loaded.state.last_run ?? "unset"}), so another run saved in between. Nothing was saved. Call digest_begin again.`,
      };
    }

    const rec = reconcile(current, args.posts, args.chats);
    const markdown = args.render ?? true;
    let message = renderDigest(current, rec, { markdown });
    const warnings = [...rec.warnings];

    if (args.dryRun) {
      return { text: compose("DRY RUN: nothing saved", current, rec, warnings, message, markdown) };
    }

    const committedAt = isoSeconds(now());
    const next = applyRun(loaded.state, current, committedAt);
    let saved: string;
    try {
      if (loaded.corrupt !== undefined) {
        await atomicWrite(dir, `state.json.corrupt-${committedAt.replace(/[-:]/g, "")}`, loaded.corrupt);
      }
      await atomicWrite(dir, FILES.state, serializeState(next)).catch(() => atomicWrite(dir, FILES.state, serializeState(next)));
      const pending = Object.keys(next.pending_publications).length;
      saved = `STATE SAVED: yes (last_run ${next.last_run}; ${next.reported_posts.length} reported posts; ${pending} publication${pending === 1 ? "" : "s"} pending)`;
    } catch (err) {
      saved = `STATE SAVED: NO (${err instanceof Error ? err.message : String(err)})`;
      warnings.push("state.json couldn't be written; the run file is kept, so digest_finish can be retried.");
      message = message === "[SILENT]" ? STATE_NOT_SAVED : `${message}\n\n${STATE_NOT_SAVED}`;
      return { text: compose(saved, current, rec, warnings, message, markdown) };
    }

    const text = compose(saved, current, rec, warnings, message, markdown);
    try {
      const record: PreviousRun = { ...current, committed_at: committedAt, result: text };
      await atomicWrite(dir, FILES.previousRun, JSON.stringify(record, null, 2) + "\n");
      await removeDigestFile(dir, FILES.currentRun);
    } catch {
      // State is saved; runs[] in state.json still makes a repeat call harmless.
    }
    try {
      const judged = { picks: rec.picks.map((e) => e.post.ref), others: rec.others.map((e) => e.post.ref) };
      await archiveRun(dir, current.run_id, JSON.stringify({ ...current, committed_at: committedAt, judged }, null, 2) + "\n");
    } catch {
      // Only history for the classifier tools; never fails a run.
    }
    return { text };
  };
  return args.dryRun ? work() : withLock(dir, work);
}

function compose(saved: string, run: RunFile, rec: Reconciled, warnings: string[], message: string, markdown: boolean): string {
  const notChecked = run.publications.filter((p) => p.outcome === "failed" || p.outcome === "overflow").length;
  const counts =
    `COUNTS: ${run.posts.length} posts (${rec.picks.length} picks, ${rec.others.length} other, ${rec.unreadable.length} couldn't read, ${rec.missing.length} not summarized` +
    `${rec.skipped.length ? `, ${rec.skipped.length} skipped` : ""}${rec.unread.length ? `, ${rec.unread.length} ranked low and unread` : ""}), ` +
    `${run.chats.length} chats, ${notChecked} publications not checked, ${run.give_ups.length} given up`;
  const warn = warnings.length ? `WARNINGS:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "WARNINGS: none";
  const marker = markdown ? DIGEST_MARKER : "===== SECTIONS (plain text) =====";
  return [saved, counts, warn, marker, message].join("\n");
}

export async function digestStatus(dir: string, timezone: string): Promise<string> {
  const loaded = await loadState(dir);
  const current = await readRun(dir, FILES.currentRun).catch(() => null);
  const previous = await readRun(dir, FILES.previousRun).catch(() => null);
  return renderStatus(dir, loaded.state, { exists: loaded.exists, corrupt: loaded.corrupt !== undefined, current, previous, timezone });
}

/** Manual repair: add URLs to reported_posts and optionally set last_run. Idempotent. */
export async function markReported(dir: string, { urls, lastRun }: { urls: string[]; lastRun?: string }, { now = Date.now }: { now?: () => number } = {}): Promise<ToolText> {
  let newLastRun: string | undefined;
  if (lastRun !== undefined) {
    const t = Date.parse(lastRun);
    if (Number.isNaN(t)) return { isError: true, text: `last_run "${lastRun}" isn't a date. Use an ISO time like 2026-10-02T12:00:00Z.` };
    newLastRun = isoSeconds(t);
  }
  const bad = urls.filter((u) => !/^https?:\/\/\S+$/i.test(u.trim()));
  return withLock(dir, async () => {
    const loaded = await loadState(dir);
    const { list, added } = addReported(loaded.state.reported_posts, urls.filter((u) => !bad.includes(u)));
    const next: DigestState = { ...loaded.state, reported_posts: list };
    const before = loaded.state.last_run;
    if (newLastRun) next.last_run = newLastRun;
    if (added === 0 && (!newLastRun || newLastRun === before) && loaded.exists && loaded.corrupt === undefined) {
      return { text: `NOTHING CHANGED: all ${urls.length - bad.length} URLs were already reported.${bad.length ? ` Skipped ${bad.length} entries that aren't URLs.` : ""}` };
    }
    if (loaded.corrupt !== undefined) {
      await atomicWrite(dir, `state.json.corrupt-${isoSeconds(now()).replace(/[-:]/g, "")}`, loaded.corrupt);
    }
    await atomicWrite(dir, FILES.state, serializeState(next));
    return {
      text: [
        `MARKED: ${added} added, ${urls.length - bad.length - added} already reported${bad.length ? `, ${bad.length} skipped (not URLs)` : ""}. reported_posts now has ${list.length}.`,
        newLastRun ? `LAST_RUN: ${before ?? "unset"} -> ${newLastRun}` : `LAST_RUN: unchanged (${before ?? "unset"})`,
      ].join("\n"),
    };
  });
}
