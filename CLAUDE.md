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
- **Don't open chat pages in a browser to investigate.** Loading `substack.com/chat` makes the page `POST /api/v1/messages/inbox/seen`, which clears the user's unread badges. The API GETs above don't do that (as far as observed). This happened once, on 2026-09-25.

## MCP / Claude Code

- In server mode **stdout is the MCP protocol channel.** Never `console.log` from server code paths; use `console.error`. CLI subcommands (`status`, `logout`, `install`) may use stdout.
- Claude Code does **not** read MCP servers from `~/.claude/settings.json`. The original Python version's `make configure` wrote them there, so that registration never took effect. Use `claude mcp add` (what `cli.ts install` does) or `~/.claude.json` / `.mcp.json`.

## Tooling

- TypeScript is 7.x, the native compiler. Some older tsconfig options (`baseUrl`, `moduleResolution: node`) no longer exist.
- If vitest fails with `Cannot find native binding` (rolldown), it's the npm optional-dependency bug: delete `node_modules` and `package-lock.json`, then run `npm install` again.
- `playwright-core` is an **optional** dependency and is imported dynamically only by `login`. Don't import it at the top level of anything the server loads.
