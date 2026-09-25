import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { paths, SESSION_COOKIE } from "../config.js";

export interface SubstackUser {
  id: number;
  name?: string;
  handle?: string;
}

export interface Credentials {
  /** Value of the substack.sid cookie, exactly as the browser stores it. */
  sid: string;
  /** Where the credentials came from, for status messages. */
  source: "env" | "auth-file" | "legacy-cookies";
  /** Cookie expiry (ISO) when known. */
  expiresAt?: string;
  savedAt?: string;
  user?: SubstackUser;
}

interface AuthFile {
  version: 1;
  sid: string;
  expiresAt?: string;
  savedAt: string;
  user?: SubstackUser;
}

/**
 * Resolve credentials in priority order:
 *   1. SUBSTACK_SID env var (or SUBSTACK_COOKIE holding a full Cookie header)
 *   2. auth.json written by `substack-reader-mcp login`
 *   3. cookies.json from the original Python version (Cookie-Editor export)
 */
export async function loadCredentials(): Promise<Credentials | null> {
  const envSid = process.env.SUBSTACK_SID || extractSid(process.env.SUBSTACK_COOKIE ?? "");
  if (envSid) return { sid: envSid, source: "env" };

  const file = await readJson<AuthFile>(paths.auth);
  if (file?.sid) {
    return {
      sid: file.sid,
      source: "auth-file",
      expiresAt: file.expiresAt,
      savedAt: file.savedAt,
      user: file.user,
    };
  }

  const legacy = await readFile(paths.legacyCookies, "utf8").catch(() => null);
  const legacySid = legacy ? extractSid(legacy) : null;
  if (legacySid) return { sid: legacySid, source: "legacy-cookies" };

  return null;
}

export async function saveCredentials(creds: {
  sid: string;
  expiresAt?: string;
  user?: SubstackUser;
}): Promise<string> {
  const file: AuthFile = {
    version: 1,
    sid: creds.sid,
    expiresAt: creds.expiresAt,
    savedAt: new Date().toISOString(),
    user: creds.user,
  };
  const target = paths.auth;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  // Write-then-rename so a crash never leaves a half-written session file.
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
  return target;
}

export async function clearCredentials(): Promise<boolean> {
  try {
    await rm(paths.auth);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull a substack.sid value out of whatever the user pasted:
 * a Cookie-Editor / EditThisCookie JSON export, a raw `Cookie:` header,
 * a Netscape cookies.txt, or just the bare cookie value.
 */
export function extractSid(input: string): string | null {
  const text = input.trim();
  if (!text) return null;

  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      const list = Array.isArray(parsed)
        ? parsed
        : ((parsed as { cookies?: unknown[] }).cookies ?? []);
      for (const c of list as Array<{ name?: string; value?: string }>) {
        if (c?.name === SESSION_COOKIE && c.value) return c.value.trim();
      }
    } catch {
      // Not JSON after all; fall through to the text heuristics.
    }
    return null;
  }

  // Netscape cookies.txt: tab-separated, name in column 6, value in column 7.
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split("\t");
    if (cols.length >= 7 && cols[5] === SESSION_COOKIE) return cols[6]!.trim() || null;
  }

  // Cookie header ("Cookie: a=b; substack.sid=...; c=d") or "substack.sid=..."
  const match = text.match(/(?:^|[;\s])substack\.sid=([^;\s]+)/);
  if (match) return match[1]!;

  // Bare value: Substack sids look like "s%3A<id>.<signature>" (or decoded "s:...").
  if (/^s(%3A|:)[\w\-%.+/=]+$/i.test(text)) return text;

  return null;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}
