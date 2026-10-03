# The daily digest: details

The README covers setup. This page covers why the digest tools exist, how to customize the digest, and the behaviour worth knowing about.

## Why this server has tools just for agent harnesses

An unattended, scheduled digest is a different job from a person chatting: nobody notices mistakes, every turn costs money, and the run ends when the model sends its last message. So four extra tools (switched on by `SUBSTACK_DIGEST_DIR`) take over everything that doesn't need judgment:

- **The model only judges.** Fetching, deduplication, rate-limit retries, time zones, the message layout and saving state are code. They come out the same every run and cost no tokens.
- **State can't be lost.** `digest_finish` saves state before it returns the message, so the agent needs no file tools.
- **Summaries can't land on the wrong post.** Posts are numbered (`P1`, `P2`, …), and subagents read by ref. Even if the agent shuffles the numbers, each ref still fetches the post it names.
- **Output fits the harness.** Results are compact plain text under 40,000 characters. Hermes wraps MCP results in JSON and diverts anything over about 50,000 characters to a file the model can't read.
- **Smaller models are enough.** Because code handles everything that must be exact, the whole digest, main session and subagents, can run on a local 27B model.

## How a run works

1. **`digest_begin`** fetches every post published since the last run in your subscriptions, minus ones already reported, plus chats and DMs with new activity. With the [classifier](classifier.md) on, it also ranks the posts and sets aside confident skips. It writes the work list to `current_run.json`.
2. **Subagents read every post under POSTS**, five per subagent, by ref.
3. **The agent picks** the posts worth reading in full and summarizes the chats.
4. **`digest_finish`** lays out the message and saves state:
   - the picks, with summaries
   - everything else, grouped by publication
   - chats, with anything addressed to you first

## Customizing

- **What gets picked:** `interests.md` in the digest directory (the first 4,000 characters are shown to the model).
  - `## Interests`: what you want more of.
  - `## Skip`: kinds of post you never want. Only used when the classifier is on.
  - A file without these headings still works; all of it counts as Interests.
  - [Draft one from your activity](classifier.md#proposing-an-interestsmd-from-your-activity).
- **Chunk size** (5 posts per subagent) is a plain instruction in `hermes/SKILL.md`. `digest_begin` takes `max_posts` (default 100); the rest carry over to the next run.
- **Output:** Discord Markdown (`renderDigest` in `src/digest/render.ts`). `digest_finish` with `render: false` returns plain-text sections.
- **Schedule and delivery:** `hermes cron edit <job-id> --schedule "…"` or `--deliver …`.

## Things to know

- **It reads everything.** That suits a few dozen posts a day. With many more subscriptions, turn on the classifier and set a rank floor, so low-ranked posts become optional.
- **State:** `state.json` records every post in each run (the newest 500 URLs), so posts never repeat, including ones that couldn't be read.
  - Writes are atomic and locked.
  - `digest_begin` writes only `current_run.json`, so a run that dies early saves nothing; the next run covers the same period.
  - Committed runs are also kept as `runs/<run_id>.json` (newest 14), for the classifier tools.
  - Inspect with `digest_status`; repair with `mark_reported`.
- **Rate limits:** Substack returns 429 when asked for too many archives at once.
  - `digest_begin` fetches 3 publications at a time, backs off on 429s, and retries failures within about 140 seconds.
  - A publication that still fails is listed under "⚠ Couldn't check" and retried from the same point next run.
  - After 7 days the digest gives up on that period.
- **Chats:** Substack's unread flags are never set, so the digest counts a thread when it was created or replied to after the last run. Replies deep in very old threads can be missed.
- **Read-only:** the skill never uses `subscribe` or `unsubscribe`.
- **Cost:** a run on Claude Sonnet took 12 model calls and about 5 minutes. Cost grows with the number of new posts, because each one is read in full.
- **Your account:** this uses Substack's undocumented web API with your session. A daily digest is light, read-only use, but if Substack objects, it's your account at risk.
