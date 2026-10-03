import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizePostUrl } from "../substack/api.js";

// Everything the digest persists lives in one directory (SUBSTACK_DIGEST_DIR) under
// fixed names. Two server processes can run at once (Hermes starts more than one),
// so every write takes a lock file and goes through write-then-rename.

export const FILES = {
  state: "state.json",
  currentRun: "current_run.json",
  previousRun: "previous_run.json",
  interests: "interests.md",
  lock: "state.lock",
  /** Directory of committed runs, newest KEEP_RUNS kept: headlines for tools/classifier. */
  runs: "runs",
} as const;

export const KEEP_RUNS = 14;

export const MAX_REPORTED = 500;
/** A publication that couldn't be checked for this long is given up on. */
export const GIVE_UP_MS = 7 * 86_400_000;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 10_000;
const FILE_MODE = 0o644;

export interface PendingPublication {
  name: string;
  /** Cutoff to fetch from next time: the oldest point not yet checked. */
  since: string;
  error?: string;
  failures: number;
}

export interface RunRecord {
  run_id: string;
  fetch_start: string;
  committed_at: string;
  posts: number;
  chats: number;
}

export interface DigestState {
  version: 2;
  last_run?: string;
  pending_publications: Record<string, PendingPublication>;
  /** Recent committed runs, newest last (for digest_status). */
  runs?: RunRecord[];
  reported_posts: string[];
  [key: string]: unknown;
}

export interface LoadedState {
  state: DigestState;
  /** false: no state file yet (first run). */
  exists: boolean;
  /** The file existed but couldn't be parsed; it's backed up before the next write. */
  corrupt?: string;
  warnings: string[];
}

export function emptyState(): DigestState {
  return { version: 2, pending_publications: {}, reported_posts: [] };
}

/** Read state.json, migrating v1 (`{last_run, reported_posts}`) on the fly. Never writes. */
export async function loadState(dir: string): Promise<LoadedState> {
  const file = await safePath(dir, FILES.state);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: emptyState(), exists: false, warnings: [] };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const reported = Array.isArray(parsed.reported_posts) ? parsed.reported_posts.filter((u): u is string => typeof u === "string") : [];
    const pending =
      parsed.pending_publications && typeof parsed.pending_publications === "object" && !Array.isArray(parsed.pending_publications)
        ? (parsed.pending_publications as Record<string, PendingPublication>)
        : {};
    const lastRun = typeof parsed.last_run === "string" && !Number.isNaN(Date.parse(parsed.last_run)) ? parsed.last_run : undefined;
    const warnings = typeof parsed.last_run === "string" && !lastRun ? [`state.json has an unreadable last_run ("${parsed.last_run}"); treating this as a first run.`] : [];
    return {
      state: { ...parsed, version: 2, last_run: lastRun, pending_publications: pending, reported_posts: reported },
      exists: true,
      warnings,
    };
  } catch (err) {
    return {
      state: emptyState(),
      exists: true,
      corrupt: raw,
      warnings: [`state.json couldn't be parsed (${err instanceof Error ? err.message : String(err)}); treating this as a first run. It will be backed up as state.json.corrupt-<time> when this run is saved.`],
    };
  }
}

/** Pretty-printed with indent 2 and a trailing newline. `reported_posts` stays last. */
export function serializeState(state: DigestState): string {
  const { version, last_run, pending_publications, runs, reported_posts, ...rest } = state;
  const ordered: Record<string, unknown> = { version: 2, last_run, pending_publications, ...rest };
  void version;
  if (runs !== undefined) ordered.runs = runs;
  // Kept last on purpose: the v2.x skill appended URLs by patching the end of this list.
  ordered.reported_posts = reported_posts;
  return JSON.stringify(ordered, null, 2) + "\n";
}

/** Add URLs to reported_posts, skipping ones already there (compared normalized), keeping the newest MAX_REPORTED. */
export function addReported(list: string[], urls: string[]): { list: string[]; added: number } {
  const seen = new Set(list.map(normalizePostUrl));
  const out = [...list];
  let added = 0;
  for (const url of urls) {
    const key = normalizePostUrl(url);
    if (!url.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push(url.trim());
    added++;
  }
  return { list: out.slice(-MAX_REPORTED), added };
}

/** The later of two ISO times (last_run never moves backwards). */
export function laterOf(a: string | undefined, b: string): string {
  if (!a) return b;
  return Date.parse(a) > Date.parse(b) ? a : b;
}

// ---- files ----

/**
 * Absolute path of a fixed file name inside the digest directory. Refuses symlinks,
 * so a link planted in the directory can't redirect a write elsewhere.
 */
export async function safePath(dir: string, name: string): Promise<string> {
  if (name.includes("/") || name.includes("\\") || name.startsWith(".")) throw new Error(`invalid digest file name ${name}`);
  let base: string;
  try {
    base = await realpath(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await mkdir(dir, { recursive: true, mode: 0o755 });
    base = await realpath(dir);
  }
  const file = join(base, name);
  const info = await lstat(file).catch(() => null);
  if (info?.isSymbolicLink()) throw new Error(`${file} is a symlink; refusing to use it.`);
  return file;
}

/** Read a digest file, or null if it doesn't exist. */
export async function readDigestFile(dir: string, name: string): Promise<string | null> {
  const file = await safePath(dir, name);
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Write-then-rename, keeping the existing file's mode (0644 for new files). */
export async function atomicWrite(dir: string, name: string, content: string): Promise<void> {
  const file = await safePath(dir, name);
  const mode = (await stat(file).catch(() => null))?.mode;
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  try {
    await writeFile(tmp, content, { mode: FILE_MODE, flag: "wx" });
    await chmod(tmp, mode !== undefined ? mode & 0o777 : FILE_MODE);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function removeDigestFile(dir: string, name: string): Promise<void> {
  await rm(await safePath(dir, name), { force: true });
}

export class LockBusyError extends Error {}

/**
 * Run `fn` holding the digest lock (an exclusively created lock file). A lock older
 * than a minute is assumed to belong to a crashed process and is taken over.
 */
export async function withLock<T>(dir: string, fn: () => Promise<T>, { staleMs = LOCK_STALE_MS, waitMs = LOCK_WAIT_MS, sleep = defaultSleep, now = Date.now } = {}): Promise<T> {
  const lock = await safePath(dir, FILES.lock);
  const start = now();
  for (;;) {
    try {
      const handle = await open(lock, "wx", FILE_MODE);
      await handle.writeFile(`${process.pid} ${new Date(now()).toISOString()}\n`);
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const info = await stat(lock).catch(() => null);
      if (info && now() - info.mtimeMs > staleMs) {
        await rm(lock, { force: true });
        continue;
      }
      if (now() - start >= waitMs) throw new LockBusyError("Another digest call is saving state right now. Wait a few seconds and call this tool again.");
      await sleep(200);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Save a committed run as runs/<run_id>.json and keep only the newest KEEP_RUNS.
 * Nothing reads these during a digest; they're history for tools/classifier.
 */
export async function archiveRun(dir: string, runId: string, content: string, keep = KEEP_RUNS): Promise<void> {
  if (!/^[\w-]+$/.test(runId)) throw new Error(`invalid run id ${runId}`);
  const runs = await safePath(dir, FILES.runs);
  const info = await lstat(runs).catch(() => null);
  if (info && !info.isDirectory()) throw new Error(`${runs} isn't a directory; refusing to use it.`);
  if (!info) await mkdir(runs, { mode: 0o755 });
  const file = join(runs, `${runId}.json`);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  try {
    await writeFile(tmp, content, { mode: FILE_MODE, flag: "wx" });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  const names = (await readdir(runs)).filter((n) => /^[\w-]+\.json$/.test(n)).sort();
  for (const n of names.slice(0, Math.max(0, names.length - keep))) await rm(join(runs, n), { force: true });
}
