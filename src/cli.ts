#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { clearCredentials, loadCredentials } from "./auth/credentials.js";
import {
  browserLogin,
  BrowserUnavailableError,
  PASTE_INSTRUCTIONS,
  promptForSid,
  readSidFromStdin,
  validateAndSave,
  type LoginResult,
} from "./auth/login.js";
import { paths } from "./config.js";
import { SubstackClient } from "./substack/api.js";
import { AuthError, SubstackHttp } from "./substack/http.js";
import { serve } from "./server.js";

const HELP = `substack-reader-mcp — read your Substack subscriptions from Claude Code

Usage:
  substack-reader-mcp                 Run the MCP server over stdio (what Claude Code launches)
  substack-reader-mcp login           Log in via a browser window (falls back to pasting a cookie)
      --paste                         Skip the browser; paste the substack.sid cookie instead
      --stdin                         Read the cookie from stdin (e.g. \`pbpaste | ... login --stdin\`)
      --timeout <seconds>             How long to wait for browser login (default 300)
  substack-reader-mcp status          Show which account is logged in and whether the session works
  substack-reader-mcp logout [--all]  Delete the saved session (--all also deletes the browser profile)
  substack-reader-mcp install         Register this server with Claude Code (\`claude mcp add\`)
      --scope <user|project|local>    Scope for the registration (default user)
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);

  switch (cmd) {
    case undefined:
    case "serve":
      await serve();
      return -1; // keep running
    case "login":
      return login(flags);
    case "status":
      return status();
    case "logout":
      return logout(flags);
    case "install":
      return install(flags);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

async function login(flags: Flags): Promise<number> {
  let result: LoginResult;
  if (flags.stdin) {
    result = await validateAndSave(await readSidFromStdin());
  } else if (flags.paste || !canOpenBrowser()) {
    if (!flags.paste) console.error("No display available, so skipping the browser login.\n");
    console.error(PASTE_INSTRUCTIONS);
    result = await validateAndSave(await promptForSid());
  } else {
    try {
      const timeout = Number(flags.timeout ?? 300);
      result = await browserLogin({ timeoutMs: timeout * 1000 });
    } catch (err) {
      if (!(err instanceof BrowserUnavailableError)) throw err;
      console.error(`${err.message}\n\nFalling back to pasting your cookie.\n`);
      console.error(PASTE_INSTRUCTIONS);
      result = await validateAndSave(await promptForSid());
    }
  }

  console.error(`\n✓ Logged in as ${describeUser(result.user)}`);
  console.error(`  Session saved to ${result.file}`);
  if (result.expiresAt) console.error(`  Cookie expires ${result.expiresAt.slice(0, 10)}`);
  const envCreds = process.env.SUBSTACK_SID || process.env.SUBSTACK_COOKIE;
  if (envCreds) console.error("  Note: SUBSTACK_SID/SUBSTACK_COOKIE is set and takes priority over the saved session.");
  console.error("  A running MCP server picks this up automatically; no restart needed.");
  return 0;
}

async function status(): Promise<number> {
  const creds = await loadCredentials();
  if (!creds) {
    console.log("Not logged in. Run `substack-reader-mcp login`.");
    return 1;
  }
  const where =
    creds.source === "env" ? "SUBSTACK_SID environment variable" : creds.source === "auth-file" ? paths.auth : `${paths.legacyCookies} (legacy export)`;
  console.log(`Session source: ${where}`);
  if (creds.expiresAt) console.log(`Cookie expires: ${creds.expiresAt}`);
  try {
    const client = new SubstackClient(new SubstackHttp({ sid: creds.sid }));
    const user = await client.whoami();
    const subs = await client.subscriptions();
    console.log(`✓ Session valid for ${describeUser(user)} — ${subs.length} subscriptions`);
    if (creds.source === "legacy-cookies") {
      console.log("  Tip: run `substack-reader-mcp login` to migrate to the new session store.");
    }
    return 0;
  } catch (err) {
    if (err instanceof AuthError) {
      console.log("✗ Session rejected by Substack (expired or signed out). Run `substack-reader-mcp login`.");
      return 1;
    }
    throw err;
  }
}

async function logout(flags: Flags): Promise<number> {
  const removed = await clearCredentials();
  console.log(removed ? `Removed ${paths.auth}` : "No saved session to remove.");
  if (flags.all) {
    await rm(paths.browserProfile, { recursive: true, force: true });
    console.log(`Removed ${paths.browserProfile}`);
  }
  if (process.env.SUBSTACK_SID || process.env.SUBSTACK_COOKIE) {
    console.log("Note: SUBSTACK_SID/SUBSTACK_COOKIE is still set in your environment.");
  }
  return 0;
}

function install(flags: Flags): number {
  const scope = String(flags.scope ?? "user");
  const entry = fileURLToPath(import.meta.url);
  const args = ["mcp", "add", "--scope", scope, "substack-reader", "--", process.execPath, entry];

  if (spawnSync("claude", ["--version"], { stdio: "ignore" }).status !== 0) {
    console.log("The `claude` CLI wasn't found on PATH. Register the server manually with:\n");
    console.log(`  claude ${args.map(shellQuote).join(" ")}\n`);
    console.log("or add this to your MCP config:\n");
    console.log(JSON.stringify({ mcpServers: { "substack-reader": { command: process.execPath, args: [entry] } } }, null, 2));
    return 1;
  }
  // Re-registering should replace any older entry (e.g. the Python version).
  spawnSync("claude", ["mcp", "remove", "--scope", scope, "substack-reader"], { stdio: "ignore" });
  execFileSync("claude", args, { stdio: "inherit" });
  console.log("\n✓ Registered. Restart Claude Code to load it; sessions that are already running won't see new servers.");
  return 0;
}

// ---- helpers ----

type Flags = Record<string, string | boolean>;

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    const next = args[i + 1];
    if (inline !== undefined) flags[key] = inline;
    else if (next !== undefined && !next.startsWith("--") && (key === "timeout" || key === "scope")) {
      flags[key] = next;
      i++;
    } else flags[key] = true;
  }
  return flags;
}

function canOpenBrowser(): boolean {
  if (process.platform !== "linux") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function describeUser(user: { id: number; name?: string; handle?: string }): string {
  return [user.name, user.handle ? `(@${user.handle})` : null].filter(Boolean).join(" ") || `user ${user.id}`;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
