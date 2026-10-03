/**
 * Substack's evidence for drafting interests.md (src/classifier/evidence.ts renders it):
 * saved and hearted posts, paid subscriptions, posts read to the end (strong); free
 * subscriptions, posts read partway, the digest's picks (medium); posts opened and
 * abandoned (weak); posts dismissed from the inbox and hand labels (negative).
 * Read-only: nothing here changes the account, the inbox, or the digest state.
 */
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { isTrainLabel, labelSections, type Evidence, type EvidenceItem, type EvidenceSection } from "../classifier/evidence.js";
import type { PostSummary, ReaderPost, SubstackClient } from "../substack/api.js";
import { FILES, readDigestFile } from "./state.js";

export interface EvidenceOptions {
  /** Posts from reading history (the Seen tab) to consider (0 = none). */
  history: number;
  /** Saved and hearted posts to include (0 = none). */
  listItems: number;
  /** "train": only the half of the hand labels reserved for drafting. */
  labels?: "all" | "train";
}

const item = (p: PostSummary, note?: string): EvidenceItem => ({
  title: p.title,
  subtitle: p.subtitle,
  author: p.author,
  publication: p.publication,
  ...(note ? { note } : {}),
});
const pct = (p: ReaderPost) => (p.readProgress === undefined ? undefined : `read ${Math.round(p.readProgress * 100)}%`);

export async function gatherEvidence(client: SubstackClient, dir: string | undefined, opts: EvidenceOptions): Promise<Evidence> {
  const sections: EvidenceSection[] = [];
  const warnings: string[] = [];
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      warnings.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await client.whoami(); // an expired session fails here, as an auth error

  await attempt("subscriptions", async () => {
    const subs = await client.subscriptions();
    const paid = subs.filter((s) => s.membership && s.membership !== "free_signup");
    const free = subs.filter((s) => !s.membership || s.membership === "free_signup");
    if (paid.length) sections.push({ title: "Paid subscriptions", strength: "strong", about: "Publications the reader pays for: the strongest standing signal of what they value.", lines: [paid.map((s) => s.name).join(" · ")], total: paid.length });
    if (free.length) sections.push({ title: "Free subscriptions", strength: "medium", about: "Publications the reader subscribes to for free. Some are old or impulse sign-ups; weigh names that recur elsewhere.", lines: [free.map((s) => s.name).join(" · ")], total: free.length });
  });

  if (opts.listItems > 0) {
    await attempt("saved posts", async () => {
      const r = await client.readerPosts("saved", { limit: opts.listItems });
      if (r.items.length) sections.push({ title: "Saved posts", strength: "strong", about: `Posts the reader saved for later, most recent first${r.nextCursor ? ` (the newest ${r.items.length}; older saves exist)` : ""}. Saving is a deliberate choice.`, items: r.items.map((p) => item(p, pct(p))) });
    });
    await attempt("liked posts", async () => {
      const r = await client.likedPosts({ limit: opts.listItems });
      if (r.items.length) sections.push({ title: "Hearted posts", strength: "strong", about: `Posts the reader hearted, most recent first${r.nextCursor ? ` (the newest ${r.items.length})` : ""}.`, items: r.items.map((p) => item(p)) });
    });
  }

  if (opts.history > 0) {
    await attempt("reading history", async () => {
      const r = await client.readerPosts("seen", { limit: opts.history });
      const done = r.items.filter((p) => (p.readProgress ?? 0) >= 0.8);
      const part = r.items.filter((p) => (p.readProgress ?? 0) >= 0.3 && (p.readProgress ?? 0) < 0.8);
      const left = r.items.filter((p) => (p.readProgress ?? 0) < 0.3);
      const about = "From the inbox's Seen tab (web and app reading only; posts read by email don't appear).";
      if (done.length) sections.push({ title: "Read to the end (80%+)", strength: "strong", about: `${about} Finishing a post is a strong sign it was wanted.`, items: done.map((p) => item(p, pct(p))) });
      if (part.length) sections.push({ title: "Read partway (30–80%)", strength: "medium", about, items: part.map((p) => item(p, pct(p))) });
      if (left.length) sections.push({ title: "Opened, then left (under 30%)", strength: "weak", about: `${about} Opening and leaving early can mean disappointment, or a skim, or reading it elsewhere.`, items: left.map((p) => item(p, pct(p))) });
    });
  }

  await attempt("archived posts", async () => {
    const r = await client.readerPosts("archived", { limit: 100 });
    if (r.items.length) sections.push({ title: "Dismissed from the inbox", strength: "negative", about: "Posts the reader archived (removed from their inbox) instead of reading.", items: r.items.map((p) => item(p)) });
  });

  let current: string | undefined;
  if (dir) {
    current = (await readDigestFile(dir, FILES.interests).catch(() => null)) ?? undefined;
    await attempt("digest picks", async () => {
      const picks: EvidenceItem[] = [];
      for (const f of (await subdirFiles(dir, FILES.runs)).filter((f) => f.endsWith(".json"))) {
        const run = JSON.parse((await subdirRead(dir, FILES.runs, f)) ?? "{}") as { posts?: Array<{ ref: string; title: string; publication?: string; subtitle?: string; author?: string }>; judged?: { picks?: string[] } };
        const byRef = new Map((run.posts ?? []).map((p) => [p.ref, p]));
        for (const ref of run.judged?.picks ?? []) {
          const p = byRef.get(ref);
          if (p) picks.push({ title: p.title, subtitle: p.subtitle, author: p.author, publication: p.publication });
        }
      }
      if (picks.length) sections.push({ title: "Digest ⭐ Read-in-full picks", strength: "medium", about: "Posts the digest's model chose as the best of each day, from the last 14 committed runs. They reflect the current interests.md as much as the reader's taste.", items: picks });
    });
    await attempt("labels", async () => {
      const labels = new Map<string, string>();
      for (const r of jsonl(await subdirRead(dir, "classifier", "labels.jsonl"))) (r.label ? labels.set(String(r.id), String(r.label)) : labels.delete(String(r.id)));
      if (opts.labels === "train") for (const id of [...labels.keys()]) if (!isTrainLabel(id)) labels.delete(id);
      if (!labels.size) return;
      const dataset = new Map<string, EvidenceItem>();
      for (const r of jsonl(await subdirRead(dir, "classifier", "dataset.jsonl"))) dataset.set(String(r.id), r as unknown as EvidenceItem);
      sections.push(...labelSections(labels, dataset));
    });
  } else {
    warnings.push("Digest picks, labels and the current interests.md: SUBSTACK_DIGEST_DIR isn't set.");
  }

  return {
    source: "Substack",
    current,
    sections,
    warnings,
    saveHint: dir
      ? "call save_interests_proposal with the complete proposed file (it's saved as interests.proposed.md; interests.md isn't touched), then show the reader the changes. They can compare both files against their labels with tools/classifier (score.mjs --interests …, then analyze.mjs) before adopting it."
      : undefined,
  };
}

/** A file in a subdirectory of the digest directory, refusing symlinks and anything outside it. */
async function subdirPath(dir: string, sub: string, name?: string): Promise<string | null> {
  const root = await realpath(dir).catch(() => null);
  if (!root) return null;
  const target = name ? join(root, sub, name) : join(root, sub);
  if (!target.startsWith(root + sep)) return null;
  for (const p of name ? [join(root, sub), target] : [target]) {
    const info = await lstat(p).catch(() => null);
    if (!info || info.isSymbolicLink()) return null;
  }
  return target;
}

async function subdirFiles(dir: string, sub: string): Promise<string[]> {
  const p = await subdirPath(dir, sub);
  return p ? (await readdir(p)).sort() : [];
}

async function subdirRead(dir: string, sub: string, name: string): Promise<string | null> {
  if (name.includes("/") || name.startsWith(".")) return null;
  const p = await subdirPath(dir, sub, name);
  return p ? readFile(p, "utf8").catch(() => null) : null;
}

function jsonl(text: string | null): Array<Record<string, unknown>> {
  return (text ?? "")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}
