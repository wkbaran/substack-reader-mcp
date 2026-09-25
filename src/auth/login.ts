import { createInterface } from "node:readline/promises";
import { mkdir } from "node:fs/promises";
import { paths, SESSION_COOKIE } from "../config.js";
import { SubstackClient } from "../substack/api.js";
import { AuthError, SubstackHttp } from "../substack/http.js";
import { extractSid, saveCredentials, type SubstackUser } from "./credentials.js";

export interface LoginResult {
  user: SubstackUser;
  file: string;
  expiresAt?: string;
}

/** Check a session against Substack and persist it only if it actually works. */
export async function validateAndSave(sid: string, expiresAt?: string): Promise<LoginResult> {
  const user = await verifySid(sid);
  if (!user) {
    throw new Error("Substack rejected that session. Make sure you copied the cookie while logged in.");
  }
  const file = await saveCredentials({ sid, expiresAt, user });
  return { user, file, expiresAt };
}

async function verifySid(sid: string): Promise<SubstackUser | null> {
  try {
    return await new SubstackClient(new SubstackHttp({ sid, maxRetries: 1 })).whoami();
  } catch (err) {
    if (err instanceof AuthError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Browser login
// ---------------------------------------------------------------------------

type PlaywrightChromium = typeof import("playwright-core").chromium;
type BrowserContext = import("playwright-core").BrowserContext;

export class BrowserUnavailableError extends Error {}

/**
 * Open a real browser window on Substack's sign-in page and wait for the user to
 * log in (email link, password, Google — whatever they normally use). The
 * session cookie is captured as soon as Substack accepts it.
 *
 * A dedicated browser profile is kept under the config dir, so when the session
 * eventually expires, re-running login usually completes without typing anything.
 */
export async function browserLogin({ timeoutMs = 5 * 60_000, log = console.error } = {}): Promise<LoginResult> {
  const chromium = await loadChromium();
  await mkdir(paths.browserProfile, { recursive: true, mode: 0o700 });
  const context = await launch(chromium);

  let closed = false;
  context.on("close", () => {
    closed = true;
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://substack.com/sign-in?redirect=%2Fhome", { waitUntil: "domcontentloaded" }).catch(() => undefined);
    log("A browser window has opened. Log in to Substack there; this finishes on its own once you're signed in.");
    log("Tip: if Substack emails you a sign-in link, paste that link into the address bar of THIS window.");

    const deadline = Date.now() + timeoutMs;
    let lastSid: string | undefined;
    let lastCheck = 0;
    while (Date.now() < deadline) {
      if (closed) throw new Error("Browser window was closed before login completed.");
      const cookies = await context.cookies("https://substack.com").catch(() => []);
      const sidCookie = cookies.find((c) => c.name === SESSION_COOKIE);
      // Anonymous visitors get a sid too, and logging in may upgrade it in place,
      // so re-check when it changes and periodically otherwise.
      if (sidCookie && (sidCookie.value !== lastSid || Date.now() - lastCheck > 5000)) {
        lastSid = sidCookie.value;
        lastCheck = Date.now();
        const user = await verifySid(sidCookie.value);
        if (user) {
          const expiresAt = sidCookie.expires > 0 ? new Date(sidCookie.expires * 1000).toISOString() : undefined;
          const file = await saveCredentials({ sid: sidCookie.value, expiresAt, user });
          return { user, file, expiresAt };
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for login.`);
  } finally {
    if (!closed) await context.close().catch(() => undefined);
  }
}

async function loadChromium(): Promise<PlaywrightChromium> {
  try {
    const mod = await import("playwright-core");
    return mod.chromium;
  } catch {
    throw new BrowserUnavailableError("playwright-core is not installed (it's an optional dependency).");
  }
}

async function launch(chromium: PlaywrightChromium): Promise<BrowserContext> {
  const common = {
    headless: false,
    viewport: null,
    // Keeps "Chrome is being controlled by automated software" and similar flags
    // from tripping Substack's (and Google's) bot checks.
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  };
  const attempts: Array<{ label: string; opts: Record<string, unknown> }> = [
    { label: "Google Chrome", opts: { channel: "chrome" } },
    { label: "Microsoft Edge", opts: { channel: "msedge" } },
    { label: "Playwright Chromium", opts: {} },
  ];
  if (process.env.SUBSTACK_BROWSER_PATH) {
    attempts.unshift({ label: process.env.SUBSTACK_BROWSER_PATH, opts: { executablePath: process.env.SUBSTACK_BROWSER_PATH } });
  }
  const failures: string[] = [];
  for (const { label, opts } of attempts) {
    try {
      return await chromium.launchPersistentContext(paths.browserProfile, { ...common, ...opts });
    } catch (err) {
      failures.push(`${label}: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
    }
  }
  throw new BrowserUnavailableError(
    `Couldn't launch a browser.\n  ${failures.join("\n  ")}\nInstall Chrome, set SUBSTACK_BROWSER_PATH, or run \`npx playwright install chromium\`.`,
  );
}

// ---------------------------------------------------------------------------
// Paste login
// ---------------------------------------------------------------------------

export const PASTE_INSTRUCTIONS = `To copy your Substack session cookie:
  1. Log in at https://substack.com in your normal browser.
  2. Open DevTools (F12) → Application (Chrome/Edge) or Storage (Firefox) → Cookies → https://substack.com
  3. Copy the Value of the "substack.sid" cookie.

You can paste any of: the bare value, a full "Cookie:" header, a Cookie-Editor JSON
export, or a cookies.txt file. It's validated with Substack and stored at
${paths.auth} (mode 600).
`;

/** Read the pasted cookie from an interactive terminal. */
export async function promptForSid(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    let buffer = "";
    let line = await rl.question("Paste here and press Enter: ");
    buffer = line;
    // Multi-line JSON exports: keep reading until the paste parses.
    while (/^\s*[[{]/.test(buffer) && !isCompleteJson(buffer)) {
      line = await rl.question("");
      buffer += "\n" + line;
    }
    const sid = extractSid(buffer);
    if (!sid) throw new Error(`Couldn't find a ${SESSION_COOKIE} value in what was pasted.`);
    return sid;
  } finally {
    rl.close();
  }
}

/** Read the cookie from piped stdin (e.g. `pbpaste | substack-reader-mcp login --stdin`). */
export async function readSidFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const sid = extractSid(Buffer.concat(chunks).toString("utf8"));
  if (!sid) throw new Error(`Couldn't find a ${SESSION_COOKIE} value on stdin.`);
  return sid;
}

function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
