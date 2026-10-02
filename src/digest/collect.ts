import { randomBytes } from "node:crypto";
import { normalizePostUrl, type PostSummary, type SubstackClient, type Subscription } from "../substack/api.js";
import { SubstackChat, type ChatActivity } from "../substack/chat.js";
import { AuthError } from "../substack/http.js";
import { formatDay, formatLocal, formatShort, isoSeconds, parseSince } from "../time.js";
import { atomicWrite, FILES, GIVE_UP_MS, loadState, readDigestFile, withLock } from "./state.js";

// digest_begin: everything deterministic before the model reads anything. Fetch,
// page, retry, dedup against what was already reported, and write the work list to
// current_run.json. state.json is not touched until digest_finish.

export interface RunPost {
  ref: string;
  url: string;
  title: string;
  publication: string;
  publicationId: number;
  date?: string;
  paywalled: boolean;
  type?: string;
}

export interface RunChat {
  ref: string;
  id: string;
  kind: ChatActivity["kind"];
  name: string;
  newThreads: number;
  repliedThreads: number;
}

export interface RunPublication {
  id: string;
  name: string;
  /** ok: checked. failed: not checked. overflow: checked, but some posts didn't fit in max_posts. unsubscribed: was pending, no longer subscribed. */
  outcome: "ok" | "failed" | "overflow" | "unsubscribed";
  /** Cutoff used for this publication. */
  since?: string;
  /** The cutoff came from an earlier run that couldn't check it. */
  carried?: boolean;
  error?: string;
}

export interface GiveUp {
  id: string;
  name: string;
  from: string;
  to: string;
  error?: string;
}

export interface RunFile {
  version: 1;
  run_id: string;
  /** Server clock when fetching started; becomes last_run on commit. */
  fetch_start: string;
  /** Start of the period covered (previous last_run, or the first-run lookback). */
  since: string;
  /** state.json's last_run when the run began; digest_finish refuses to commit if it changed. */
  state_last_run_at_begin: string | null;
  first_run: boolean;
  timezone: string;
  posts: RunPost[];
  chats: RunChat[];
  chat_since?: string;
  publications: RunPublication[];
  give_ups: GiveUp[];
  max_posts: number;
  /** Posts that didn't fit in max_posts; their publications are carried. */
  overflow_posts: number;
  warnings: string[];
}

export interface BeginOptions {
  maxPosts?: number;
  includeChats?: boolean;
  firstRunLookback?: string;
}

export interface BeginDeps {
  dir: string;
  client: SubstackClient;
  timezone: string;
  /** Warnings from configuration (e.g. an invalid time zone). */
  configWarnings?: string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Time allowed for fetching posts (default 140 s, leaving room for chats in Hermes's 300 s tool timeout). */
  budgetMs?: number;
}

const INTERESTS_MAX = 4000;
const OUTPUT_MAX = 40_000;

export async function digestBegin(deps: BeginDeps, opts: BeginOptions = {}): Promise<{ text: string; run: RunFile }> {
  const now = deps.now ?? Date.now;
  const maxPosts = Math.min(200, Math.max(1, Math.trunc(opts.maxPosts ?? 100)));
  const warnings = [...(deps.configWarnings ?? [])];

  // Fails with AuthError (reported as an auth problem) before anything else happens.
  await deps.client.whoami();

  const loaded = await loadState(deps.dir);
  warnings.push(...loaded.warnings);
  const state = loaded.state;
  const fetchStart = now();
  const fetchStartIso = isoSeconds(fetchStart);
  const lookback = parseSince(opts.firstRunLookback ?? "48h", fetchStart) ?? new Date(fetchStart - 48 * 3_600_000);
  const since = state.last_run ? new Date(state.last_run) : lookback;
  const sinceIso = isoSeconds(since);

  const subs = await deps.client.subscriptions({ refresh: true });
  const subIds = new Set(subs.map((s) => String(s.publicationId)));
  const cutoffFor = (sub: Subscription): Date => {
    const pending = state.pending_publications[String(sub.publicationId)];
    const t = pending ? Date.parse(pending.since) : NaN;
    return Number.isNaN(t) ? since : new Date(Math.min(t, since.getTime()));
  };

  const results = await deps.client.postsSince(subs, cutoffFor, {
    pageSize: 20,
    maxPages: 5,
    concurrency: 3,
    sleep: deps.sleep,
    now,
    budgetMs: deps.budgetMs,
  });

  // Drop what was already reported, and cross-posts that show up twice.
  const reported = new Set(state.reported_posts.map(normalizePostUrl));
  const seen = new Set<string>();
  const candidates: Array<{ post: PostSummary; sub: Subscription }> = [];
  for (const r of results) {
    if (r.truncated) warnings.push(`${r.sub.name} had more than 100 new posts; only the newest 100 were checked.`);
    for (const post of r.posts) {
      if (!post.url) continue;
      const key = normalizePostUrl(post.url);
      if (reported.has(key) || seen.has(key)) continue;
      seen.add(key);
      candidates.push({ post, sub: r.sub });
    }
  }
  candidates.sort((a, b) => timeOf(b.post.date) - timeOf(a.post.date));
  const kept = candidates.slice(0, maxPosts);
  const dropped = candidates.slice(maxPosts);
  const overflowIds = new Set(dropped.map((c) => String(c.sub.publicationId)));

  const posts: RunPost[] = kept.map(({ post, sub }, i) => ({
    ref: `P${i + 1}`,
    url: post.url!,
    title: post.title,
    publication: sub.name,
    publicationId: sub.publicationId,
    date: post.date,
    paywalled: post.paywalled,
    type: post.type,
  }));

  const publications: RunPublication[] = results.map((r) => {
    const id = String(r.sub.publicationId);
    const carried = Boolean(state.pending_publications[id]);
    const base = { id, name: r.sub.name, since: r.since ? isoSeconds(r.since) : sinceIso, carried: carried || undefined };
    if (r.status === "failed") return { ...base, outcome: "failed", error: r.error };
    if (overflowIds.has(id)) return { ...base, outcome: "overflow", error: `more than ${maxPosts} new posts in this run` };
    return { ...base, outcome: "ok" };
  });
  for (const [id, p] of Object.entries(state.pending_publications)) {
    if (!subIds.has(id)) {
      publications.push({ id, name: p.name, outcome: "unsubscribed", since: p.since, carried: true });
      warnings.push(`${p.name} was waiting to be re-checked but is no longer a subscription; dropping it.`);
    }
  }

  const giveUps: GiveUp[] = publications
    .filter((p) => (p.outcome === "failed" || p.outcome === "overflow") && p.since && fetchStart - Date.parse(p.since) > GIVE_UP_MS)
    .map((p) => ({ id: p.id, name: p.name, from: p.since!, to: fetchStartIso, error: p.error }));

  // Chats: activity since the previous run.
  let chats: RunChat[] = [];
  if (opts.includeChats ?? true) {
    try {
      const activity = await new SubstackChat(deps.client).activity(since);
      chats = activity.chats.map((c, i) => ({
        ref: `C${i + 1}`,
        id: c.id,
        kind: c.kind,
        name: c.name,
        newThreads: c.threads.filter((t) => t.status === "new_thread").length,
        repliedThreads: c.threads.filter((t) => t.status === "new_replies").length,
      }));
      for (const e of activity.errors) {
        if (!/no chat/.test(e.error)) warnings.push(`Couldn't check the chat for ${e.name}: ${e.error}`);
      }
    } catch (err) {
      if (err instanceof AuthError) throw err;
      warnings.push(`Couldn't check chats: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let interests = "";
  try {
    interests = (await readDigestFile(deps.dir, FILES.interests))?.trim() ?? "";
    if (interests.length > INTERESTS_MAX) {
      interests = interests.slice(0, INTERESTS_MAX) + "\n[interests.md truncated]";
      warnings.push(`interests.md is longer than ${INTERESTS_MAX} characters; only the start is used.`);
    }
  } catch (err) {
    warnings.push(`Couldn't read interests.md: ${err instanceof Error ? err.message : String(err)}`);
  }

  const run: RunFile = {
    version: 1,
    run_id: newRunId(fetchStart),
    fetch_start: fetchStartIso,
    since: sinceIso,
    state_last_run_at_begin: state.last_run ?? null,
    first_run: !state.last_run,
    timezone: deps.timezone,
    posts,
    chats,
    chat_since: chats.length ? sinceIso : undefined,
    publications,
    give_ups: giveUps,
    max_posts: maxPosts,
    overflow_posts: dropped.length,
    warnings,
  };

  await withLock(deps.dir, async () => {
    const previous = await readDigestFile(deps.dir, FILES.currentRun).catch(() => null);
    if (previous) {
      try {
        const old = JSON.parse(previous) as RunFile;
        warnings.push(`Run ${old.run_id} (started ${old.fetch_start}) never finished; it was replaced and nothing from it was saved.`);
      } catch {
        // An unreadable leftover run file is simply replaced.
      }
    }
    await atomicWrite(deps.dir, FILES.currentRun, JSON.stringify(run, null, 2) + "\n");
  });

  return { text: renderBegin(run, interests), run };
}

export function newRunId(at: number): string {
  return `${isoSeconds(at).replace(/[-:]/g, "").replace("T", "-").replace("Z", "")}-${randomBytes(2).toString("hex")}`;
}

/** Plain-text view of a run for the model. */
export function renderBegin(run: RunFile, interests: string): string {
  const tz = run.timezone;
  const failed = run.publications.filter((p) => p.outcome === "failed");
  const carriedIn = run.publications.filter((p) => p.carried && p.outcome !== "unsubscribed").length;
  const checked = run.publications.filter((p) => p.outcome === "ok" || p.outcome === "overflow").length;
  const lines: string[] = [
    `RUN_ID: ${run.run_id}`,
    `SINCE: ${run.since} (${formatLocal(run.since, tz)})${run.first_run ? " [first run]" : ""}`,
    `COUNTS: ${run.posts.length} new posts, ${run.chats.length} chats with activity, ${checked} publications checked, ${failed.length} not checked, ${carriedIn} carried over from earlier runs`,
    "",
  ];

  if (run.posts.length) {
    lines.push("POSTS (ref | title | publication | date | access | type | url):");
    const titleMax = run.posts.length > 120 ? 80 : 140;
    for (const p of run.posts) {
      lines.push(
        [p.ref, oneLine(p.title, titleMax), oneLine(p.publication, 60), p.date ? formatShort(p.date, tz) : "?", p.paywalled ? "paid" : "free", p.type ?? "newsletter", p.url].join(" | "),
      );
    }
  } else {
    lines.push("POSTS: none");
  }
  if (run.overflow_posts) {
    lines.push(`(${run.overflow_posts} more new posts didn't fit in max_posts=${run.max_posts}; they come in the next run.)`);
  }

  if (failed.length) {
    lines.push("", "NOT CHECKED (retried next run; digest_finish lists these in the digest itself):");
    for (const p of failed) lines.push(`- ${p.name}: ${p.error ?? "error"}; retrying from ${formatDay(p.since ?? run.since, tz)}`);
  }
  if (run.give_ups.length) {
    lines.push("", "GIVING UP (not checked for over 7 days; digest_finish lists these in the digest itself):");
    for (const g of run.give_ups) lines.push(`- ${g.name}: posts from ${formatDay(g.from, tz)} to ${formatDay(g.to, tz)} (${g.error ?? "error"})`);
  }

  lines.push("");
  if (run.chats.length) {
    lines.push("CHATS WITH ACTIVITY (ref | chat id | name | activity | get_chat_activity arguments):");
    for (const c of run.chats) {
      const activity = c.kind === "direct_message" ? "new messages" : `${c.newThreads} new thread${c.newThreads === 1 ? "" : "s"}, ${c.repliedThreads} thread${c.repliedThreads === 1 ? "" : "s"} with new replies`;
      lines.push([c.ref, c.id, c.name, activity, JSON.stringify({ since: run.chat_since, chat_id: c.id, transcripts: true })].join(" | "));
    }
  } else {
    lines.push("CHATS WITH ACTIVITY: none");
  }

  lines.push("", interests ? `INTERESTS (from interests.md):\n${interests}` : "INTERESTS: none (no interests.md)");
  lines.push("", run.warnings.length ? `WARNINGS:\n${run.warnings.map((w) => `- ${w}`).join("\n")}` : "WARNINGS: none");

  const range = run.posts.length ? `P1–P${run.posts.length}` : "";
  lines.push(
    "",
    run.posts.length || run.chats.length
      ? `NEXT: Read every post (${range || "none"}) and summarize every chat (${run.chats.map((c) => c.ref).join(", ") || "none"}). Then call digest_finish once with run_id "${run.run_id}", one posts entry per post ({"ref": "P1", "section": "pick" | "other" | "unreadable", "gist", "why", "preview_only"}) and one chats entry per chat ({"id": "<chat id>", "topics", "for_user"}).`
      : `NEXT: Nothing new to read. Call digest_finish with run_id "${run.run_id}", posts: [] and chats: [].`,
  );

  let text = lines.join("\n");
  if (text.length > OUTPUT_MAX) text = text.slice(0, OUTPUT_MAX - 80) + "\n[output truncated; call digest_begin with a smaller max_posts]";
  return text;
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function timeOf(date?: string): number {
  const t = date ? Date.parse(date) : NaN;
  return Number.isNaN(t) ? 0 : t;
}
