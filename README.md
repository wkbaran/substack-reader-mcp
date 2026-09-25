<div align="center">

# Substack Reader MCP

**Ask Claude what's new in your Substack subscriptions, and have it read the posts for you.**

An MCP server that gives Claude (and any other MCP client) access to your Substack account: your subscriptions, a combined feed, full posts including paid ones you have access to, search, publication chats, and direct messages. It can also subscribe you to free newsletters and unsubscribe you from them. You log in once in a browser window; no API keys or cookie exporting.

![Node 20+](https://img.shields.io/badge/node-20%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF)
![Tools](https://img.shields.io/badge/tools-12-informational)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

[Quick start](#quick-start) · [Other clients](#other-mcp-clients) · [Tools](#tools) · [Logging in](#logging-in) · [Privacy and security](#privacy-and-security) · [Troubleshooting](#troubleshooting)

</div>

## What it uses

| What | Where | Needed? |
|---|---|---|
| Your Substack account | [substack.com](https://substack.com) | Yes. Free and paid subscriptions both work |
| Node.js 20+ | [nodejs.org](https://nodejs.org) | Yes |
| MCP SDK, Zod, Turndown | npm (`@modelcontextprotocol/sdk`, `zod`, `turndown`) | Yes, installed by `npm install` |
| Chrome or Edge | Your existing install, driven by `playwright-core` | Optional. Only for the browser login; you can paste a cookie instead |

Substack has no public API. This server calls the same endpoints Substack's website uses, with your own session, so it can only see what you can see when logged in.

## Quick start

```bash
git clone https://github.com/wkbaran/substack-reader-mcp.git
cd substack-reader-mcp
npm install && npm run build

node dist/cli.js login     # a browser window opens; sign in to Substack as usual
node dist/cli.js install   # registers the server with Claude Code
```

Restart Claude Code (a session that's already running won't pick up new servers), then try:

- *"What's new in my Substack feed this week?"*
- *"Summarize the latest post from The Pragmatic Engineer."*
- *"Search One Useful Thing for posts about agents."*
- *"What are people talking about in Nate's subscriber chat?"*
- *"Unsubscribe me from newsletters I haven't opened in a while."* (Claude asks before each change)

### Example

```text
> Search One Useful Thing for posts about agents

● substack-reader - search_posts (publication: "One Useful Thing", query: "agents", limit: 3)

  Three posts match:
  1. Agency and Agents (Aug 31, 2026): From the Hugging Face Incident to Twilight Factories
  2. Three Years from GPT-3 to Gemini 3 (Nov 18, 2025): From chatbots to agents
  3. The End of Search, The Beginning of Research (Feb 3, 2025): The first narrow agents are here
```

## Other MCP clients

`install` covers Claude Code. For other clients, point them at `dist/cli.js` with an absolute path. Log in with `node dist/cli.js login` first either way.

<details>
<summary><b>Claude Desktop</b></summary>

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "substack-reader": {
      "command": "node",
      "args": ["/absolute/path/to/substack-reader-mcp/dist/cli.js"]
    }
  }
}
```
</details>

<details>
<summary><b>Cursor</b></summary>

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "substack-reader": {
      "command": "node",
      "args": ["/absolute/path/to/substack-reader-mcp/dist/cli.js"]
    }
  }
}
```
</details>

<details>
<summary><b>VS Code</b></summary>

Add to `.vscode/mcp.json` in a workspace, or to your user MCP configuration:

```json
{
  "servers": {
    "substack-reader": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/substack-reader-mcp/dist/cli.js"]
    }
  }
}
```
</details>

<details>
<summary><b>Claude Code, manually</b></summary>

```bash
claude mcp add --scope user substack-reader -- node /absolute/path/to/substack-reader-mcp/dist/cli.js
```
</details>

## Tools

Publications can be named loosely: by name (*"The Pragmatic Engineer"*), part of a name (*"pragmatic"*), subdomain, or URL. Posts can be given as any Substack link (`/p/slug`, `substack.com/home/post/p-123`, `open.substack.com/pub/…`) or a post ID.

### Reading

| Tool | What it returns |
|---|---|
| `auth_status` | Whether you're logged in, as whom, and whether Substack still accepts the session |
| `list_subscriptions` | Every subscription, including ones hidden from your public profile, with URL and membership |
| `get_feed` | Recent posts across all subscriptions, newest first. `since` takes `"7d"`, `"48h"` or a date |
| `get_recent_posts` | Recent posts from one publication, with `offset` for paging back |
| `search_posts` | Keyword search within one publication's archive |
| `read_post` | A full post as Markdown (or `text` / `html`). Long posts are paged with `start`. A paid post you can't access is flagged as a preview |

### Chat

| Tool | What it returns |
|---|---|
| `list_chats` | Your chat inbox: publication chats you're in and direct messages, with unread state |
| `get_chat_threads` | Threads in a publication's chat, newest first, with reply counts. `before` pages back |
| `read_chat_thread` | A thread with its replies and replies to replies, as a readable transcript |
| `read_dm` | One direct-message conversation |

### Account changes

| Tool | What it does |
|---|---|
| `subscribe` | Free-subscribes you to a publication. Never starts a paid plan; does nothing if you're already subscribed |
| `unsubscribe` | Removes a **free** subscription. Paid subscriptions are refused, and an ambiguous name lists the matches instead of guessing |

Every tool except these two is marked read-only. These two are marked as changing your account, so MCP clients ask before running them, and `unsubscribe` is also marked destructive. After each change the server checks with Substack and reports what actually happened.

## Logging in

Substack has no API keys or OAuth for readers, so the server uses your normal web session.

- **Browser login (default).** `login` opens Chrome or Edge on Substack's sign-in page. Sign in however you normally do: email link, password, or Google. The session is captured, checked with Substack, and saved as soon as you're in. The login window keeps its own browser profile, so when the session expires months later, running `login` again usually finishes without typing anything.
- **Paste.** `login --paste` is for machines without a display. Copy the `substack.sid` cookie from your browser's DevTools (Application → Cookies → substack.com). The bare value, a `Cookie:` header, a Cookie-Editor JSON export, and `cookies.txt` all work. `login --stdin` reads the same formats from a pipe.
- **No restart needed.** The server re-reads the session on every call, so after `login` the next request just works.

> [!TIP]
> If Substack emails you a sign-in link, paste it into the address bar of the window `login` opened. Clicking it opens your normal browser instead.
>
> Google sign-in sometimes refuses to run in an automated window. Use Substack's email link or password option instead, or `--paste`.

| Command | What it does |
|---|---|
| `node dist/cli.js login` | Browser login. Add `--paste` or `--stdin` to paste the cookie instead |
| `node dist/cli.js status` | Shows the logged-in account, how many subscriptions it has, and whether the session still works |
| `node dist/cli.js logout` | Deletes the saved session. `--all` also deletes the login browser profile |
| `node dist/cli.js install` | Registers the server with Claude Code. `--scope user\|project\|local` (default `user`) |

<details>
<summary><b>Environment variables</b></summary>

| Variable | Purpose |
|---|---|
| `SUBSTACK_SID` | Session cookie value. Overrides the saved session, for containers or CI |
| `SUBSTACK_COOKIE` | A full `Cookie:` header to take `substack.sid` from |
| `SUBSTACK_READER_HOME` | Config directory (default `~/.config/substack-reader`) |
| `SUBSTACK_BROWSER_PATH` | A Chromium-based browser for `login`, if Chrome and Edge aren't installed |
| `SUBSTACK_USERNAME` | When logged out, `list_subscriptions` shows this user's *public* subscriptions |
| `SUBSTACK_COOKIES_PATH` | A Cookie-Editor export from the original Python version, read as a fallback |

</details>

## Privacy and security

- **Where the session goes.** The `substack.sid` cookie is only ever sent to `substack.com` and `*.substack.com`. Publications on their own domain (such as `www.lennysnewsletter.com`) get a separate session for that domain through Substack's own sign-in handoff, the way your browser does it. Redirects are followed one hop at a time, so no cookie is carried to a different host.
- **What's stored.** The session is saved to `~/.config/substack-reader/auth.json` with owner-only permissions (`600`), next to the login browser profile. Nothing is stored in this repository, and `.gitignore` excludes session files in case you copy them in.
- **What leaves your machine.** Requests go only to Substack and to the publications you ask about. There's no analytics or telemetry. What Claude does with the content it reads is governed by your MCP client.
- **Account changes.** Only `subscribe` and `unsubscribe` change anything, and only free subscriptions. `unsubscribe` checks with the publication first and refuses anything with a payment attached (a paid plan, founding membership, gift, or bundle).
- **Dependencies.** `package-lock.json` pins every dependency to an exact version and integrity hash. Install with `npm ci` for a reproducible install.

## Troubleshooting

| Symptom | Fix |
|---|---|
| *"Not logged in"* or *"session was rejected"* | Run `node dist/cli.js login`. Sessions last about three months |
| The server doesn't appear in `/mcp` | Restart Claude Code. New servers are only loaded when a session starts |
| A paid post shows *"Only a preview was returned"* | You don't have a paid subscription to that publication, or run `status` to check the session |
| `login` can't find a browser | Install Chrome, set `SUBSTACK_BROWSER_PATH`, run `npx playwright install chromium`, or use `--paste` |
| *"doesn't look like a Substack publication"* | The newsletter may have left Substack (Platformer, for example, moved to Ghost) |
| The server stopped starting after a Node upgrade | `install` records the Node binary it ran with. Run it again with your current Node |

## Development

```bash
npm ci
npm test            # vitest against a fake fetch; no network, no account needed
npm run typecheck
npm run build       # compiles src/ to dist/
```

```
src/
  cli.ts                 entry point: serve, login, status, logout, install
  server.ts              MCP tool definitions
  format.ts              HTML → Markdown, paywall-preview detection
  auth/credentials.ts    session storage; parses pasted cookies in any format
  auth/login.ts          browser and paste login
  substack/http.ts       fetch wrapper: cookie scoping, custom-domain sessions, redirects, retries
  substack/api.ts        subscriptions, posts, feed, subscribe/unsubscribe
  substack/chat.ts       chat inbox, threads, replies, direct messages
test/                    one file per module, plus an in-memory MCP client test
```

[`CLAUDE.md`](CLAUDE.md) records how Substack's endpoints actually behave, including the ones that look right but aren't. Read it before changing anything under `src/substack/`.

## Disclaimer

An independent project, not affiliated with or endorsed by Substack. It uses Substack's undocumented web endpoints, which can change without notice. Use it with your own account, and within Substack's [Terms of Use](https://substack.com/tos).

## License

[MIT](LICENSE) © 2026 Bill Baran. Use, modify, and share it freely; keep the copyright notice.
