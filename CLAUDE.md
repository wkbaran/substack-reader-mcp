# Agent notes

Common mistakes and confusion points in this project. Add to this list when something surprises you.

## Substack API quirks

- There is no official Substack API for what this project does. Every endpoint here was found by observing the web app, and any of them can change without notice. Substack does run a separate, limited "Developer API" (support.substack.com article 45099095296916, terms at substack.com/api-tos), and it is not the endpoints used here. `substackapi.dev` is a different product with its own API keys; its per-minute limits don't apply to us.
- **No published rate limits for the web app endpoints** (checked 2026-09-25). The Developer API terms only say limits are "determined by Substack in its sole discretion", with no numbers.
- `https://<sub>.substack.com/api/...` answers **301 to the custom domain** when the publication has one. That's why `SubstackHttp` follows redirects manually and decides per hop whether to attach the session cookie. Don't switch to `redirect: "follow"`. Whether fetch strips a manually set `Cookie` header on cross-origin redirects is not guaranteed, so we don't rely on it.
- `/api/v1/posts/<slug>` returns the post object directly, but `/api/v1/posts/by-id/<id>` wraps it as `{ post: ... }`. `SubstackClient.post` handles both.
- Paywalled posts return **HTTP 200 with a truncated `body_html`**, not an error, and no field says whether you got the full post. The reliable signal: when the viewer has access, `body_html` contains `<div class="paywall-jump">` where the paywall would be, and previews stop just before it. Word count alone is **not** enough: Lenny's Newsletter serves about 85% of the article as a free preview. `isPreview` in `format.ts` checks the marker first and uses word count only as a backup. Verified against real posts on 2026-09-25.
- `audience: "only_paid"` (the `paywalled` flag in summaries) describes the post, not the viewer. It is `true` even for publications the user pays for. Paid podcasts often have only ~50 words of show notes as their full text; the paywall covers the audio.
- `/api/v1/archive?search=...` is the search endpoint. It is per publication; there is no cross-subscription search.
- Anonymous visitors also get a `substack.sid`, so having the cookie doesn't mean being logged in. Always validate with `/api/v1/user/profile/self` (401 when not logged in).
- **The subscription list comes from `/api/v1/user/profile/self`, not `/api/v1/subscriptions`.** `profile/self` returns every subscription, including ones hidden from the public profile, each with a nested `publication` object. `/api/v1/subscriptions` looks like the right endpoint, but it returns 400 unless you pass `tvOnly`, and even then it gives an unrelated subset of publications with an empty `subscriptions` array. Verified with a real account on 2026-09-25.
- **Custom domains do not accept `substack.sid`.** For example, `www.oneusefulthing.org/api/v1/subscription` returns 404 "Subscription not found" even though the user is subscribed. The browser's workaround, which `SubstackHttp.customDomainSession` reproduces: `GET substack.com/sign-in?redirect=%2F&for_pub=<subdomain>` with the session redirects (303) to `<custom domain>/api/v1/sign-in/local/complete?token=…`, and that response sets `connect.sid` on the custom domain. The handoff needs the publication's **subdomain**, which is why `trustHost` takes it. Doing this does not rotate or invalidate `substack.sid` (verified 2026-09-25).
- Subscription endpoints (found in the web app's JS bundles and checked live):
  - `GET substack.com/api/v1/subscription/<publicationId>` returns `{ subscription, publication }` for any publication, custom domain or not; for no subscription it returns `subscription: null` or 404. Good for checking before and after a change.
  - `GET <pub>/api/v1/subscription` gives the payment details: `is_subscribed`, `stripe_subscription_id`, `expiry`, and so on. Free subscriptions have `membership_state: "free_signup"`, `is_subscribed: false`, and no Stripe ID; paid ones have `"subscribed"`, `true`, and a Stripe ID.
  - `POST <pub>/api/v1/free {email, source, first_url, ...}` subscribes. It requires the account email, which only appears in page data: `window._preloads.user.email` on `substack.com/settings`.
  - **Free unsubscribe is `DELETE <pub>/api/v1/free {publication_id, source: "account"}`**, the mirror of subscribe. It lives only in the scripts for the publication's `/account` page, which load on demand, so a grep of the homepage bundles won't find it.
  - **`DELETE <pub>/api/v1/subscription` is a trap.** It's the *paid* cancellation endpoint (the web app sends `{force_now: true}`). For a free subscription it returns `200 {}` and changes **nothing**, with or without `force_now`, `Origin`, or `Referer` (verified 2026-09-25). Never use it in `unsubscribe`: on a paid subscription it would cancel the plan.
  - `unsubscribe` still checks `paidSignal()` before deleting and refuses anything that isn't unambiguously free. Don't loosen that. Afterwards it re-checks through the substack.com lookup, because a 200 on its own proves nothing.
  - To find endpoints, load the actual page with the saved browser profile (`playwright-core`, headless) and collect every script it loads. Downloading only the bundles referenced by the page HTML misses code that loads on demand.
- `window._preloads` on any publication homepage has `pub` (id, subdomain, custom_domain). `publicationInfo` uses it to turn a URL or subdomain into canonical details.
- Some well-known newsletters have left Substack (Platformer moved to Ghost), so "doesn't look like a Substack publication" can be the correct answer.

- **Chat** (publication community chats and DMs) all lives on `substack.com`, so no custom-domain handoff is needed, and it always requires a login:
  - `GET /api/v1/messages/inbox?tab=all` lists items of `type: "chat"` (with `publication` and `communityPost`) and `"direct-message"` (with `messageThread`; read it with `messageThread.id`, not the `direct-message-…` item id).
  - `GET /api/v1/community/publications/<pubId>/posts[?before=<created_at>]` lists threads (`{threads: [{communityPost, user}], moreBefore}`). Pages hold 25. A publication without a chat returns 404.
  - `GET /api/v1/community/posts/<threadId>/comments?order=asc&initial=true` returns a **window** of replies with `moreBefore`/`moreAfter`. Page with `before_id=<first id>` and `after_id=<last id>`. Replies to a reply use the same scheme at `/community/comments/<commentId>/comments`.
  - `GET /api/v1/messages/dm/<messageThread.id>` returns `{replies: [{comment, user}], profile}`.
- **Chat unread flags are useless.** No inbox item had `communityPost.has_unread_comments` set in three digest runs (2026-09-30 to 10-02), and `pubChatUnreadCount` stays the same because nothing in this server marks chats as seen. Use `SubstackChat.activity(since)` instead.
- **The inbox `timestamp` (our `lastActivity`) doesn't move when someone replies to an older thread.** Seen 2026-10-02: Nate's chat had inbox time `2026-10-01T22:00:42.514Z`, equal to the newest thread's `created_at`, while that thread's `most_recent_comment_created_at` was `2026-10-02T00:49`. Activity has to come from each chat's thread list: `max(created_at, most_recent_comment_created_at)`. Threads are ordered by creation, so a reply to a thread beyond the first few pages is missed.
- **Archive requests get rate-limited.** At 6 concurrent archive requests with 500 ms / 1 s backoff, 7 of 35 publications failed with 429 on 2026-10-02, and 20 failed on each of two calls 17 s apart on 09-26. Now: concurrency 3, 429 backoff 2/5/10 s with jitter, then retry passes after 15 s and 30 s, one publication at a time. No numbers are published (see above), so these are guesses that worked.
- **Don't open chat pages in a browser to investigate.** Loading `substack.com/chat` makes the page `POST /api/v1/messages/inbox/seen`, which clears the user's unread badges. The API GETs above don't do that (as far as observed). This happened once, on 2026-09-25.

- **Reader shelves (found 2026-10-03 in the web app's public JS bundles, checked live):** `GET substack.com/api/v1/reader/posts?inboxType=<seen|saved|archived|inbox|recommended>&limit=20[&cursor=…]` returns `{posts, publications, inboxItems, postReactions, savedPosts, more, cursor}`. The `posts` lack publication names, which come from `publications` by `publication_id`. `inboxItems[].max_read_progress` (0–1) says how far the user read in the web or app reader; email reads don't appear. `postReactions` are the user's own hearts, and `inboxType=archived` is posts the user dismissed. Likes: `GET /api/v1/reader/feed/profile/<userId>?types=like` returns `{items, nextCursor}`, where `type: "post"` with `context.type: "post_like"` is a hearted post and `"comment"/"note_like"` is a liked note (skipped).
- **Endpoints that look read-only but write:** `/api/v1/posts/saved` is only save (POST) and unsave (DELETE); list saved posts with `inboxType=saved` instead. `/api/v1/posts/<id>/seen`, `/api/v1/reader/feed/<key>/seen`, `/api/v1/inbox/seen` and `/api/v1/reader/feed/<key>/dismiss` change inbox state. Never call them. The GETs above don't mark anything.

## MCP / Claude Code

- In server mode **stdout is the MCP protocol channel.** Never `console.log` from server code paths; use `console.error`. CLI subcommands (`status`, `logout`, `install`) may use stdout.
- Claude Code does **not** read MCP servers from `~/.claude/settings.json`. The original Python version's `make configure` wrote them there, so that registration never took effect. Use `claude mcp add` (what `cli.ts install` does) or `~/.claude.json` / `.mcp.json`.

## Tooling

- **The version is in two places:** `package.json` and `VERSION` in `src/server.ts` (what MCP clients see in `serverInfo`). Bump both.

- **`docs/digest-tools.md` is checked by `test/docs-example.test.ts`.** Changing a digest tool's output or input fields fails that test until the doc is updated. Regenerate the output blocks with `UPDATE_DOCS=1 npx vitest run test/docs-example.test.ts`, review the diff, and update the argument tables and prose by hand.
- TypeScript is 7.x, the native compiler. Some older tsconfig options (`baseUrl`, `moduleResolution: node`) no longer exist.
- If vitest fails with `Cannot find native binding` (rolldown), it's the npm optional-dependency bug: delete `node_modules` and `package-lock.json`, then run `npm install` again.
- `playwright-core` is an **optional** dependency and is imported dynamically only by `login`. Don't import it at the top level of anything the server loads.

## Digest tools

- `digest_begin`, `digest_finish`, `digest_status` and `mark_reported` are registered **only when `SUBSTACK_DIGEST_DIR` is set** (absolute path), so the public tool list doesn't change. Paths come only from env, never from tool arguments. `get_chat_activity` is always registered.
- **Two server processes run at once in the Hermes container** (seen 2026-10-02), so anything shared between calls lives in files in the digest dir, never in memory. Every write takes `state.lock` (`open(..., "wx")`, stale after 60 s) and goes through write-then-rename. Symlinks in the digest dir are refused.
- `digest_begin` writes only `current_run.json`; `digest_finish` commits `state.json` and renames the run to `previous_run.json` with its rendered result, which is how a repeated `digest_finish` call returns the same text. If `last_run` changed between begin and finish, finish refuses.
- **`reported_posts` is deliberately the last key in `state.json`.** The v2.x skill appended URLs by patching the end of that list, so keeping it last lets the old skill run against v2 state if the skill is rolled back.
- **Digest output is plain text, never JSON.** Hermes wraps every MCP text result as `{"result": "<text>"}`, so JSON comes out double-escaped and hard for a small model to copy. Don't add `structuredContent` or an `outputSchema`. Keep each result under ~40,000 characters (Hermes drops results over ~50k).
- Hermes pauses an MCP server for 60 s after 3 consecutive error results, so `digest_finish` is lenient (case-insensitive refs, duplicates resolved, unknown refs dropped) and reports warnings instead of errors wherever that's safe.
- Hermes's MCP tool timeout is 300 s. `digest_begin` gives the post fetch about 140 s and leaves the rest for chats.
- `Intl.DateTimeFormat` can't combine `dateStyle` with `timeZoneName` (it throws), so `formatLocal` spells out the fields. Newer ICU puts U+202F before AM/PM; `time.ts` replaces it with a space.

## Hermes skill

- `hermes/SKILL.md` is the generic, shareable copy of the digest skill; its settings are in the Settings block at the top. Since v3.0.0 it uses only the digest tools, `get_chat_activity`, `read_post` and `delegate_task`, and must not use file tools. The copy running on the maintainer's Hermes host has those values filled in, and the two are kept in sync by hand. When you change one, change the other, and bump `version` in the frontmatter.
- The skill is a prompt, so it can't be unit-tested. Check changes by running the cron job once (`hermes cron run <id>`) and reading the tool calls in Hermes's `state.db` `messages` table. That's how the result-size and missing-`since` problems were found.

## Headline classifier (`src/classifier/`, `tools/classifier/`)

- **Shared with medium-reader-mcp.** `src/classifier/*` and `tools/classifier/{lib,collect,label,score,analyze}.mjs` are identical in both repos; only `tools/classifier/source.mjs` differs. Change both copies together, and keep `src/classifier/` free of Substack imports. docs/classifier.md explains the design; the evaluation behind it is in medium-reader-mcp's `experiments/jev/`.
- **Off by default here** (`classifierFromEnv("SUBSTACK", …, "off")`), unlike Medium, where `sampling` is the default. The Substack digest has always read every post, so turning a classifier on must be a choice. When it's off, `digest_begin`'s output is exactly what it was before (no CLASSIFIER line, no rank column).
- **What the classifier changes:** POSTS are sorted by rank with a rank column. Skipped posts (`skip ≥ SUBSTACK_DIGEST_SKIP_THRESHOLD`) and below-floor posts (`SUBSTACK_DIGEST_RANK_FLOOR`) get their own lists. `reconcile` doesn't count them as missing: skipped ones go in the 🗑 line, and unread low ones under 📎 "Also new". All of them are still saved as reported.
- **The classifier's deadline is real time.** `digestBegin` hands it `Date.now() + time left`, not `fetchStart + budget`, because tests inject `deps.now` and the classifier uses the real clock. A timestamp on the injected clock made it give up at once ("no time left to classify").
- **`runs/` archive:** `digest_finish` saves each committed run as `runs/<run_id>.json` with `judged: {picks, others}` (newest 14, `archiveRun` in state.ts). Nothing in the digest reads it; it's history for `tools/classifier/collect.mjs`. A failed archive write never fails the run.
- `interests.md` sections are parsed by `parseProfile` (`## Interests`, `## Skip`; a file without them is all interests). The model still sees the raw file in INTERESTS.
- `OPENROUTER_API_KEY` for the tools can live in `.env` (gitignored); run them with `node --env-file=.env`.
- **interests_evidence / save_interests_proposal:** `src/classifier/{evidence,proposal}.ts` are shared with Medium. `src/digest/evidence.ts` is Substack's gatherer. Labels and the dataset live in `<digest dir>/classifier/`, and runs in `runs/`; they're read through `subdirPath`, which refuses symlinks, since `safePath` only takes flat names. Proposals are tested on held-out labels: `isTrainLabel` and `analyze.mjs --test-half` share one split.
