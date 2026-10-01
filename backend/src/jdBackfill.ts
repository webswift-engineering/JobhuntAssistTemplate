/**
 * JD backfill: browser scans fail-soft to title-only cards when LinkedIn rate-limits
 * the in-page description fetches, which leaves persisted jobs with no description
 * and a capped, unverified score. This module re-fetches those descriptions
 * server-side (guest endpoint / ATS APIs via fetchJobFromUrl), stores them, and
 * re-triages the job with the real requirements so the score reflects the actual JD.
 */

import type { DB } from "./db/client.js";
import type { LlmClient } from "./llm/client.js";
import { fetchJobFromUrl } from "./sources/fetchJobFromUrl.js";
import { triageJobs } from "./llm/triageJob.js";
import { computeMatchFacts, type MatchFacts } from "./profile/matchFacts.js";
import { loadMasterProfile } from "./profile/tailorSource.js";
import { getProfile, setRelevance } from "./store.js";
import { isJobInAllowedRegions } from "./regionFilter.js";
import { freshnessMs } from "./freshness.js";

export interface JdBackfillDeps {
  llm: LlmClient;
  /** Test seam: replaces the real URL fetch. */
  fetchFn?: (url: string) => Promise<{ extracted: { description: string | null } }>;
  /** Test seam: skip the master-profile disk read. */
  facts?: MatchFacts;
  limit?: number;
}

export interface JdBackfillResult {
  candidates: number;
  fetched: number;
  rescored: number;
}

const MIN_JD_CHARS = 80;
const FETCH_CONCURRENCY = 3;

interface CandidateRow {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  url: string;
}

let inFlight: Promise<JdBackfillResult> | null = null;

/** Single-flight: a second call while one is running joins the same run. */
export function backfillMissingJds(db: DB, userId: number, deps: JdBackfillDeps): Promise<JdBackfillResult> {
  if (inFlight) return inFlight;
  inFlight = run(db, userId, deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(db: DB, userId: number, deps: JdBackfillDeps): Promise<JdBackfillResult> {
  const limit = deps.limit ?? 20;
  const cutoff = Date.now() - freshnessMs();
  const rows = (await db
    .prepare(
      `SELECT id, title, company, location, url FROM jobs
       WHERE user_id = ?
         AND COALESCE(description, '') = ''
         AND COALESCE(url, '') != ''
         AND state IN ('discovered', 'relevant', 'notified')
         AND COALESCE(posted_at, first_seen_at) >= ?
       ORDER BY relevance_score DESC
       LIMIT ?`
    )
    .all(userId, cutoff, limit)) as CandidateRow[];
  if (!rows.length) return { candidates: 0, fetched: 0, rescored: 0 };

  const fetchFn = deps.fetchFn ?? fetchJobFromUrl;
  const jds = new Array<string | null>(rows.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, rows.length) }, async () => {
      while (next < rows.length) {
        const i = next++;
        const r = await fetchFn(rows[i]!.url).catch(() => null);
        const jd = r?.extracted.description ?? null;
        jds[i] = jd && jd.length >= MIN_JD_CHARS ? jd : null;
      }
    })
  );

  const got = rows.map((row, i) => ({ row, jd: jds[i] })).filter((x): x is { row: CandidateRow; jd: string } => x.jd != null);
  if (!got.length) return { candidates: rows.length, fetched: 0, rescored: 0 };

  const upd = db.prepare("UPDATE jobs SET description = ? WHERE id = ?");
  for (const { row, jd } of got) await upd.run(jd, row.id);

  const prefs = (await getProfile(db, userId)).preferences;
  const facts = deps.facts ?? computeMatchFacts(loadMasterProfile(userId), prefs);
  const results = await triageJobs(
    deps.llm,
    got.map(({ row, jd }) => ({
      title: row.title,
      company: row.company,
      location: row.location,
      description: jd,
    })),
    facts,
    prefs
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const { row, jd } = got[i]!;
    // The freshly-fetched JD can change the region verdict — re-stamp with it.
    const regionStatus = isJobInAllowedRegions(row.location, jd, prefs) ? "in" : "out";
    await setRelevance(db, userId, row.id, r.score, `[${r.verdict}] ${r.reason}`.slice(0, 200), {
      regionStatus,
      method: "triage",
    });
  }

  console.log(
    `[jd-backfill] candidates ${rows.length}, fetched ${got.length}, rescored ${results.length}`
  );
  return { candidates: rows.length, fetched: got.length, rescored: results.length };
}
