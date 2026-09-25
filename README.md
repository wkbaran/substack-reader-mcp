# Substack Reader MCP Server

An MCP server that lets Claude Code (or any MCP client) read your Substack subscriptions, including paid posts you have access to.

TypeScript rewrite of the original Python `substack-reader-mcp`, with a much simpler login.

## Quick start

```bash
git clone https://github.com/wkbaran/substack-reader-mcp.git ~/.claude/mcp-servers/substack-reader
cd ~/.claude/mcp-servers/substack-reader
npm install && npm run build

node dist/cli.js login     # opens a browser window; sign in to Substack as usual
node dist/cli.js install   # registers the server with Claude Code (claude mcp add)
```

Restart Claude Code (a session that is already running won't pick up new servers), then ask things like:

- "What's new in my Substack feed this week?"
- "List my Substack subscriptions"
- "Search Platformer for posts about Bluesky"
- "Read https://substack.com/home/post/p-217245889"

## Logging in

Substack has no API keys or OAuth for readers, so this server uses your normal web session (the `substack.sid` cookie). `login` gets it for you:

| Command | What it does |
| --- | --- |
| `login` | Opens a browser window on Substack's sign-in page. Sign in however you normally do (email link, password, Google). The session is captured, checked with Substack, and saved as soon as you're in. |
| `login --paste` | For machines without a display. Paste the `substack.sid` cookie from your browser's DevTools. The bare value, a `Cookie:` header, a Cookie-Editor JSON export, and `cookies.txt` all work. |
| `login --stdin` | Same as `--paste`, but reads from a pipe, e.g. `pbpaste \| node dist/cli.js login --stdin`. |
| `status` | Shows which account is logged in and whether Substack still accepts the session. |
| `logout [--all]` | Deletes the saved session. `--all` also deletes the login browser profile. |

How this improves on the Python version:

- **No manual cookie export or username.** The account and your subscriptions come from the session itself, so subscriptions hidden from your public profile show up too.
- **Checked before it's saved.** A cookie that Substack rejects never gets written to disk.
- **Easy refresh.** The browser login keeps its own profile, so when the session expires, `login` usually finishes without you typing anything.
- **No restart needed.** The running server re-reads credentials on every call, so after `login` the next tool call just works.
- **Clear errors.** An expired session comes back as an MCP error that tells you to run `login`, not an empty result.
- **Cookie stays on Substack hosts.** It is only sent to `substack.com` and `*.substack.com`. Custom-domain publications get their own session through Substack's sign-in handoff, the same way your browser does it, so paid posts and subscription changes work there too. Redirects are followed manually so no cookie leaks to another host.
- **Private storage.** The session file is `~/.config/substack-reader/auth.json`, written with mode `600`.

The browser login uses your installed Chrome or Edge through `playwright-core`, which is an optional dependency. If neither is available, set `SUBSTACK_BROWSER_PATH`, run `npx playwright install chromium`, or use `--paste`.

> **Email sign-in links:** if Substack emails you a link, copy it into the address bar of the window that `login` opened. Clicking it opens your normal browser instead.
>
> **Google sign-in** may refuse to run in an automated browser window. If it does, use Substack's email link or password option, or `--paste`.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `SUBSTACK_SID` | Session cookie value. Overrides the saved session (useful in CI or containers). |
| `SUBSTACK_COOKIE` | A full `Cookie:` header to take `substack.sid` from. |
| `SUBSTACK_READER_HOME` | Config directory (default `~/.config/substack-reader`). |
| `SUBSTACK_COOKIES_PATH` | Location of a legacy Cookie-Editor export (default `<config dir>/cookies.json`). |
| `SUBSTACK_USERNAME` | When logged out, `list_subscriptions` shows this user's *public* subscriptions. |
| `SUBSTACK_BROWSER_PATH` | Chromium-based browser to use for `login`. |

**Migrating from the Python version:** an existing `~/.config/substack-reader/cookies.json` is still read as a fallback. Run `login` once to move to the new store, then `install` to replace the old registration.

## Tools

| Tool | Description |
| --- | --- |
| `auth_status` | Whether you're logged in, as whom, and whether the session is still valid. |
| `list_subscriptions` | All your subscriptions, with URL and membership state. |
| `get_feed` | Recent posts across all subscriptions, newest first. Takes `limit`, `per_publication`, and `since` (`"7d"`, `"48h"`, or an ISO date). |
| `get_recent_posts` | Recent posts from one publication, with `offset` for paging. |
| `search_posts` | Keyword search in one publication's archive. |
| `read_post` | Full post as Markdown (or `text` / `html`). Long posts are split into pages; pass `start` to continue. Paywalled previews are flagged. |

| `list_chats` | Your chat inbox: publication chats you're in and direct messages, most recent first, with unread state. |
| `get_chat_threads` | Threads in a publication's chat, newest first, with reply counts. Pages back with `before`. |
| `read_chat_thread` | One chat thread with its replies and replies to replies, as a readable transcript. |
| `read_dm` | One of your direct-message conversations. |
| `subscribe` | Free-subscribe to a publication. Never starts a paid plan; does nothing if you're already subscribed. |
| `unsubscribe` | Remove a **free** subscription. Paid subscriptions are refused (cancel those yourself). An ambiguous name is rejected and the matches are listed. |

`subscribe` and `unsubscribe` change your account, so they're marked as write tools and Claude Code asks before running them. Each change is checked with Substack afterwards, and the tool reports what actually happened.

Publications can be given by name ("The Pragmatic Engineer"), part of a name, subdomain ("pragmaticengineer"), or URL. Posts can be given as any Substack post URL (`/p/slug`, `substack.com/home/post/p-123`, `open.substack.com/pub/...`) or a numeric post ID.

## Development

```bash
npm install
npm test          # vitest; runs against a fake fetch, no network
npm run typecheck
npm run build     # outputs dist/
```

Source layout:

```
src/
  cli.ts                 # entry point: serve / login / status / logout / install
  server.ts              # MCP tool definitions
  format.ts              # HTML → Markdown, paywall detection
  config.ts              # paths and constants
  auth/credentials.ts    # session storage and parsing of pasted cookies
  auth/login.ts          # browser and paste login flows
  substack/http.ts       # fetch wrapper: cookie scoping, redirects, retries, auth errors
  substack/api.ts        # Substack endpoints and normalization
```

## License

MIT
