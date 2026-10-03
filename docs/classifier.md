# The headline classifier

The digest has three jobs: decide which posts matter to you, read them, and present them. The first job is the heart of it. It's where your taste lives, and it can be done from headlines alone, before any model reads a post. So it's its own component, `src/classifier/`, with one interface, swappable backends and its own evaluation loop. Reading, summarizing and presenting stay with the agent and `digest_finish`.

The classifier is **optional and off by default** here. Without it the digest works as it always has: every post is read, and the agent's model picks the best from what the subagents report. With it:

```
digest_begin ──► classifier ──► POSTS, best first ──► subagents read them ──► agent picks ──► digest_finish
                 (rank + skip,    SKIPPED: not read                            (ranks help)    (🗑 line,
                  per post)       RANKED LOW: optional                                          "Also new")
```

## What it does

For every new post (title, subtitle, author, publication) and your `interests.md`, a classifier returns:

- **rank**, 0–1: how much you'd want to read it. `digest_begin` lists POSTS best first with a 0–100 rank column. The agent reads them in that order and weighs the rank when it chooses "Read in full". With `SUBSTACK_DIGEST_RANK_FLOOR` set, posts below the floor move to a **RANKED LOW** list. Reading those is optional, and any left unread appear in the digest under 📎 "Also new" with their links.
- **skip**, 0–1: the probability that it matches your Skip section. Posts at or above `SUBSTACK_DIGEST_SKIP_THRESHOLD` (default 0.7) move to **SKIPPED BY CLASSIFIER**. They aren't read, need no entry in `digest_finish`, are saved as reported, and are counted in the digest's 🗑 line.

Every post is still saved as reported, whichever list it lands in, so nothing comes back the next day.

Since this digest reads everything you subscribe to, the classifier mostly orders the work and sharpens the picks. Skipping saves subagent reading time on posts you'd never open, like podcast show notes. Ranking matters more than skipping: a low rank costs you nothing, while a wrong skip hides a post.

## Backends

| | `jev` | `sampling` |
| --- | --- | --- |
| What | [Jev](jev/README.md), TypeSafe's decision model, through OpenRouter's Decisions API | The MCP client's own model, through MCP sampling (Hermes: `auxiliary.mcp` or `mcp_servers.<name>.sampling.model`) |
| Ranks | yes (calibrated scale) | no: skip only |
| Speed | ~2–4 s per 100 posts (8 parallel requests) | ~110 s per 100 with a local 27B model |
| Cost | ~$0.003 per 100 posts (input tokens only) | free, but occupies the client's model |
| Needs | `OPENROUTER_API_KEY` | a client that supports sampling |
| If it fails | nothing is skipped or ranked; `digest_begin` says why | same |

Choose with `SUBSTACK_CLASSIFIER=jev | sampling | off` (default `off`). `jev` without a key falls back to `sampling` and says so under WARNINGS. Pin the Jev version with `SUBSTACK_JEV_MODEL` (default `typesafe/jev-1.13`): thresholds are tuned against a specific version.

Jev gets one request per post. It judges one input against several questions, so posts can't be batched into one prompt. The request carries your Interests and Skip bullets plus the post's headline, and asks two questions:

- `importance`: a 4-level Score from "not for this reader" to "must read". Its probability-weighted position becomes the rank.
- `skip_ctx`: a yes/no ("should this be dropped because it matches one of the reader's skips?"). It's only asked when there's a Skip section, and its probability becomes the skip.

The request shape is the one that won a comparison of six designs on Medium headlines; see [Evidence](#evidence).

### Setup with Hermes

```yaml
mcp_servers:
  substack-reader:
    env:
      SUBSTACK_DIGEST_DIR: /opt/data/sandbox/substack_digest
      SUBSTACK_CLASSIFIER: jev
      OPENROUTER_API_KEY: sk-or-…
      # SUBSTACK_DIGEST_SKIP_THRESHOLD: 0.7   # from analyze.mjs
      # SUBSTACK_DIGEST_RANK_FLOOR: 0.1       # only if analyze.mjs recommends one
```

Give `interests.md` `## Interests` and `## Skip` sections (see `hermes/interests.example.md`). Without an `interests.md` the classifier has nothing to judge against and stays off for that run. `digest_status` ends with a `CLASSIFIER CONFIG:` line, and `digest_begin` prints a `CLASSIFIER:` line when it runs.

## Settings

All settings are environment variables on the MCP server (in Hermes: `mcp_servers.<name>.env` in `config.yaml`).

| Variable | Default | What it does |
| --- | --- | --- |
| `SUBSTACK_CLASSIFIER` | `off` | `jev`, `sampling` or `off`. Default: no classifier; every post is read as before. |
| `OPENROUTER_API_KEY` | none | Required for `jev`. Without it, `jev` falls back to `sampling` and says so in the work list's warnings. |
| `SUBSTACK_JEV_MODEL` | `typesafe/jev-1.13` | The Jev version. Pin one: thresholds are tuned against a specific version. |
| `SUBSTACK_DIGEST_SKIP_THRESHOLD` | `0.7` | Posts with a skip probability at or above this are dropped. `1` effectively turns skipping off. |
| `SUBSTACK_DIGEST_RANK_FLOOR` | `0` (off) | Posts ranked below this are listed apart (see above). Only with a ranking backend. |

`analyze.mjs` recommends values for the last two from your own labels.

## Tuning it to you

Your `interests.md` is the whole profile, and the only way to know whether it says what you mean is to check it against your own judgments. `tools/classifier/` has four scripts for that loop. They score with the built server's own classifier code, so what you measure is what the digest runs.

```bash
npm run build                                               # the tools use dist/
export SUBSTACK_DIGEST_DIR=/path/to/substack_digest         # or pass --digest-dir / --data / --interests

node tools/classifier/collect.mjs                           # 1. add posts from committed runs
node --env-file=.env tools/classifier/score.mjs --all       # 2. score them (so the sample can cover the rank range)
node tools/classifier/label.mjs                             # 3. label ~150 posts, one keypress each
node --env-file=.env tools/classifier/score.mjs             # 4. score anything new
node tools/classifier/analyze.mjs                           # 5. compare, get recommended settings
```

1. **Collect.** When `digest_finish` commits a run, it also saves it as `runs/<run_id>.json` with your picks, keeping the newest 14. `collect.mjs` reads those plus `previous_run.json` and `current_run.json`, and adds new posts to `classifier/dataset.jsonl` in the digest directory. Run it every week or two to build up history. If the digest runs on another machine (Hermes in Docker, say), copy the digest directory and pass `--digest-dir`, or copy `runs/` and use `--runs <copy> --data <dir>`.
2. **Label.** `label.mjs` shows one post title at a time, with no scores, so they can't bias you:
   - **1 skip**: never want it
   - **2 meh**: fine, wouldn't open
   - **3 read**: would open
   - **4 must**: would be annoyed to miss

   It's resumable, and `u` undoes. Label what you'd actually do, not what your `interests.md` says. The gap between the two is what this finds. Aim for about 150 labels, with at least 10 each of skip and must; use `--add 50` for more.
3. **Score.** `score.mjs` uses `--classifier jev` by default; `--classifier sampling --base <OpenAI-compatible URL> --model <name>` measures a local model the same way. Scores are cached per backend and per version of `interests.md` (by hash), so an edited file gets a fresh cache next to the old one.
4. **Analyze.** `analyze.mjs` prints:
   - **ranking quality**: AUC, NDCG@20, how many of the top 10 you wanted, how much slop sinks to the bottom 30.
   - **a skip-threshold sweep and a rank-floor sweep**, with recommended values. The rule is the lowest threshold, and the highest floor, that loses no *must* and at most 5% of *read* (`--max-read-loss`).
   - **where you and the classifier disagree most.**
5. **Edit `interests.md`, then score and analyze again.** The disagreements say what to change: add the topic you kept wanting, narrow a Skip pattern that catches posts you like. Both profile versions stay in the table, so you can see whether the edit helped.

Labels, scores and the dataset hold the titles of posts in your subscriptions. Keep them out of version control (`classifier-data/` is gitignored).

## Evidence

The design was evaluated on Medium, where the feed is larger and noisier: 1,223 headlines and 160 hand labels, October 2026. The full write-up is in medium-reader-mcp's `docs/classifier.md` and `experiments/jev/README.md`.

- Jev ranked as well as a local 27B model through sampling (AUC 76 vs 75). It was clearly better at the top (NDCG@20 72 vs 63; its top 10 were all posts the user wanted, against 7 of 10), and took 3 s instead of 178 s.
- **The profile mattered more than the backend.** Skip patterns that described title style ("Top N", clickbait framing) or whole topics (all money talk) dropped posts the user wanted. Rewritten to describe intent, the same threshold dropped no must-read posts.

Substack's mix is different: chosen publications, fewer posts, longer essays. Run the loop above on your own posts before trusting the default threshold.

## Proposing an interests.md from your activity

Substack records more about how you read than most platforms, so a first `interests.md` can be drafted from evidence rather than memory. Two tools do it:

- **`interests_evidence`** (read-only, always available) gathers your signals, marked by how far to trust them:
  - **strong**: paid subscriptions, saved and hearted posts, posts you **read to the end** (80%+)
  - **medium**: free subscriptions, posts read partway, the digest's ⭐ picks
  - **weak**: posts you opened and left early
  - **negative**: posts you dismissed from your inbox, and labels marked skip

  Read progress comes from the inbox's Seen tab (`max_read_progress`), so posts you only read by email don't count. The tool returns all of this with drafting rules learned from the Medium evaluation: skip by intent, never by title style; never skip a whole topic you read; include non-technical topics, or they rank last.
- **`save_interests_proposal`** (digest mode) saves the draft as `interests.proposed.md` and reports what changed. It never touches `interests.md`.

Ask your agent "propose an interests.md from my Substack activity", or run `tools/classifier/propose.mjs --model <model>` against any OpenAI-compatible endpoint (OpenRouter by default).

**Test before adopting** once you have labels. Draft from half of them (`labels: "train"` / `--labels train`), score the proposal (`score.mjs --interests …/interests.proposed.md`), and compare with `analyze.mjs --test-half`, which uses only the labels the draft didn't see. On Medium, a draft written blind this way beat the hand-written file on held-out labels (AUC 84.6 vs 81.7; see medium-reader-mcp's docs/classifier.md).

Without labels, a proposal is still a better start than an empty file. On the maintainer's account (October 2026), `propose.mjs` turned 35 subscriptions, 117 saves, 100 hearts and 160 reads into 10 Interest bullets. Each was tied to signals that recurred across saves, hearts and finished reads, and they covered non-technical topics as well as technical ones. It proposed no Skip bullets, correctly: the only negative evidence was two dismissed posts from sources the reader otherwise hearts or pays for.

## Adding a backend

Open-source decision models in the Jev mould are appearing, and any of them can slot in. Implement `Classifier` from `src/classifier/types.ts`:

```ts
interface Classifier {
  readonly name: string;   // shown in the CLASSIFIER line
  readonly ranks: boolean; // whether verdicts carry `rank`
  classify(items: Headline[], profile: ReaderProfile, opts?: { deadline?: number }): Promise<ClassifyResult>;
}
// ClassifyResult: { verdicts: ({ rank?: 0–1, skip?: 0–1, reason? } | null)[], unavailable?: string, notes: string[] }
```

Then:

1. Add it to `classifierFromEnv` in `src/classifier/index.ts`.
2. Add a `--classifier` option to `tools/classifier/score.mjs`.
3. Score and compare it with `analyze.mjs` against your labels.

Rules every backend follows:

- **Fail open.** Return `unavailable` or null verdicts; never fail a digest run.
- **Respect the deadline**: `digest_begin` must finish inside Hermes's 300 s tool timeout.
- **Keep the request shape stable**, so scores and thresholds stay comparable.

`src/classifier/` and every file in `tools/classifier/` except `source.mjs` are identical to medium-reader-mcp's. Make changes in both.
