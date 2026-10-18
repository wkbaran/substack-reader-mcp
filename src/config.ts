import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseDuration } from "paced-fetch";

/** Root directory for everything this tool persists. Override with SUBSTACK_READER_HOME. */
export function configDir(): string {
  if (process.env.SUBSTACK_READER_HOME) return process.env.SUBSTACK_READER_HOME;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "substack-reader");
}

export const paths = {
  get auth() {
    return join(configDir(), "auth.json");
  },
  /** Cookie-Editor export used by the original Python server; read-only fallback. */
  get legacyCookies() {
    return process.env.SUBSTACK_COOKIES_PATH || join(configDir(), "cookies.json");
  },
  get browserProfile() {
    return join(configDir(), "browser-profile");
  },
};

export const SESSION_COOKIE = "substack.sid";
export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * Directory for the scheduled-digest files (state, run files, interests). The
 * digest tools are registered only when SUBSTACK_DIGEST_DIR is set, and it must be
 * an absolute path. Paths never come from tool arguments.
 */
export function digestDir(): string | undefined {
  const dir = process.env.SUBSTACK_DIGEST_DIR?.trim();
  if (!dir) return undefined;
  if (!isAbsolute(dir)) {
    console.error(`substack-reader: SUBSTACK_DIGEST_DIR must be an absolute path (got "${dir}"); digest tools are disabled.`);
    return undefined;
  }
  return dir;
}

/** IANA time zone for times shown in digests: SUBSTACK_DIGEST_TZ, else TZ, else UTC. */
export function digestTimezone(env: NodeJS.ProcessEnv = process.env): { timeZone: string; warning?: string } {
  for (const name of ["SUBSTACK_DIGEST_TZ", "TZ"] as const) {
    const tz = env[name]?.trim();
    if (!tz) continue;
    if (isValidTimeZone(tz)) return { timeZone: tz };
    return { timeZone: "UTC", warning: `${name}="${tz}" is not a valid IANA time zone; using UTC.` };
  }
  return { timeZone: "UTC" };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * How long digest_begin may spend fetching (SUBSTACK_DIGEST_FETCH_BUDGET, e.g. "10min").
 * The default, 250 s, fits an agent host's 300 s tool timeout. Posts get all but
 * 110 s of it (at least half), which leaves time for chats and the classifier.
 */
export function digestFetchBudget(env: NodeJS.ProcessEnv = process.env): { totalMs: number; postsMs: number; warning?: string } {
  const raw = env.SUBSTACK_DIGEST_FETCH_BUDGET?.trim();
  const parsed = raw ? parseDuration(raw) : null;
  const totalMs = parsed && parsed >= 30_000 ? parsed : 250_000;
  const warning = raw && totalMs !== parsed ? `SUBSTACK_DIGEST_FETCH_BUDGET=${raw} isn't a duration of at least 30 s; using 250 s.` : undefined;
  return { totalMs, postsMs: Math.max(totalMs - 110_000, Math.round(totalMs / 2)), ...(warning ? { warning } : {}) };
}

// ---- headline classifier (optional; see docs/classifier.md) ----

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** Posts the classifier gives a skip probability at or above this are dropped (SUBSTACK_DIGEST_SKIP_THRESHOLD). */
export function digestSkipThreshold(): number {
  return envNumber("SUBSTACK_DIGEST_SKIP_THRESHOLD", 0.7, 0, 1);
}

/** Posts ranked below this are listed apart and reading them is optional (SUBSTACK_DIGEST_RANK_FLOOR; 0 = off). */
export function digestRankFloor(): number {
  return envNumber("SUBSTACK_DIGEST_RANK_FLOOR", 0, 0, 1);
}
