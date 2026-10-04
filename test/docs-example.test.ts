/**
 * Keeps docs/digest-tools.md honest. It runs one small, made-up digest through the
 * real tools (a fake Substack and a fake Jev), using the arguments printed in the doc,
 * and checks that every generated block in the doc matches what the tools return now,
 * and that each argument table lists exactly the tool's input fields.
 *
 * After changing a tool's output: UPDATE_DOCS=1 npx vitest run test/docs-example.test.ts
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClientProvider, createServer } from "../src/server.js";
import { authed, fakeFetch, SID } from "./helpers.js";

const DOC = join(import.meta.dirname, "..", "docs", "digest-tools.md");
const NOW = Date.parse("2026-10-04T11:00:24Z");
/** run_id ends in random hex; the doc shows this one and the test swaps in the real one. */
const DOC_RUN_ID = "20261004-110024-d0c5";
const saved = { ...process.env };
let dir: string;

beforeEach(async () => {
  process.env.SUBSTACK_READER_HOME = await mkdtemp(join(tmpdir(), "substack-reader-"));
  process.env.SUBSTACK_SID = SID;
  process.env.SUBSTACK_CLASSIFIER = "jev";
  process.env.SUBSTACK_JEV_API_KEY = "test-key";
  process.env.SUBSTACK_DIGEST_RANK_FLOOR = "0.3";
  for (const k of ["SUBSTACK_COOKIE", "SUBSTACK_COOKIES_PATH", "SUBSTACK_USERNAME", "SUBSTACK_DIGEST_DIR", "SUBSTACK_DIGEST_SKIP_THRESHOLD"]) delete process.env[k];
  dir = await mkdtemp(join(tmpdir(), "substack-digest-"));
});
afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
});

const INTERESTS = `## Interests
- Databases and distributed systems, with real numbers
- Cooking and fermentation from people who do it

## Skip
- Podcast episode notes
`;

type Fake = { pub: "systems" | "kitchen"; slug: string; title: string; subtitle: string; date: string; audience: string; type?: string; rank: number; skip: number };

/** Every post in the example, with the rank and skip probability the fake Jev gives it. */
const POSTS: Fake[] = [
  { pub: "systems", slug: "replication-lag", title: "Replication lag, explained with graphs", subtitle: "Why the replica fell 40 seconds behind", date: "2026-10-03T14:00:00Z", audience: "everyone", rank: 0.9, skip: 0.02 },
  { pub: "kitchen", slug: "hot-sauce", title: "Fermenting hot sauce at home", subtitle: "Salt ratios that work", date: "2026-10-03T13:00:00Z", audience: "only_paid", rank: 0.62, skip: 0.04 },
  { pub: "systems", slug: "weekly-links-41", title: "Weekly links #41", subtitle: "", date: "2026-10-03T12:30:00Z", audience: "everyone", rank: 0.2, skip: 0.15 },
  { pub: "kitchen", slug: "episode-88", title: "Episode 88: sourdough in a heatwave", subtitle: "", date: "2026-10-03T12:10:00Z", audience: "everyone", type: "podcast", rank: 0.1, skip: 0.92 },
];
const PUBS = {
  systems: { id: 101, name: "Systems Notes", subdomain: "systemsnotes" },
  kitchen: { id: 202, name: "Field Kitchen", subdomain: "fieldkitchen" },
};
const url = (p: Fake) => `https://${PUBS[p.pub].subdomain}.substack.com/p/${p.slug}`;
const REPORTED = "https://fieldkitchen.substack.com/p/knife-skills";

const raw = (p: Fake, n: number) => ({
  id: 9000 + n,
  title: p.title,
  subtitle: p.subtitle,
  slug: p.slug,
  post_date: p.date,
  audience: p.audience,
  canonical_url: url(p),
  type: p.type ?? "newsletter",
  publishedBylines: [{ id: 1, name: p.pub === "systems" ? "Dana Kim" : "Luis Ortega" }],
});

const jevRequests: Array<{ state: { headline: { title: string } } }> = [];
function fakeJev() {
  return async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { state: { headline: { title: string } } };
    jevRequests.push(body);
    const p = POSTS.find((x) => x.title === body.state.headline.title)!;
    return new Response(JSON.stringify({ answers: { importance: { type: "score", score: p.rank * 3 }, skip_ctx: { type: "noul", noul: p.skip } } }));
  };
}

const archive = (pub: "systems" | "kitchen") => ({
  body: [
    ...POSTS.map((p, n) => [p, n] as const)
      .filter(([p]) => p.pub === pub)
      .map(([p, n]) => raw(p, n)),
    ...(pub === "kitchen" ? [{ id: 8999, title: "Knife skills", post_date: "2026-10-03T11:30:00Z", audience: "everyone", canonical_url: REPORTED }] : []),
  ],
});

const B = "https://substack.com/api/v1";
const routes = {
  [`${B}/user/profile/self`]: authed({
    id: 42,
    subscriptions: [
      { membership_state: "free_signup", publication: PUBS.systems },
      { membership_state: "subscribed", publication: PUBS.kitchen },
    ],
  }),
  "https://systemsnotes.substack.com/api/v1/archive?sort=new&offset=0&limit=20": archive("systems"),
  "https://fieldkitchen.substack.com/api/v1/archive?sort=new&offset=0&limit=20": archive("kitchen"),
  "https://systemsnotes.substack.com/api/v1/posts/replication-lag": {
    body: {
      ...raw(POSTS[0]!, 0),
      wordcount: 2100,
      body_html: "<p>Our read replica fell 40 seconds behind every night at 02:00.</p><h3>What the graphs showed</h3><p>…</p>",
    },
  },
  [`${B}/messages/inbox?tab=all`]: authed({
    threads: [{ type: "chat", id: "chat-101", title: "Systems Notes", timestamp: "2026-10-03T16:00:00Z", publication: { id: 101, name: "Systems Notes" } }],
  }),
  [`${B}/community/publications/101/posts`]: authed({
    threads: [
      {
        communityPost: { id: "t1", created_at: "2026-10-03T15:20:00Z", body: "Anyone running logical replication across regions?", comment_count: 6, reaction_count: 3 },
        user: { id: 7, name: "Dana Kim", handle: "danakim" },
      },
    ],
    moreBefore: false,
  }),
};

async function connect() {
  const { fetch } = fakeFetch(routes);
  vi.stubGlobal("fetch", fakeJev());
  const server = createServer(new ClientProvider(fetch, { sleep: async () => {} }), { digestDir: dir, timezone: "America/New_York", now: () => NOW, sleep: async () => {} });
  const client = new Client({ name: "docs", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

// ---- reading and writing the doc ----

/** `<!-- example: name -->` or `<!-- generated: name -->` followed by a fenced block. */
function blocks(doc: string): Map<string, { full: string; body: string }> {
  const out = new Map<string, { full: string; body: string }>();
  for (const m of doc.matchAll(/<!-- (example|generated): ([\w-]+) -->\n(````?)(\w*)\n((?:(?!\3\n).*\n)*)\3\n/g)) out.set(`${m[1]}:${m[2]}`, { full: m[0], body: m[5]!.replace(/\n$/, "") });
  return out;
}

/** Field names in the table under `<!-- args: tool -->`. */
function argTable(doc: string, tool: string): string[] {
  const at = doc.indexOf(`<!-- args: ${tool} -->`);
  if (at < 0) throw new Error(`no args table for ${tool}`);
  const rows = doc.slice(at).split("\n").slice(1);
  const table = rows.slice(0, rows.findIndex((l, n) => n > 0 && !l.startsWith("|")));
  return table.slice(2).map((l) => /^\| `(\w+)`/.exec(l)?.[1] ?? l);
}

it("docs/digest-tools.md matches what the digest tools do", async () => {
  await writeFile(join(dir, "interests.md"), INTERESTS);
  await writeFile(join(dir, "state.json"), JSON.stringify({ last_run: "2026-10-03T11:00:31Z", reported_posts: [REPORTED] }, null, 2) + "\n");

  let doc = await readFile(DOC, "utf8");
  const found = blocks(doc);
  let runId = DOC_RUN_ID;
  const args = (name: string) => {
    const b = found.get(`example:${name}`);
    if (!b) throw new Error(`docs/digest-tools.md has no "<!-- example: ${name} -->" block`);
    return JSON.parse(b.body.replaceAll(DOC_RUN_ID, runId)) as Record<string, unknown>;
  };

  const client = await connect();
  const call = async (name: string, a: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: a });
    const t = (r.content as Array<{ text: string }>)[0]!.text;
    if (r.isError) throw new Error(`${name} failed: ${t}`);
    return t;
  };
  const generated: Record<string, string> = {};
  generated.digest_begin = await call("digest_begin", args("digest_begin"));
  runId = /^RUN_ID: (\S+)$/m.exec(generated.digest_begin)![1]!;
  generated.jev_request = JSON.stringify(jevRequests.find((r) => r.state.headline.title === POSTS[0]!.title), null, 2);
  generated.read_post = await call("read_post", args("read_post"));
  generated.digest_finish = await call("digest_finish", args("digest_finish"));
  generated.digest_status = (await call("digest_status", {})).replaceAll(dir, "/data/substack_digest");
  generated.mark_reported = await call("mark_reported", args("mark_reported"));
  for (const k of Object.keys(generated)) generated[k] = generated[k]!.replaceAll(runId, DOC_RUN_ID);

  if (process.env.UPDATE_DOCS) {
    for (const [name, text] of Object.entries(generated)) {
      const b = found.get(`generated:${name}`);
      if (!b) throw new Error(`docs/digest-tools.md has no "<!-- generated: ${name} -->" block`);
      const fence = text.includes("```") ? "````" : "```";
      doc = doc.replace(b.full, `<!-- generated: ${name} -->\n${fence}${name === "jev_request" ? "json" : "text"}\n${text}\n${fence}\n`);
    }
    await writeFile(DOC, doc);
  }

  // Argument tables list exactly the tool's input fields.
  const { tools } = await client.listTools();
  for (const tool of ["digest_begin", "read_post", "digest_finish", "mark_reported"]) {
    const schema = tools.find((t) => t.name === tool)!.inputSchema as { properties?: Record<string, unknown> };
    expect(argTable(doc, tool).sort(), `argument table for ${tool}`).toEqual(Object.keys(schema.properties ?? {}).sort());
  }

  if (!process.env.UPDATE_DOCS) {
    for (const [name, text] of Object.entries(generated)) {
      expect(found.get(`generated:${name}`)?.body, `generated block "${name}" is stale; run UPDATE_DOCS=1 npx vitest run test/docs-example.test.ts`).toBe(text);
    }
  }
});
