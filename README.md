<div align="center">

# Substack Reader MCP

**Ask Claude what's new in your Substack subscriptions, and have it read the posts for you.**

An MCP server that gives Claude (and any other MCP client) access to your Substack account: your subscriptions, a combined feed, full posts including paid ones you have access to, search, publication chats, and direct messages. It can also subscribe you to free newsletters and unsubscribe you from them. You log in once in a browser window; no API keys or cookie exporting.

![Node 20+](https://img.shields.io/badge/node-20%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF)
![Tools](https://img.shields.io/badge/tools-13%20%2B%204%20digest-informational)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

[Quick start](#quick-start) · [Other clients](#other-mcp-clients) · [Tools](#tools) · [Hermes Agent](#hermes-agent) · [Logging in](#logging-in) · [Privacy and security](#privacy-and-security) · [Troubleshooting](#troubleshooting)

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
| `get_reading_history` | Posts you've opened on substack.com or in the app, most recent first, with **how far you read each one** (0–1), and whether you hearted or saved it. Posts read only by email don't appear |
| `get_saved_posts` | Posts you saved for later |
| `get_liked_posts` | Posts you hearted |
| `interests_evidence` | What your own activity says about your taste (paid and free subscriptions, saves, hearts, what you finished or abandoned, what you dismissed, and with the digest on, its picks and your labels), with rules for drafting an `interests.md` from it. See [Proposing an interests.md](docs/classifier.md#proposing-an-interestsmd-from-your-activity) |

### Chat

| Tool | What it returns |
|---|---|
| `list_chats` | Your chat inbox: publication chats you're in and direct messages. Substack's unread flags here aren't reliable |
| `get_chat_activity` | Chats and DMs with activity since a time (`"24h"`, an ISO time), and with `transcripts` only the new messages |
| `get_chat_threads` | Threads in a publication's chat, newest first, with reply counts. `before` pages back |
| `read_chat_thread` | A thread with its replies and replies to replies, as a readable transcript |
| `read_dm` | One direct-message conversation |

### Digest (opt-in)

Registered only when `SUBSTACK_DIGEST_DIR` is set. They're built for scheduled digests run by an agent harness such as [Hermes Agent](#hermes-agent) ([why](#why-this-server-has-tools-just-for-agent-harnesses)), and return plain text.

| Tool | What it does |
|---|---|
| `digest_begin` | Fetches every post since the last digest (minus ones already reported) and the chats with new activity, saves the work list, and returns it with a run id and post refs (`P1`, `P2`, …). Doesn't change the state |
| `digest_finish` | Takes the model's verdict on each post (`pick`, `other`, `unreadable`, with a gist) and chat, lays out the final message and saves the state. Same `run_id` twice is harmless; `dry_run` saves nothing |
| `digest_status` | The last run, reported-post count, publications waiting to be re-checked, and recent runs (read-only) |
| `mark_reported` | Manual repair: adds post URLs to the reported list and optionally sets `last_run` |

With the digest tools on, `read_post` also accepts a ref from the current run (`P3`), and its header then includes a `Digest ref:` line.

### Account changes

| Tool | What it does |
|---|---|
| `subscribe` | Free-subscribes you to a publication. Never starts a paid plan; does nothing if you're already subscribed |
| `unsubscribe` | Removes a **free** subscription. Paid subscriptions are refused, and an ambiguous name lists the matches instead of guessing |

Apart from the digest tools, every tool except these two is marked read-only. These two are marked as changing your account, so MCP clients ask before running them, and `unsubscribe` is also marked destructive. After each change the server checks with Substack and reports what actually happened.

## Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is Nous Research's open-source, self-hosted agent harness: it runs skills on a schedule, hands work to subagents and delivers the results to chat platforms such as Discord. This section is written for Hermes, but it applies to any agent harness that works the same way. Nothing in the digest tools depends on Hermes; only [`hermes/SKILL.md`](hermes/SKILL.md) does.

### Why this server has tools just for agent harnesses

Everything above is a general MCP server that works in any client. A scheduled, unattended digest is a different job from a person asking questions in a chat: there's nobody to notice a mistake, every turn costs money, and the run ends the moment the model sends its last message. So the server has four extra [digest tools](#digest-opt-in), switched on by `SUBSTACK_DIGEST_DIR`, that take on everything that doesn't need judgment. Clients that don't set it see the general tools unchanged.

What that buys:

- **The model only judges.** Fetching, deduplication, rate-limit retries, time zones, laying out the message and saving state are code. They come out the same on every run and cost no tokens.
- **State can't be lost.** `digest_finish` saves state before it returns the message, so a run that ends as soon as the agent replies has already saved. The agent needs no file tools at all. Before these tools, the sibling [Medium digest](https://github.com/wkbaran/medium-reader-mcp) once sent its digest and never saved state, and spent half of another run's budget on refused file writes.
- **Summaries can't land on the wrong post.** `digest_begin` numbers the posts (`P1`, `P2`, …), and `read_post` and `digest_finish` take those refs. A subagent reads by ref, so even if the agent shuffles the numbers, each ref still fetches the post it names.
- **Output fits the harness.** The tools return compact plain text under 40,000 characters, because Hermes wraps MCP results in JSON and stops passing results over about 50,000 characters to the model.
- **Smaller models are enough.** Because code handles everything that needs to be exact, the whole Substack digest, main session and subagents, runs on a local 27B model.

A general MCP server makes an account readable by any agent. A few tools shaped for how a harness actually runs make both the server and the harness much more effective than either is alone.

### The daily digest

[`hermes/`](hermes/) contains a skill that turns this server into a scheduled Substack digest. Each morning it collects every post published since the last run in your subscriptions, plus chats and DMs with new activity. Subagents read every post in full, and it sends one message: the posts worth reading in full (with a two-line summary and why), everything else grouped by publication, and a summary of your chats that puts anything addressed to you first.

The model only does the judging. Everything deterministic is done by the digest tools: `digest_begin` fetches and dedups the posts and writes the work list, and `digest_finish` takes the model's summaries and picks, lays out the final message, and saves the state. The skill never touches a file.

#### Setup

1. **Build the server** on your machine (`npm ci && npm run build`). Copy `dist/`, `package.json` and `package-lock.json` to a directory the Hermes container can see (for example `$HERMES_HOME/mcp/substack-reader-mcp`, which is `/opt/data/mcp/substack-reader-mcp` inside the official image), and install the runtime dependencies there:
   ```bash
   npm ci --omit=dev --omit=optional
   ```
   Node 20 or later works, including the Node 26 in the Hermes image.
2. **Log in** on a machine with a browser (`node dist/cli.js login`), then copy `~/.config/substack-reader/auth.json` into a directory on the Hermes host, for example `$HERMES_HOME/mcp/substack-reader-home/`. Keep it at owner-only permissions.
3. **Register the server** in Hermes's `config.yaml`, with the digest tools switched on:
   ```yaml
   mcp_servers:
     substack-reader:
       command: node
       args: ["/opt/data/mcp/substack-reader-mcp/dist/cli.js"]
       env:
         SUBSTACK_READER_HOME: /opt/data/mcp/substack-reader-home
         SUBSTACK_DIGEST_DIR: /opt/data/sandbox/substack_digest
         SUBSTACK_DIGEST_TZ: America/Denver
         # SUBSTACK_CLASSIFIER: jev       # optional ranking classifier; see "Headline classifier"
         # OPENROUTER_API_KEY: sk-or-…
   ```
   `SUBSTACK_DIGEST_DIR` must be an absolute path the server's user can write. The server creates it if needed and keeps `state.json`, the run files and a lock file there. `SUBSTACK_DIGEST_TZ` is the IANA time zone for times shown in the digest (default UTC).
4. **Install the skill:** copy `hermes/SKILL.md` to `$HERMES_HOME/skills/productivity/substack-digest/SKILL.md`, and `hermes/substack_digest_start.sh` to `$HERMES_HOME/scripts/`. Optionally, copy `hermes/interests.example.md` to `$SUBSTACK_DIGEST_DIR/interests.md` and edit it (see below).
5. **Edit the Settings block** at the top of `SKILL.md`: `MAX_PARALLEL` and the `REAUTH` message.
6. **Restart Hermes and schedule it.** Cron times are in the Hermes host's local time. The job needs only the `delegation` toolset and this server (no `file` toolset):
   ```bash
   hermes cron create "0 7 * * *" "Run the substack-digest skill and deliver the digest." \
     --name substack-digest --skill substack-digest --script substack_digest_start.sh --deliver discord:<channel-id>
   hermes cron run <job-id>   # try it once now
   ```
   Run `hermes cron` commands as the user the gateway runs as (`docker exec -u hermes …` in the official image), so the files it writes keep the right owner.

#### Customizing

- **What gets picked:** `$SUBSTACK_DIGEST_DIR/interests.md` is text that `digest_begin` passes to the model on every run (the first 4,000 characters). Describe what you want more of under `## Interests`, and kinds of posts you never want under `## Skip` (see `hermes/interests.example.md`; a file without headings still works). With the [headline classifier](#headline-classifier) on, posts are also ranked against it before anything is read, and you can check the file against your own judgments with the tuning tools.
- **Sizes:** the chunk size (5 posts per subagent) is a plain instruction in the skill. `digest_begin` takes `max_posts` (default 100); posts beyond it carry over to the next run.
- **Output format:** the server lays out the message for Discord Markdown (`renderDigest` in `src/digest/render.ts`). `digest_finish` with `render: false` returns plain-text sections instead, for other destinations.
- **Schedule and delivery:** use `hermes cron edit <job-id> --schedule "…"` or `--deliver …`.

#### Things to know

- **Tool results over about 50,000 characters don't reach the model.** Hermes saves them to a file the model can't parse, and cron runs can't run scripts to help. The digest tools keep their output under 40,000 characters and as plain text (Hermes wraps MCP results in JSON, so JSON output would be escaped twice).
- **Reads everything:** the skill reads every new post, which suits a few dozen posts a day. With many more subscriptions, turn on the [headline classifier](#headline-classifier) and set a rank floor, so low-ranked posts become optional.
- **State:** `digest_finish` records every post in the run in `$SUBSTACK_DIGEST_DIR/state.json` (the newest 500 URLs), so posts never repeat, including ones that couldn't be read. Writes are atomic and locked. `digest_begin` writes only `current_run.json`, so a run that dies before `digest_finish` saves nothing and the next run covers the same period. A committed run is also kept as `runs/<run_id>.json` (the newest 14), as history for the classifier tools. `last_run` is the server's clock when `digest_begin` started fetching. Use `digest_status` to inspect the state and `mark_reported` to repair it; don't edit the file while a run is going.
- **Rate limits:** Substack answers 429 when it's asked for too many archives at once. `digest_begin` fetches 3 publications at a time, backs off 2, 5 and 10 seconds on a 429, and tries failed publications again after 15 and 30 seconds, within about 140 seconds in all (Hermes gives an MCP call 300). A publication that still fails is listed under "⚠ Couldn't check" and fetched from the same point next run; after 7 days the digest gives up on that period and says so.
- **Chats:** Substack's unread flags for chats are never set, so the digest uses activity since the last run instead: a thread counts when it was created or replied to after `last_run`. Only the first few pages of each chat's threads are checked, so a reply to a very old thread can be missed.
- **Read-only:** the skill never uses the tools that change your account.
- **Cost:** a test run made 12 model calls and took about 5 minutes on Claude Sonnet. Cost grows with the number of new posts, because every post is read in full.
- **Your own account:** this server uses Substack's undocumented web API with your session cookies. A daily digest is light, read-only use, but if Substack objects to automated access, it's your account at risk.

## Headline classifier

An optional step before anything is read: a classifier **ranks** every new post's headline against your `interests.md` and **sets aside** the ones that clearly match your Skip section. The digest still reads every post under POSTS, but in rank order, with the rank in hand when picking "Read in full". Skipped posts aren't read at all, and posts below an optional rank floor are read only if there's time. It's the part of the digest that encodes your taste, so it's a separate, swappable component (`src/classifier/`, shared with medium-reader-mcp).

- **Off by default.** Set `SUBSTACK_CLASSIFIER=jev` and `OPENROUTER_API_KEY` for [Jev](docs/jev/README.md), a decision model on OpenRouter that ranks and skips in a few seconds for about $0.03 per 1,000 posts. `sampling` (the MCP client's own model) can skip but not rank.
- **A first draft from your activity:** ask your agent to "propose an interests.md from my Substack activity". `interests_evidence` gathers what you pay for, save, heart, finish and dismiss, and `save_interests_proposal` saves the draft as `interests.proposed.md` beside your current file (or use `tools/classifier/propose.mjs`).
- **Tuning it to you:** `tools/classifier/` collects posts from your committed runs, lets you label them with one keypress each (`label.mjs`), scores them with the server's own classifier code, and analyzes the result (`analyze.mjs`). That gives recommended thresholds and the posts where your labels and `interests.md` disagree most, which is what to edit.

How it works, the setup, the tuning loop step by step, and how to add a backend: **[docs/classifier.md](docs/classifier.md)**.

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
| `SUBSTACK_DIGEST_DIR` | Absolute path of the digest's state directory. Setting it registers the digest tools |
| `SUBSTACK_DIGEST_TZ` | IANA time zone for times shown in digests and chat activity (default `UTC`) |

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
  substack/chat.ts       chat inbox, threads, replies, direct messages, activity since a time
  digest/collect.ts      digest_begin: fetch, dedup, write the run file
  digest/finish.ts       digest_finish, digest_status, mark_reported
  digest/render.ts       matching the model's verdicts to the run; the digest message
  digest/state.ts        state.json v2, atomic writes, the lock file, the runs/ archive
  classifier/            headline classifier (docs/classifier.md): types.ts (the interface),
                         jev.ts (Jev via OpenRouter), sampling.ts (MCP sampling), index.ts (backend from env)
  time.ts                relative times and time-zone formatting
tools/classifier/        label, score and analyze your own posts (docs/classifier.md)
test/                    one file per module, plus an in-memory MCP client test
```

[`CLAUDE.md`](CLAUDE.md) records how Substack's endpoints actually behave, including the ones that look right but aren't. Read it before changing anything under `src/substack/`.

## Disclaimer

An independent project, not affiliated with or endorsed by Substack. It uses Substack's undocumented web endpoints, which can change without notice. Use it with your own account, and within Substack's [Terms of Use](https://substack.com/tos).

## License

[MIT](LICENSE) © 2026 Bill Baran. Use, modify, and share it freely; keep the copyright notice.
