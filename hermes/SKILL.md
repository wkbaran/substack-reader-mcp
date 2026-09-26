---
name: substack-digest
description: Digest of every new Substack post and unread chat/DM since the last run, each read in full by subagents, with picks worth reading deeply. Uses the substack-reader MCP server.
version: 2.1.0
platforms: [linux]
metadata:
  hermes:
    tags: [substack, reading, digest]
    category: productivity
---

# Substack Digest

## Settings
Edit these for your setup. The rest of this skill refers to them by name.

- `STATE_DIR`: `/opt/hermes-sandbox/substack_digest`. Where the state and interests files live. It must be writable by the agent: if `HERMES_WRITE_SAFE_ROOT` is set, it has to be inside it.
- `TIMEZONE`: `UTC`. An IANA name such as `America/Denver` or `Europe/Berlin`, used only to show the "since" time in the header.
- `MAX_PARALLEL`: `2`. How many tasks one `delegate_task` call may run at once. Use your Hermes delegation concurrency limit.
- `REAUTH`: "Run `node dist/cli.js login` in substack-reader-mcp on a machine with a browser, then copy the new `auth.json` into the directory `SUBSTACK_READER_HOME` points to on the Hermes host." This is the message sent when the session has expired.

## When to Use
Scheduled (cron) or on request: "what's new on Substack", "Substack digest", "anything worth reading?".

## Tools
- The substack-reader MCP tools: `auth_status`, `get_feed`, `read_post`, `list_chats`, `get_chat_threads`, `read_chat_thread`, `read_dm`. They may be listed with an `mcp_substack_reader_` prefix.
- `delegate_task` to read posts and chats in batches. Subagents inherit the substack-reader tools.
- `read_file` / `write_file` / `patch` for state. Only write inside `STATE_DIR`.
- Don't use `terminal` or `execute_code`, and don't invoke `hermes` as a shell command.

## State
Substack has no read/unread flag for posts, so "unread" means **published since the last digest and not yet reported**.

State file: `STATE_DIR/state.json`, **pretty-printed with `indent=2`**:

```json
{
  "last_run": "2026-09-25T13:00:00Z",
  "reported_posts": [
    "https://example.substack.com/p/slug"
  ]
}
```

- If the file is missing or unreadable, treat it as the first run: `last_run` = 48 hours ago, and `reported_posts` is empty.
- Keep only the most recent 500 URLs in `reported_posts`.
- Write the file **only after** the digest is complete, so a failed run is picked up next time.
- `last_run` is always the run's **start** time, never the time you finish or an estimate. On cron runs, copy `RUN_STARTED_AT` from the script output at the top of the prompt, exactly. When run by hand without that line, note the current UTC time before step 1 and use that.
  Overlap between runs is fine, because `reported_posts` removes repeats. A cutoff that's too late silently loses posts.

Optional interests file: `STATE_DIR/interests.md`. It's free text the user maintains. Read it if it exists and use it, together with anything you remember about the user, when ranking. If it's missing, use memory alone.

## Procedure

### 1. Auth
Call `auth_status`. If the session is missing or rejected, stop and send only:
"📬 Substack digest skipped — session expired. <REAUTH>"

### 2. Collect every new post
Call `get_feed` with `since` = `last_run`, `limit: 200`, and `per_publication: 20`.
- Drop any post whose URL is already in `reported_posts`.
- If any publication returned exactly 20 posts, it may have more. Call `get_recent_posts` for that publication with `offset` (20, 40, …) until the posts are older than `last_run`.
- Build the work list: `{url, title, publication, date, paywalled}` for **every** remaining post. Don't filter or pre-rank here; every post gets read.

### 3. Read every post, in batches of subagents
Split the work list into chunks of **5 posts**. Call `delegate_task` with `tasks=[…]` of **at most `MAX_PARALLEL` tasks per call**, and keep calling it until every chunk is done. For example, 23 posts make 5 chunks, which take 3 `delegate_task` calls.

Give each task this goal, with its 5 posts listed in the context:

> Read each of these Substack posts in full with `read_post` (`max_chars: 40000`). If the response says there is more, call `read_post` again with the given `start` until you reach the end. Don't skim, and don't summarize from the title. For each post, return exactly this block and nothing else:
>
> ```
> URL: <url>
> TITLE: <title> | PUB: <publication> | ACCESS: full | preview-only
> TYPE: essay | reporting | analysis | tutorial | link-roundup | announcement | podcast-notes | fiction | other
> GIST: <2–3 sentences: the actual argument or findings, not the topic>
> DEPTH: <1–5, how much is lost by reading only the gist: 5 = dense original thinking or evidence that doesn't compress; 1 = the gist covers it>
> WHY: <one sentence justifying DEPTH, naming what's distinctive>
> ```
>
> If `read_post` fails for a post, return its block with `GIST: (could not read: <error>)` and `DEPTH: 0`.

Rules:
- Collect all the blocks as you go. If a chunk comes back missing posts or with errors, retry **that chunk once** in the next `delegate_task` call. After that, keep whatever blocks came back.
- Don't read posts yourself in the main session. Your context is reserved for combining the results.

### 4. Chats
Call `list_chats`. Collect the items with unread state:
- `publication_chat`: note its id and publication.
- `direct_message`: note its id and the other person.

If any items are unread, send one more `delegate_task` batch (up to 2 tasks, splitting the items evenly between them) with this goal:

> For each chat: for a publication chat, call `get_chat_threads`, then `read_chat_thread` on every thread that is unread or newer than <last_run>. For a DM, call `read_dm`. Never post or reply. Return one block per chat:
>
> ```
> CHAT: <publication chat name, or "DM with <name>">
> TOPICS: <1–3 sentences on what's being discussed>
> FOR_USER: <any question or mention directed at the user, else "none">
> POSTS_DISCUSSED: <URLs or titles of posts people are discussing, else "none">
> ```

### 5. Rank and recommend
From all the post blocks, choose the **"Read in full"** picks:
- Start with DEPTH 4–5. Rank up posts that match the user's interests, and posts that appear in a chat's POSTS_DISCUSSED.
- Rank down link-roundups, announcements, and podcast-notes, whatever their DEPTH.
- Take at most 2 picks per publication. Usually pick 3–7; if it's genuinely a strong day, you can pick more. If nothing is strong, say so rather than padding the list.

### 6. Send the digest
Format it for Discord. Keep each line short.

```
📬 **Substack** — <N> new posts, <M> unread chats (since <last_run in TIMEZONE>)

⭐ **Read in full**
1. **<Title>** — <Publication> [paid] (preview only)
   <GIST, trimmed to 1–2 sentences>
   _Why:_ <WHY>
   <url>

📰 **Everything else**
**<Publication>**
• <Title> — <one-line gist> <url>

💬 **Chats**
• <CHAT>: <TOPICS> ← _<FOR_USER, if any>_
```

- Every new post appears exactly once, either in ⭐ or in 📰. Group 📰 by publication.
- Put chats and DMs whose FOR_USER isn't "none" first in 💬.
- Mark `[paid]` for paywalled posts. Add `(preview only)` only when ACCESS is preview-only.
- List any posts that couldn't be read under "⚠ Couldn't read" at the end, with their URLs.
- If there are no new posts and no unread chats, answer `[SILENT]`. Still update `last_run` first.

### 7. Update state
Write `state.json`, pretty-printed with `indent=2`. Set `last_run` to the run's start time (`RUN_STARTED_AT`), copied exactly. Set `reported_posts` to the previous list plus every URL included in this digest, trimmed to the newest 500. Copy the existing entries exactly as read; don't retype them from memory. If the write fails twice, stop trying and add "⚠ state not saved; the next digest may repeat posts" to the end of the message.

## Pitfalls
- Never call `subscribe` or `unsubscribe`. Never reply in chats or DMs.
- Don't open substack.com chat pages in a browser: loading them clears the user's unread badges. The MCP tools don't.
- `paywalled: true` describes the post, not the user's access; the user may pay for it. Take access from `read_post`'s "Only a preview was returned" note.
- Paid podcasts often have only ~50 words of show notes. Mark them TYPE `podcast-notes`; that's expected, not a read failure.
- Your final message is the digest (or `[SILENT]`) and nothing else. Don't end the run with a status line like "reading batch 3 now". If the digest isn't finished, keep working.

## Verification
- Count the posts in the digest (⭐ + 📰 + ⚠). It must equal the work-list size from step 2.
- Every URL in the digest came from a tool result.
- `state.json` has a newer `last_run`.
