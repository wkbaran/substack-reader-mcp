<div align="center">

# Substack Reader MCP

**Ask Claude what's new in your Substack subscriptions, and have it read the posts for you.**

![Node 20+](https://img.shields.io/badge/node-20%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF)
![Tools](https://img.shields.io/badge/tools-17%20%2B%205%20digest-informational)
![Jev](https://img.shields.io/badge/ranking-Jev%20decision%20model-orange)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

[Quick start](#quick-start) · [Tools](#tools) · [Daily digest](#daily-digest-with-hermes-agent) · [Headline ranking with Jev](#headline-ranking-with-jev) · [Logging in](#logging-in) · [Troubleshooting](#troubleshooting)

</div>

An MCP server for your own Substack account:

- **Read:** your subscriptions, a combined feed, full posts (including paid ones you have access to), and search.
- **Your reading activity:** reading history with how far you read each post, plus saved and hearted posts.
- **Chats:** publication chats and direct messages.
- **Act, when you ask:** subscribe to and unsubscribe from free newsletters.
- **Daily digest:** with [Hermes Agent](https://github.com/NousResearch/hermes-agent), a scheduled morning digest. [Jev](#headline-ranking-with-jev) can rank posts against your interests before they're read.
- **No API keys for Substack:** you log in once in a browser window.

## What it uses

| What | Needed? |
|---|---|
| Your [Substack](https://substack.com) account | Yes. Free and paid subscriptions both work |
| Node.js 20+ | Yes |
| Chrome or Edge | Only for the browser login (you can paste a cookie instead) |
| A [Jev](docs/jev/README.md)-style decision model | Optional. Ranks digest posts against your interests in a few seconds. Any provider with the same decisions API works, set by URL, key and model like an OpenAI-compatible client. The default is TypeSafe's Jev on [OpenRouter](https://openrouter.ai/typesafe/jev-1.13), about $0.03 per 1,000 posts |
| An MCP client | Claude Code, Claude Desktop, Cursor, VS Code, Hermes Agent… |

Substack has no public API. The server calls the endpoints substack.com uses, with your session, so it sees only what you see logged in.

## Quick start

```bash
git clone https://github.com/wkbaran/substack-reader-mcp.git
cd substack-reader-mcp
npm install && npm run build

node dist/cli.js login     # a browser window opens; sign in to Substack as usual
node dist/cli.js install   # registers the server with Claude Code
```

Restart Claude Code, then try:

- *"What's new in my Substack feed this week?"*
- *"Summarize the latest post from The Pragmatic Engineer."*
- *"Which of my saved posts did I never finish?"*
- *"What are people talking about in Nate's subscriber chat?"*
- *"Propose an interests.md from my Substack activity."*

<details>
<summary><b>Other MCP clients</b> (Claude Desktop, Cursor, VS Code)</summary>

Point the client at `dist/cli.js` with an absolute path, after running `login`:

```json
{ "mcpServers": { "substack-reader": { "command": "node", "args": ["/absolute/path/to/substack-reader-mcp/dist/cli.js"] } } }
```

- **Claude Desktop:** `claude_desktop_config.json` (Settings → Developer → Edit Config)
- **Cursor:** `~/.cursor/mcp.json`
- **VS Code:** `.vscode/mcp.json`, using `"servers"` instead of `"mcpServers"` and adding `"type": "stdio"`
- **Claude Code, manually:** `claude mcp add --scope user substack-reader -- node /absolute/path/to/dist/cli.js`
</details>

## Tools

How to name things:

- **Publications:** a name, part of a name (*"pragmatic"*), subdomain or URL.
- **Posts:** any Substack link, or a post id.

**Reading** (all read-only)

| Tool | What it returns |
|---|---|
| `get_feed` | Recent posts across all subscriptions, newest first. `since` takes `"7d"`, `"48h"` or a date |
| `read_post` | A full post as Markdown. Paid posts you can't access are flagged as previews |
| `get_recent_posts` · `search_posts` | One publication's latest posts · keyword search within one publication |
| `list_subscriptions` | Every subscription, including hidden ones, with membership |
| `get_reading_history` | Posts you opened on the web or in the app, with **how far you read each one**, and whether you hearted or saved it |
| `get_saved_posts` · `get_liked_posts` | Posts you saved · posts you hearted |
| `interests_evidence` | What your activity says about your taste, for [drafting an interests.md](docs/classifier.md#proposing-an-interestsmd-from-your-activity) |
| `auth_status` | Who you're logged in as, and whether the session works |

**Chat** (read-only; Substack's unread flags aren't reliable, so these work by activity time)

| Tool | What it returns |
|---|---|
| `list_chats` | Publication chats you're in, and direct messages |
| `get_chat_activity` | Chats and DMs with activity since a time, optionally with the new messages |
| `get_chat_threads` · `read_chat_thread` · `read_dm` | A chat's threads · one thread with its replies · one DM conversation |

**Account changes** (clients ask first; the server re-checks with Substack afterwards)

| Tool | What it does |
|---|---|
| `subscribe` | Free-subscribes you. Never starts a paid plan |
| `unsubscribe` | Removes a **free** subscription. Anything with a payment attached is refused |

**Digest** (only when `SUBSTACK_DIGEST_DIR` is set; plain-text output for agent harnesses)

| Tool | What it does |
|---|---|
| `digest_begin` | Fetches every new post and chat activity, and returns a work list with refs (`P1`, `P2`, …) |
| `digest_finish` | Takes a verdict per post and chat, renders the message and saves state. Safe to repeat |
| `digest_status` · `mark_reported` | Inspect the state · repair it |
| `save_interests_proposal` | Saves a drafted `interests.md` as `interests.proposed.md`, never over the real one |

A worked example of a whole run, with each tool's arguments and output: [docs/digest-tools.md](docs/digest-tools.md).

## Daily digest with Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) runs skills on a schedule and delivers to Discord and other chats. [`hermes/SKILL.md`](hermes/SKILL.md) turns this server into a morning digest:

- **What it covers:** every new post in your subscriptions, plus chats and DMs with new activity.
- **How it reads:** subagents read every post in full.
- **What you get:** one message, with:
  - picks worth reading in full, each with a summary and a reason
  - everything else, grouped by publication
  - chats, with anything addressed to you first
- **What the model does:** only the judging. Fetching, retries, state and layout are code, so the whole digest can run on a local 27B model.

**Setup**

1. **Build** (`npm ci && npm run build`) and copy `dist/`, `package.json` and `package-lock.json` to where Hermes can see them, e.g. `/opt/data/mcp/substack-reader-mcp`. Then run `npm ci --omit=dev --omit=optional` there.
2. **Log in** on a machine with a browser (`node dist/cli.js login`), then copy `~/.config/substack-reader/auth.json` to the Hermes host, e.g. `/opt/data/mcp/substack-reader-home/`.
3. **Register the server** in Hermes's `config.yaml`:
   ```yaml
   mcp_servers:
     substack-reader:
       command: node
       args: ["/opt/data/mcp/substack-reader-mcp/dist/cli.js"]
       env:
         SUBSTACK_READER_HOME: /opt/data/mcp/substack-reader-home
         SUBSTACK_DIGEST_DIR: /opt/data/sandbox/substack_digest   # absolute; created if needed
         SUBSTACK_DIGEST_TZ: America/Denver
         # SUBSTACK_CLASSIFIER: jev                               # optional; see below
         # SUBSTACK_JEV_API_KEY: ${JEV_OPENROUTER_API_KEY}        # from Hermes's .env
         # SUBSTACK_JEV_URL: https://openrouter.ai/api/alpha/decisions   # the default; any decisions-API endpoint
   ```
4. **Install the skill:** copy `hermes/SKILL.md` to `skills/productivity/substack-digest/` and `hermes/substack_digest_start.sh` to `scripts/`. Then edit the skill's Settings block. Optionally add an `interests.md` to the digest directory (from `hermes/interests.example.md`, or [drafted from your activity](docs/classifier.md#proposing-an-interestsmd-from-your-activity)).
5. **Schedule it** (run as the `hermes` user). The job needs only the `delegation` toolset and this server:
   ```bash
   hermes cron create "0 7 * * *" "Run the substack-digest skill and deliver the digest." \
     --name substack-digest --skill substack-digest --script substack_digest_start.sh --deliver discord:<channel-id>
   ```

More detail is in **[docs/digest.md](docs/digest.md)**: why the server has harness-specific tools, customizing, state, rate limits, chats and cost.

## Headline ranking with Jev

> **Optional here, and off by default.**
> - **Your Substack feed is only what you subscribe to,** so it's already curated, and the digest can afford to read every post.
> - **This classifier was built for [medium-reader-mcp](https://github.com/wkbaran/medium-reader-mcp),** where the feed is effectively endless (100–200 new posts a day from writers you never chose), and was carried over here.

What it still adds on Substack:

- **[Jev](docs/jev/README.md)** is a "decision model" from TypeSafe. It returns typed answers with probabilities, not text. Before anything is read, it gives every post:
  - a **rank** (how much you'd want it, judged against `interests.md`)
  - a **skip** probability (whether it matches your Skip list)
- **In the digest:**
  - Posts are read best-first, and the rank informs the "Read in full" picks.
  - Confident skips (say, podcast show notes) aren't read at all.
  - With `SUBSTACK_DIGEST_RANK_FLOOR`, low-ranked posts become optional, which helps if your subscription list grows.
- **Backends** (`SUBSTACK_CLASSIFIER`):
  - **`off`** (default).
  - **`jev`**: ranks and skips. The server calls the decisions API itself over HTTPS, not through sampling.
  - **`sampling`**: skips only. The server asks your MCP client's own model to rate each headline, which is what *MCP sampling* means: the server borrows the client's LLM rather than having its own. It doesn't rank, so ordering is left to the agent's model.
- **Any Jev-style provider:** the `jev` backend speaks the decisions API (POST `model`, `state`, `questions` → `answers`), and you point it at a provider the way you'd point an OpenAI-compatible client at a local model:
  - `SUBSTACK_JEV_URL`: the endpoint. Default: OpenRouter's `https://openrouter.ai/api/alpha/decisions`. TypeSafe's System One API (`…/v1/systemone`) and compatible or self-hosted servers work too.
  - `SUBSTACK_JEV_API_KEY`: the bearer token (falls back to `OPENROUTER_API_KEY`). It can be empty for a server without auth.
  - `SUBSTACK_JEV_MODEL`: the model id. Default `typesafe/jev-1.13`; TypeSafe's own API uses `jev-1.13`.
- **Tune it to you:**
  - Label your own posts with one keypress each, and the tools recommend thresholds and edits to `interests.md`.
  - The tools can also draft an `interests.md` from what you pay for, save, heart, finish and dismiss.

Everything about it is in **[docs/classifier.md](docs/classifier.md)**.

## Logging in

- **Browser (default):** `login` opens Chrome or Edge on Substack's sign-in page. The session is saved as soon as you're in and lasts about three months. Re-running `login` usually needs no typing.
- **Paste:** `login --paste` (or `--stdin`) takes the `substack.sid` cookie in any format: the bare value, a `Cookie:` header, a Cookie-Editor export, or `cookies.txt`.
- **No restart needed:** the server re-reads the session on every call.
- **Tips:**
  - If Substack emails you a sign-in link, paste it into the `login` window.
  - Google sign-in sometimes refuses an automated window; use email or password instead.

| Command | What it does |
|---|---|
| `node dist/cli.js login` | Log in (`--paste` / `--stdin` to paste the cookie) |
| `node dist/cli.js status` | The logged-in account, subscription count, and whether the session works |
| `node dist/cli.js logout` | Delete the session (`--all` also deletes the login browser profile) |
| `node dist/cli.js install` | Register with Claude Code (`--scope user\|project\|local`) |

<details>
<summary><b>Environment variables</b></summary>

| Variable | Purpose |
|---|---|
| `SUBSTACK_SID`, `SUBSTACK_COOKIE` | Session cookie, overriding the saved session (containers, CI) |
| `SUBSTACK_READER_HOME` | Config directory (default `~/.config/substack-reader`) |
| `SUBSTACK_BROWSER_PATH` | A Chromium-based browser for `login` |
| `SUBSTACK_USERNAME` | When logged out, `list_subscriptions` shows this user's public subscriptions |
| `SUBSTACK_COOKIES_PATH` | A Cookie-Editor export from the original Python version, read as a fallback |
| `SUBSTACK_DIGEST_DIR` | Absolute path of the digest directory; setting it turns on the digest tools |
| `SUBSTACK_DIGEST_TZ` | Time zone for digest and chat times (default UTC) |
| `SUBSTACK_CLASSIFIER` | `off` (default), `jev` or `sampling` |
| `SUBSTACK_JEV_URL` | Decisions-API endpoint for `jev` (default OpenRouter's) |
| `SUBSTACK_JEV_API_KEY` | Bearer token for that endpoint (default `OPENROUTER_API_KEY`) |
| `SUBSTACK_JEV_MODEL` | Model id (default `typesafe/jev-1.13`) |
| `SUBSTACK_DIGEST_SKIP_THRESHOLD` | Skip probability at which a post is set aside (default 0.7) |
| `SUBSTACK_DIGEST_RANK_FLOOR` | Rank below which reading a post is optional (default off) |

</details>

## Privacy and security

- **Your session goes only to `substack.com` and `*.substack.com`.** Custom-domain publications get their own session through Substack's sign-in handoff, as in a browser. Redirects are followed one hop at a time, so no cookie reaches another host.
- **It's stored in `~/.config/substack-reader/auth.json`**, mode `600`. Nothing is stored in the repo.
- **No telemetry.** Requests go only to Substack, to the publications you ask about, and to your Jev provider if it's on (headlines and your interests only).
- **Only `subscribe` and `unsubscribe` change anything,** and only free subscriptions.
- **Reading activity is read, never changed.** The endpoints that mark posts as seen or saved are never called.
- **`package-lock.json` pins every dependency;** install with `npm ci`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| *"Not logged in"* / *"session was rejected"* | `node dist/cli.js login` (sessions last about three months) |
| *"Only a preview was returned"* | No paid subscription to that publication, or the session expired; `status` checks |
| The server doesn't appear in `/mcp` | Restart Claude Code |
| `login` can't find a browser | Install Chrome, set `SUBSTACK_BROWSER_PATH`, or use `--paste` |
| *"doesn't look like a Substack publication"* | The newsletter may have left Substack |
| The digest says `CLASSIFIER: … unavailable` | For `jev`, check `SUBSTACK_JEV_URL` and the key; for `sampling`, the client's sampling setup |

## Development

```bash
npm ci && npm test     # vitest against a fake fetch; no network needed
npm run typecheck && npm run build
```

- **`src/substack/`**: the HTTP client, posts, subscriptions, reader shelves and chat.
- **`src/digest/`**: the digest tools.
- **`src/classifier/`**: the headline classifier, shared with [medium-reader-mcp](https://github.com/wkbaran/medium-reader-mcp).
- **`tools/classifier/`**: label, score, analyze, propose.
- **[CLAUDE.md](CLAUDE.md)**: how Substack's endpoints actually behave, including look-alikes that write. Read it before changing `src/substack/`.

## Disclaimer

An independent project, not affiliated with or endorsed by Substack or TypeSafe. It uses Substack's undocumented web endpoints, which can change without notice. Use it with your own account, within Substack's [Terms of Use](https://substack.com/tos).

## License

[MIT](LICENSE) © 2026 Bill Baran.
