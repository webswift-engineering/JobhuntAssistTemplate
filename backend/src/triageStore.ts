import { createHash } from "node:crypto";
import type { DB } from "./db/client.js";
import { THIN_JD_CHARS, verdictForScore } from "./llm/triageJob.js";
import type { TriageResult, TriageVerdict } from "./llm/triageJob.js";
import { dedupKey } from "./dedup.js";

export function jdHash(description: string | null | undefined): string | null {
  const d = (description ?? "").trim();
  if (!d) return null;
  return createHash("sha1").update(d).digest("hex");
}

/**
 * Triage scoring-logic version, baked into the cached jd_hash. Bump whenever
 * triageDeterministic/extraction logic changes: cached entries stop matching
 * and are recomputed with the new rubric.
 * v2: grouped years-anchored domain/tool must-haves + title-named-tool cap.
 */
export const TRIAGE_CACHE_VERSION = 2;

/**
 * jd_hash + logic version for the triage cache. Uses "empty" (not null) for
 * missing JDs so a version bump invalidates title-only entries too.
 */
export function triageJdHash(description: string | null | undefined): string {
  return `${jdHash(description) ?? "empty"}:t${TRIAGE_CACHE_VERSION}`;
}

export interface CachedTriage {
  dedupKey: string;
  jdHash: string | null;
  result: TriageResult;
  updatedAt: number;
}

export async function getCachedTriage(db: DB, userId: number, dedupKey: string): Promise<CachedTriage | null> {
  const row = (await db
    .prepare(
      "SELECT dedup_key, jd_hash, result_json, updated_at FROM triage_cache WHERE user_id = ? AND dedup_key = ?"
    )
    .get(userId, dedupKey)) as
    | { dedup_key: string; jd_hash: string | null; result_json: string; updated_at: number }
    | undefined;
  if (!row) return null;
  try {
    return {
      dedupKey: row.dedup_key,
      jdHash: row.jd_hash,
      result: JSON.parse(row.result_json) as TriageResult,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

/** Triage result reconstructed from the authoritative stored job row. */
export type StoredTriageResult = TriageResult & { fromStore: true };

const REASON_VERDICT_RE = /^\[(strong|maybe|weak|disqualified)\]\s*/;

export interface TriageOverrideInput {
  title: string;
  company?: string | null;
  location?: string | null;
  description?: string | null;
  externalId?: string | null;
}

/**
 * Authoritative-score guard for /jobs/triage: when a (re-)triage request carries no
 * usable JD but the stored job (matched by the same dedup key ingest would use) was
 * already scored WITH a real description, the stored score wins. The caller must
 * return this result as-is and must NOT setRelevance with a thin re-triage — that
 * would regress a backfilled JD-based score to the ~0.3 title-only floor, and the
 * overlay would paint a stale "Maybe 30%" on a job the dashboard shows at 85-90.
 */
export async function storedTriageOverride(
  db: DB,
  userId: number,
  source: string,
  job: TriageOverrideInput
): Promise<StoredTriageResult | null> {
  if ((job.description ?? "").trim().length >= THIN_JD_CHARS) return null;
  const key = dedupKey({
    source,
    externalId: job.externalId ?? null,
    company: job.company ?? null,
    title: job.title,
    location: job.location ?? null,
  });
  const row = (await db
    .prepare(
      `SELECT relevance_score, relevance_reason,
              LENGTH(COALESCE(description, '')) AS jd_len
       FROM jobs WHERE user_id = ? AND dedup_key = ?`
    )
    .get(userId, key)) as
    | { relevance_score: number | null; relevance_reason: string | null; jd_len: number }
    | undefined;
  if (!row || row.relevance_score == null || Number(row.jd_len) < THIN_JD_CHARS) return null;

  const score = Math.round(Number(row.relevance_score) * 100) / 100;
  const storedReason = String(row.relevance_reason ?? "").trim();
  const m = REASON_VERDICT_RE.exec(storedReason);
  const verdict = (m?.[1] as TriageVerdict | undefined) ?? verdictForScore(score);
  const reason = (m ? storedReason.slice(m[0].length) : storedReason) || "Scored from stored job description";
  return {
    verdict,
    score,
    matchedSkills: [],
    missingRequired: [],
    disqualifiers: verdict === "disqualified" ? [reason] : [],
    reason,
    fromStore: true,
  };
}

export async function putCachedTriage(
  db: DB,
  userId: number,
  dedupKey: string,
  hash: string | null,
  result: TriageResult
): Promise<void> {
  await db.prepare(
    `INSERT INTO triage_cache (user_id, dedup_key, jd_hash, verdict, score, result_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, dedup_key) DO UPDATE SET
       jd_hash = excluded.jd_hash,
       verdict = excluded.verdict,
       score = excluded.score,
       result_json = excluded.result_json,
       updated_at = excluded.updated_at`
  ).run(userId, dedupKey, hash, result.verdict as TriageVerdict, result.score, JSON.stringify(result), Date.now());
}
