import { normalizePostUrl } from "../substack/api.js";
import { formatDay, formatLocal } from "../time.js";
import type { RunChat, RunFile, RunPost } from "./collect.js";
import type { DigestState } from "./state.js";

export { formatLocal };

// Pure functions: turn the model's judgments into the final message.

export interface PostJudgment {
  ref?: string;
  url?: string;
  section?: string;
  gist?: string;
  why?: string;
  preview_only?: boolean | string;
  error?: string;
}

export interface ChatJudgment {
  id?: string;
  ref?: string;
  topics?: string;
  for_user?: string;
}

export type Section = "pick" | "other" | "unreadable";

export interface PostEntry {
  post: RunPost;
  section: Section;
  gist?: string;
  why?: string;
  previewOnly: boolean;
  error?: string;
}

export interface ChatEntry {
  chat: RunChat;
  topics?: string;
  forUser?: string;
}

export interface Reconciled {
  picks: PostEntry[];
  others: PostEntry[];
  unreadable: PostEntry[];
  /** Posts the model didn't return an entry for (excluding the two lists below). */
  missing: RunPost[];
  /** Skipped by the classifier, with no entry: counted in the 🗑 line. */
  skipped: RunPost[];
  /** Ranked below the floor, with no entry: listed under "Also new". */
  unread: RunPost[];
  chats: ChatEntry[];
  /** Chats the model didn't return an entry for. */
  missingChats: RunChat[];
  warnings: string[];
}

const RANK: Record<Section, number> = { pick: 3, other: 2, unreadable: 1 };

/**
 * Match the model's entries to the run. Lenient on purpose: refs are
 * case-insensitive ("p3", "3" or the URL), duplicates resolve to the strongest
 * section (pick > other > unreadable), unknown refs are dropped, and posts with no
 * entry are listed as not summarized. Each correction adds a warning.
 */
export function reconcile(run: RunFile, posts: PostJudgment[], chats: ChatJudgment[]): Reconciled {
  const warnings: string[] = [];
  const byRef = new Map(run.posts.map((p) => [p.ref.toUpperCase(), p]));
  const byUrl = new Map(run.posts.map((p) => [normalizePostUrl(p.url), p]));
  const chosen = new Map<RunPost, { entry: PostEntry; order: number }>();

  posts.forEach((j, order) => {
    const post = findPost(j, byRef, byUrl);
    if (!post) {
      warnings.push(`Ignored an entry for an unknown post (${j.ref ?? j.url ?? "no ref"}).`);
      return;
    }
    const entry = toEntry(post, j, warnings);
    const prev = chosen.get(post);
    if (prev) {
      if (RANK[entry.section] > RANK[prev.entry.section]) chosen.set(post, { entry: merge(entry, prev.entry), order });
      else chosen.set(post, { entry: merge(prev.entry, entry), order: prev.order });
      warnings.push(`${post.ref} was listed more than once; kept it as ${chosen.get(post)!.entry.section}.`);
      return;
    }
    chosen.set(post, { entry, order });
  });

  const ordered = [...chosen.values()].sort((a, b) => a.order - b.order).map((c) => c.entry);
  const skipped = run.posts.filter((p) => !chosen.has(p) && p.skipped);
  const unread = run.posts.filter((p) => !chosen.has(p) && p.low && !p.skipped);
  const missing = run.posts.filter((p) => !chosen.has(p) && !p.skipped && !p.low);
  if (missing.length) {
    warnings.push(`${missing.length} post${missing.length === 1 ? " has" : "s have"} no entry (${missing.map((p) => p.ref).join(", ")}); listed under "Couldn't read" as not summarized.`);
  }

  const chatEntries = new Map<RunChat, ChatEntry>();
  for (const j of chats) {
    const chat = findChat(j, run.chats);
    if (!chat) {
      warnings.push(`Ignored an entry for an unknown chat (${j.id ?? j.ref ?? "no id"}).`);
      continue;
    }
    if (chatEntries.has(chat)) warnings.push(`Chat ${chat.name} was listed more than once; kept the last entry.`);
    const forUser = clip(j.for_user, 300);
    chatEntries.set(chat, { chat, topics: clip(j.topics, 500), forUser: forUser && !/^(none|no|n\/a|nothing|-)\.?$/i.test(forUser) ? forUser : undefined });
  }
  const missingChats = run.chats.filter((c) => !chatEntries.has(c));
  if (missingChats.length) warnings.push(`${missingChats.length} chat${missingChats.length === 1 ? " has" : "s have"} no entry (${missingChats.map((c) => c.name).join(", ")}).`);

  return {
    picks: ordered.filter((e) => e.section === "pick"),
    others: ordered.filter((e) => e.section === "other"),
    unreadable: ordered.filter((e) => e.section === "unreadable"),
    missing,
    skipped,
    unread,
    chats: run.chats.filter((c) => chatEntries.has(c)).map((c) => chatEntries.get(c)!),
    missingChats,
    warnings,
  };
}

function findPost(j: PostJudgment, byRef: Map<string, RunPost>, byUrl: Map<string, RunPost>): RunPost | undefined {
  for (const value of [j.ref, j.url]) {
    const v = value?.trim();
    if (!v) continue;
    if (/^https?:\/\//i.test(v)) {
      const hit = byUrl.get(normalizePostUrl(v));
      if (hit) return hit;
      continue;
    }
    const ref = /^\d+$/.test(v) ? `P${v}` : v.toUpperCase().replace(/^P\s*/, "P");
    const hit = byRef.get(ref);
    if (hit) return hit;
  }
  return undefined;
}

function findChat(j: ChatJudgment, chats: RunChat[]): RunChat | undefined {
  const values = [j.id, j.ref].map((v) => v?.trim().toLowerCase().replace(/^direct-message-/, "")).filter((v): v is string => Boolean(v));
  return chats.find((c) => values.some((v) => v === c.id.toLowerCase() || v === c.ref.toLowerCase() || v === c.name.toLowerCase()));
}

function toEntry(post: RunPost, j: PostJudgment, warnings: string[]): PostEntry {
  const raw = (j.section ?? "").trim().toLowerCase();
  let section: Section;
  if (["pick", "picks", "read in full", "read", "star", "top"].includes(raw)) section = "pick";
  else if (["other", "others", "everything else", "rest"].includes(raw)) section = "other";
  else if (["unreadable", "error", "failed", "couldn't read", "could not read"].includes(raw)) section = "unreadable";
  else {
    section = j.error ? "unreadable" : "other";
    warnings.push(`${post.ref} had section "${j.section ?? ""}"; treated it as ${section}.`);
  }
  const previewOnly = j.preview_only === true || (typeof j.preview_only === "string" && /^(true|yes|1)$/i.test(j.preview_only.trim()));
  return {
    post,
    section,
    gist: clip(j.gist, 500),
    why: clip(j.why, 300),
    previewOnly,
    error: section === "unreadable" ? (clip(j.error, 150) ?? "couldn't read") : undefined,
  };
}

/** Keep `primary`, filling empty fields from `other`. */
function merge(primary: PostEntry, other: PostEntry): PostEntry {
  return { ...primary, gist: primary.gist ?? other.gist, why: primary.why ?? other.why, previewOnly: primary.previewOnly || other.previewOnly };
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---- the message ----

const MESSAGE_MAX = 38_000;

export interface RenderOptions {
  /** false: plain text, no Discord bold/italics. */
  markdown?: boolean;
}

/** The final digest message, or exactly "[SILENT]" when there is nothing to say. */
export function renderDigest(run: RunFile, rec: Reconciled, { markdown = true }: RenderOptions = {}): string {
  const b = (s: string) => (markdown ? `**${s}**` : s);
  const i = (s: string) => (markdown ? `_${s}_` : s);
  const tz = run.timezone;
  const notChecked = run.publications.filter((p) => (p.outcome === "failed" || p.outcome === "overflow") && !run.give_ups.some((g) => g.id === p.id));
  const nPosts = run.posts.length;
  const nChats = run.chats.length;

  if (nPosts === 0 && nChats === 0 && notChecked.length === 0 && run.give_ups.length === 0) return "[SILENT]";

  const out: string[] = [
    `📬 ${b("Substack")} — ${nPosts} new post${nPosts === 1 ? "" : "s"}, ${nChats} chat${nChats === 1 ? "" : "s"} with new activity (since ${formatLocal(run.since, tz)})`,
  ];
  const marks = (e: PostEntry) => `${e.post.paywalled ? " [paid]" : ""}${e.previewOnly ? " (preview only)" : ""}`;

  if (nPosts > 0) {
    out.push("", `⭐ ${b("Read in full")}`);
    if (rec.picks.length === 0) out.push(i("Nothing stood out this time."));
    rec.picks.forEach((e, n) => {
      out.push(`${n + 1}. ${b(e.post.title)} — ${e.post.publication}${marks(e)}`);
      if (e.gist) out.push(`   ${e.gist}`);
      if (e.why) out.push(`   ${i("Why:")} ${e.why}`);
      out.push(`   ${e.post.url}`);
    });
  }

  if (rec.others.length) {
    out.push("", `📰 ${b("Everything else")}`);
    const groups = new Map<string, PostEntry[]>();
    for (const e of rec.others) groups.set(e.post.publication, [...(groups.get(e.post.publication) ?? []), e]);
    const names = [...groups.keys()].sort((x, y) => x.localeCompare(y, "en", { sensitivity: "base" }));
    for (const name of names) {
      out.push(b(name));
      const entries = groups.get(name)!.sort((x, y) => timeOf(y.post.date) - timeOf(x.post.date));
      for (const e of entries) out.push(`• ${e.post.title}${marks(e)}${e.gist ? ` — ${e.gist}` : ""} ${e.post.url}`);
    }
  }

  if (rec.unread.length) {
    out.push("", `📎 ${b("Also new")} ${i("(ranked low, not read)")}`);
    for (const p of rec.unread) out.push(`• ${p.title} — ${p.publication}${p.paywalled ? " [paid]" : ""} ${p.url}`);
  }

  if (nChats > 0) {
    out.push("", `💬 ${b("Chats")}`);
    const forUser = rec.chats.filter((c) => c.forUser);
    const rest = rec.chats.filter((c) => !c.forUser);
    for (const c of [...forUser, ...rest]) out.push(`• ${c.chat.name}: ${c.topics ?? "new activity"}${c.forUser ? ` ← ${i(c.forUser)}` : ""}`);
    for (const c of rec.missingChats) out.push(`• ${c.name}: new activity (not summarized)`);
  }

  if (rec.unreadable.length || rec.missing.length) {
    out.push("", `⚠ ${b("Couldn't read")}`);
    for (const e of rec.unreadable) out.push(`• ${e.post.title} — ${e.post.publication} (${e.error}) ${e.post.url}`);
    for (const p of rec.missing) out.push(`• ${p.title} — ${p.publication} (not summarized) ${p.url}`);
  }

  if (notChecked.length || run.give_ups.length) {
    out.push("", `⚠ ${b("Couldn't check")}`);
    for (const p of notChecked) {
      out.push(
        p.outcome === "overflow"
          ? `• ${p.name} (too many new posts) — the rest come next time, from ${formatDay(p.since ?? run.since, tz)}`
          : `• ${p.name} (${p.error ?? "error"}) — retrying from ${formatDay(p.since ?? run.since, tz)}`,
      );
    }
    for (const g of run.give_ups) out.push(`• Giving up on ${g.name} posts from ${dayRange(g.from, g.to, tz)} (${g.error ?? "error"})`);
  }

  if (rec.skipped.length) {
    const pubs = new Map<string, number>();
    for (const p of rec.skipped) pubs.set(p.publication, (pubs.get(p.publication) ?? 0) + 1);
    const mostly = [...pubs].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).map(([name]) => name);
    out.push("", `🗑 Skipped ${rec.skipped.length} by the classifier${mostly.length ? ` (mostly ${mostly.slice(0, 3).join(", ")})` : ""}`);
  }

  let text = out.join("\n");
  if (text.length > MESSAGE_MAX) text = `${text.slice(0, MESSAGE_MAX)}\n… (digest truncated)`;
  return text;
}

function dayRange(from: string, to: string, tz: string): string {
  const a = formatDay(from, tz);
  const z = formatDay(to, tz);
  return a === z ? a : `${a}–${z}`;
}

function timeOf(date?: string): number {
  const t = date ? Date.parse(date) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// ---- status ----

export function renderStatus(
  dir: string,
  state: DigestState,
  info: { exists: boolean; corrupt?: boolean; current: RunFile | null; previous: (RunFile & { committed_at?: string }) | null; timezone: string },
): string {
  const tz = info.timezone;
  const lines = [
    `DIGEST DIR: ${dir}`,
    `TIME ZONE: ${tz}`,
    `STATE FILE: ${info.exists ? (info.corrupt ? "unreadable (will be backed up and replaced on the next save)" : "ok") : "missing (the next run is a first run)"}`,
    `LAST RUN: ${state.last_run ? `${state.last_run} (${formatLocal(state.last_run, tz)})` : "never"}`,
    `REPORTED POSTS: ${state.reported_posts.length} (newest 500 kept)`,
  ];
  const pending = Object.entries(state.pending_publications);
  lines.push(`PENDING PUBLICATIONS: ${pending.length}`);
  for (const [id, p] of pending) lines.push(`- ${p.name} (id ${id}): retry from ${p.since}, ${p.error ?? "error"}, ${p.failures} failed run${p.failures === 1 ? "" : "s"}`);
  const c = info.current;
  lines.push(
    c
      ? `CURRENT RUN (begun, not finished): ${c.run_id}, started ${c.fetch_start}, ${c.posts.length} posts, ${c.chats.length} chats`
      : "CURRENT RUN: none",
  );
  const p = info.previous;
  lines.push(p ? `PREVIOUS RUN: ${p.run_id}, started ${p.fetch_start}, committed ${p.committed_at ?? "?"}, ${p.posts.length} posts, ${p.chats.length} chats` : "PREVIOUS RUN: none");
  const runs = state.runs ?? [];
  if (runs.length) {
    lines.push("RECENT RUNS (run id | started | committed | posts | chats):");
    for (const r of runs.slice(-5).reverse()) lines.push(`- ${r.run_id} | ${r.fetch_start} | ${r.committed_at} | ${r.posts} | ${r.chats}`);
  }
  return lines.join("\n");
}
