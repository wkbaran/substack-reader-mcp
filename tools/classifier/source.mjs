// The only source-specific part of the classifier tools: where this server's digest
// keeps its files, and how to read headlines out of a run file. Everything else in
// tools/classifier/ is shared with medium-reader-mcp.
import { join } from "node:path";

export const SOURCE = {
  name: "Substack",
  /** Env prefix for this server's settings: <PREFIX>_CLASSIFIER, <PREFIX>_DIGEST_SKIP_THRESHOLD, … */
  prefix: "SUBSTACK",
  /** Env var holding the digest directory (state.json, interests.md, runs/). */
  digestDirEnv: "SUBSTACK_DIGEST_DIR",
};

/**
 * Headlines in one run file (runs/<id>.json, written by digest_finish when it commits;
 * also previous_run.json and current_run.json).
 * Returns { id, title, subtitle?, author?, publication?, url?, run, pool, picked }.
 * Substack posts have no stable id in the run, so the URL is the id.
 */
export function headlinesFromRun(run) {
  const picks = new Set(run.judged?.picks ?? []);
  const others = new Set(run.judged?.others ?? []);
  return (run.posts ?? []).map((p) => ({
    id: p.url,
    title: p.title,
    subtitle: p.subtitle,
    author: p.author,
    publication: p.publication,
    url: p.url,
    run: run.run_id,
    pool: "posts",
    picked: picks.has(p.ref) ? "starred" : others.has(p.ref) ? "named" : undefined,
  }));
}

/** Run files outside runs/: the last committed run and any run in progress. */
export function extraRunFiles(digestDir) {
  return digestDir ? [join(digestDir, "previous_run.json"), join(digestDir, "current_run.json")] : [];
}

/** The interests evidence the interests_evidence tool returns, gathered with the built server's code. */
export async function evidenceText({ digestDir, history = 150, listItems = 100, labels = "all" }) {
  const dist = (p) => new URL(`../../dist/${p}`, import.meta.url).href;
  const { ClientProvider } = await import(dist("server.js"));
  const { gatherEvidence } = await import(dist("digest/evidence.js"));
  const { renderEvidence } = await import(dist("classifier/evidence.js"));
  const ev = await gatherEvidence(await new ClientProvider().get(), digestDir, { history, listItems, labels });
  ev.saveHint = undefined; // propose.mjs saves the file itself
  return renderEvidence(ev);
}
