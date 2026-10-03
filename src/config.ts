import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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

/** IANA time zone for times shown in digests (SUBSTACK_DIGEST_TZ, default UTC). */
export function digestTimezone(value = process.env.SUBSTACK_DIGEST_TZ): { timeZone: string; warning?: string } {
  const tz = value?.trim();
  if (!tz) return { timeZone: "UTC" };
  if (isValidTimeZone(tz)) return { timeZone: tz };
  return { timeZone: "UTC", warning: `SUBSTACK_DIGEST_TZ "${tz}" is not a valid IANA time zone; using UTC.` };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
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
