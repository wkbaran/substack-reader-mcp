import { homedir } from "node:os";
import { join } from "node:path";

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
