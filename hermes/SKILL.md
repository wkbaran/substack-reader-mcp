---
name: substack-digest
description: Digest of every new Substack post and chat activity since the last run, each post read in full by subagents, with picks worth reading deeply. Uses the substack-reader MCP server's digest tools.
version: 3.2.0
platforms: [linux]
metadata:
  hermes:
    tags: [substack, reading, digest]
    category: productivity
---

# Substack Digest

## Settings
Edit these for your setup. The rest of this skill refers to them by name.

- `MAX_PARALLEL`: `2`. How many tasks one `delegate_task` call may run at once. Use your Hermes delegation concurrency limit.
- `REAUTH`: "Run `node dist/cli.js login` in substack-reader-mcp on a machine with a browser, then copy the new `auth.json` into the directory `SUBSTACK_READER_HOME` points to on the Hermes host." This is the message sent when the session has expired.

The state directory and time zone are not set here. They are the server's `SUBSTACK_DIGEST_DIR` and `SUBSTACK_DIGEST_TZ` environment variables (see the README).

## When to Use
Scheduled (cron) or on request: "what's new on Substack", "Substack digest", "anything worth reading?".

## Tools
- From the substack-reader MCP server: `digest_begin`, `digest_finish`, `get_chat_activity`, `read_post`. They may be listed with an `mcp_substack_reader_` prefix.
- `delegate_task` to read posts and chats in batches. Subagents inherit the substack-reader tools.
- Nothing else. **Never read or edit the digest's state files** (`state.json` and the run files): the server keeps them. Don't use `read_file`, `write_file`, `patch`, `terminal` or `execute_code`.
- Call the MCP tools one per `tool_call`. A batch of several calls is rejected ("takes exactly one entry") and the retry wastes a turn. Subagents follow the same rule.

## Procedure

### 1. Begin
Call `digest_begin` with no arguments.
- If it reports an auth problem ("Authentication required", "Not logged in", "session was rejected"), stop and reply with only: "📬 Substack digest skipped — session expired. <REAUTH>"
- Otherwise it returns plain text: a `RUN_ID`, one line per new post (`P1 | title | publication | date | access | type | url`), the chats with activity (`C1 | chat id | name | activity | get_chat_activity arguments`), the user's interests, and a `NEXT:` line. Keep the `RUN_ID`; you need it in step 5.
- If the server's headline classifier is on, there's a `CLASSIFIER:` line, the POSTS lines carry a rank from 0 to 100 after the ref and are sorted best first, and there may be two more lists: **SKIPPED BY CLASSIFIER** (don't read these, and give them no entry) and **RANKED LOW** (read them only if every chunk under POSTS is done; posts without an entry are listed as "Also new").
- Don't filter or re-rank the POSTS list yourself. Every post under POSTS gets read.

### 2. Read every post, in batches of subagents
Split the posts listed under POSTS (not the skipped or ranked-low ones) into chunks of **5**, in the order listed. Call `delegate_task` with `tasks=[…]` of **at most `MAX_PARALLEL` tasks per call**, and keep calling it until every chunk is done. For example, 23 posts make 5 chunks, which take 3 `delegate_task` calls with `MAX_PARALLEL` 2.

Give each task this goal, with its refs listed. **List only the refs, exactly as `digest_begin` numbered them (for example `P6, P7, P8, P9, P10`).** Don't renumber them, and don't add titles or URLs: `read_post` looks each ref up on the server, so a ref always fetches the post it names.

> For each ref below, call `read_post` with `url` set to the ref exactly as given (for example `"P3"`) and `max_chars: 40000`. The header's `- Digest ref:` line confirms which post you got. If the response says there is more, call `read_post` again with the given `start` until you reach the end. Don't skim, and don't summarize from the title. Call one tool per `tool_call`, and write no files. For each post, return exactly this block and nothing else:
>
> ```
> REF: [the ref exactly as given, e.g. P3]
> ACCESS: full | preview-only
> TYPE: essay | reporting | analysis | tutorial | link-roundup | announcement | podcast-notes | fiction | other
> GIST: [2–3 sentences: the actual argument or findings, not the topic]
> DEPTH: [1–5, how much is lost by reading only the gist: 5 = dense original thinking or evidence that doesn't compress; 1 = the gist covers it]
> WHY: [one sentence justifying DEPTH, naming what's distinctive]
> ```
>
> `ACCESS` is `preview-only` when `read_post`'s header says "Only a preview was returned". If `read_post` fails for a ref, return its block with `GIST: (could not read: [error])` and `DEPTH: 0`.

If a chunk comes back missing posts, retry **that chunk once** in the next `delegate_task` call. After that, keep whatever came back. Don't read posts yourself in the main session.

### 3. Chats
If `digest_begin` listed chats with activity, send one more `delegate_task` batch (at most `MAX_PARALLEL` tasks, chats split evenly between them) with this goal:

> For each chat, call `get_chat_activity` once with exactly the arguments given for it. Never post or reply. Return one block per chat:
>
> ```
> CHAT_ID: [chat id]
> TOPICS: [1–3 sentences on what's being discussed]
> FOR_USER: [any question or mention directed at the user, else "none"]
> POSTS_DISCUSSED: [URLs or titles of posts people are discussing, else "none"]
> ```

### 4. Rank
Choose the **picks** ("Read in full") from the post blocks:
- Start with DEPTH 4–5. Rank up posts that match the interests from `digest_begin` (and anything you remember about the user), posts with a high classifier rank, and posts that appear in a chat's POSTS_DISCUSSED.
- Rank down link-roundups, announcements and podcast-notes, whatever their DEPTH.
- Rank down posts whose ACCESS is `preview-only`: a gist of a teaser isn't a reason to read the whole post.
- At most 2 picks per publication. Usually 3–7 picks; on a genuinely strong day, more. If nothing is strong, pick none rather than padding.

### 5. Finish
Call `digest_finish` once:
- `run_id`: the `RUN_ID` from step 1.
- `posts`: **one entry per post** from step 1, picks first in the order you want them shown:
  - pick: `{"ref": "P3", "section": "pick", "gist": "<1–2 sentences>", "why": "<WHY>", "preview_only": <true|false>}`
  - everything else: `{"ref": "P7", "section": "other", "gist": "<one line>", "preview_only": <true|false>}`
  - couldn't read (DEPTH 0): `{"ref": "P9", "section": "unreadable", "error": "<error>"}`
- `chats`: one entry per chat: `{"id": "<chat id>", "topics": "<TOPICS>", "for_user": "<FOR_USER>"}`.

The server checks the entries, lays out the message (sections, counts, paid and preview markers, publications it couldn't check) and saves state. If it returns an error about the `run_id` or a state change, call `digest_begin` again and start over. If it lists warnings, the message still went through; don't call it again.

### 6. Reply
`digest_finish` returns a few status lines, then a line starting `===== DIGEST`, then the message. **Your reply is exactly the text after that line, copied unchanged: its first characters are `📬 **Substack**`, or the whole reply is `[SILENT]`.** Write nothing before it ("State saved", "Here's the digest", ranking notes) and nothing after it. Don't rewrite, reorder or shorten it.

## Pitfalls
- Never call `subscribe` or `unsubscribe`. Never reply in chats or DMs.
- Don't open substack.com chat pages in a browser: loading them clears the user's unread badges. The MCP tools don't.
- `paid` in the post list describes the post, not the user's access; the user may pay for it. Take access from `read_post`'s "Only a preview was returned" note.
- Paid podcasts often have only ~50 words of show notes. Mark them TYPE `podcast-notes`; that's expected, not a read failure.
- `digest_status` and `mark_reported` are for a person debugging the digest, not for a normal run.
