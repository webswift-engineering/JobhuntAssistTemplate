import type { DB } from "./db/client.js";
import { bumpDataVersion } from "./dataVersion.js";
import { dedupKey, jobIdFromDedupKey } from "./dedup.js";
import { classifyEmployment, type EmploymentType } from "./employmentType.js";
import { freshnessMs } from "./freshness.js";
import { isJobInAllowedRegions } from "./regionFilter.js";
import { canonicalPostingUrl } from "./jobPostingUrl.js";
import { parseSalary, classifyWorkplace, defaultCurrencyFor, salaryFloorSql, floorFor } from "./salary.js";
import { assertTransition } from "./state.js";
import type {
  CompanyRow,
  IngestResult,
  JobRow,
  JobState,
  Preferences,
  RawJob,
  SourceKind,
} from "./types.js";

const now = () => Date.now();

// ---------------------------------------------------------------------------
// Region status + posting-URL canonicalization (write-time, not read-time)
// ---------------------------------------------------------------------------

/**
 * 'in' | 'out' for the jobs.region_status column. Deterministic (regex, no LLM).
 * NULL in the column means "not yet stamped" and is treated as in-region by
 * queries, matching the old behavior where unknown rows stayed visible.
 */
export async function regionStatusFor(
  db: DB,
  userId: number,
  location: string | null | undefined,
  description: string | null | undefined
): Promise<"in" | "out"> {
  const prefs = (await getProfile(db, userId)).preferences;
  return isJobInAllowedRegions(location, description, prefs) ? "in" : "out";
}

// Board tokens are needed to canonicalize posting URLs at ingest: Workday job
// paths, and company-branded Greenhouse embeds (okta.com/...?gh_jid=N) which
// must point at the hosted board for the apply assist to drive them.
// Cached per-DB; invalidated on any company mutation (all live in this module).
const companyCache = new WeakMap<DB, CompanyRow[]>();

async function urlCompanies(db: DB): Promise<CompanyRow[]> {
  let list = companyCache.get(db);
  if (!list) {
    list = (
      (await db
        .prepare("SELECT * FROM companies WHERE ats IN ('workday','greenhouse')")
        .all()) as CompanyRow[]
    );
    companyCache.set(db, list);
  }
  return list;
}

function invalidateCompanyCache(db: DB): void {
  companyCache.delete(db);
}

/** Canonicalize a posting URL before it is written (greenhouse/workday fixups). */
async function canonicalUrlForIngest(db: DB, job: RawJob): Promise<string> {
  if (job.source !== "workday" && job.source !== "greenhouse") return job.url;
  const pseudo = {
    url: job.url,
    source: job.source,
    company: job.company ?? null,
    external_id: job.externalId ?? null,
  } as JobRow;
  return canonicalPostingUrl(pseudo, await urlCompanies(db)) || job.url;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Upsert a normalized job. New rows start in `discovered`. Existing rows keep
 * their state, bump `last_seen_at`, and backfill any newly-arrived fields.
 */
export async function ingestJob(db: DB, userId: number, job: RawJob): Promise<IngestResult> {
  const key = dedupKey(job);
  // Job ids stay globally unique across users: the owner keeps the original
  // derivation (existing rows keep their ids / Slack deep-links); other users'
  // ids are salted so the same posting captured by two accounts never collides.
  const id = jobIdFromDedupKey(userId === 1 ? key : `u${userId}:${key}`);
  const ts = now();
  const url = await canonicalUrlForIngest(db, job);

  const existing = (await db
    .prepare("SELECT * FROM jobs WHERE user_id = ? AND dedup_key = ?")
    .get(userId, key)) as JobRow | undefined;

  if (existing) {
    // Region status is re-stamped from the merged row: a location/description
    // arriving on a later capture can flip an earlier unknown verdict.
    const mergedLocation = job.location ?? existing.location;
    const mergedDescription = job.description ?? existing.description;
    const regionStatus = await regionStatusFor(db, userId, mergedLocation, mergedDescription);
    // Employment type: only re-stamp when the existing verdict is absent/unknown
    // or the incoming capture carries a structured field (structured beats regex;
    // a later text-only capture never downgrades a structured verdict to unknown).
    let employmentType = existing.employment_type ?? null;
    if (!employmentType || employmentType === "unknown" || job.employmentType) {
      employmentType = classifyEmployment({
        structured: job.employmentType,
        title: job.title ?? existing.title,
        description: mergedDescription,
      });
    }
    // Salary + workplace: re-parse from the merged text; a parse that finds
    // nothing never erases a previously-known salary.
    const salaryParse = parseSalary(
      `${existing.salary_text ?? ""}\n${job.title ?? existing.title}\n${mergedDescription ?? ""}`,
      { defaultCurrency: defaultCurrencyFor(mergedLocation) }
    );
    const workplace = classifyWorkplace(mergedLocation, mergedDescription);
    await db.prepare(
      `UPDATE jobs SET
         last_seen_at = ?,
         company      = COALESCE(?, company),
         location     = COALESCE(?, location),
         description  = COALESCE(?, description),
         posted_at    = COALESCE(?, posted_at),
         posted_text  = COALESCE(?, posted_text),
         url          = COALESCE(?, url),
         region_status = ?,
         employment_type = ?,
         salary_min_cad = COALESCE(?, salary_min_cad),
         salary_max_cad = COALESCE(?, salary_max_cad),
         workplace = ?
       WHERE id = ?`
    ).run(
      ts,
      job.company ?? null,
      job.location ?? null,
      job.description ?? null,
      job.postedAt ?? null,
      job.postedText ?? null,
      url ?? null,
      regionStatus,
      employmentType,
      salaryParse?.minCad ?? null,
      salaryParse?.maxCad ?? null,
      workplace,
      existing.id
    );
    return { id: existing.id, dedupKey: key, isNew: false, state: existing.state };
  }

  const regionStatus = await regionStatusFor(db, userId, job.location, job.description);
  const employmentType = classifyEmployment({
    structured: job.employmentType,
    title: job.title,
    description: job.description,
  });
  const salaryParse = parseSalary(`${job.title}\n${job.description ?? ""}`, {
    defaultCurrency: defaultCurrencyFor(job.location),
  });
  const workplace = classifyWorkplace(job.location, job.description);
  await db.prepare(
    `INSERT INTO jobs
       (id, user_id, dedup_key, source, source_kind, company, title, location, url,
        external_id, description, posted_at, posted_text, state,
        first_seen_at, last_seen_at, region_status, employment_type,
        salary_min_cad, salary_max_cad, workplace)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    userId,
    key,
    job.source,
    job.sourceKind,
    job.company ?? null,
    job.title,
    job.location ?? null,
    url,
    job.externalId ?? null,
    job.description ?? null,
    job.postedAt ?? null,
    job.postedText ?? null,
    "discovered",
    ts,
    ts,
    regionStatus,
    employmentType,
    salaryParse?.minCad ?? null,
    salaryParse?.maxCad ?? null,
    workplace
  );
  bumpDataVersion();
  return { id, dedupKey: key, isNew: true, state: "discovered" };
}

export async function ingestMany(db: DB, userId: number, jobs: RawJob[]): Promise<IngestResult[]> {
  return db.transaction(async () => {
    const out: IngestResult[] = [];
    for (const j of jobs) out.push(await ingestJob(db, userId, j));
    return out;
  });
}

export async function getJob(db: DB, userId: number, id: string): Promise<JobRow | undefined> {
  // URLs are canonicalized at write time (ingest / POST /admin/repair-urls),
  // so reads are pure — no hidden UPDATEs inside GET handlers.
  return (await db
    .prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?")
    .get(id, userId)) as JobRow | undefined;
}

/** Greenhouse/Lever/Ashby all park the form one segment below the posting. */
const APPLY_SUFFIX_RE = /\/(application|apply)\/?$/i;

/** The address bar minus everything that differs between the posting page, the
 *  form page, and whatever tracking the link arrived with. */
export function normalizePostingUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  try {
    const u = new URL(trimmed);
    u.hash = "";
    u.search = "";
    u.pathname = u.pathname.replace(APPLY_SUFFIX_RE, "").replace(/\/$/, "");
    return u.toString();
  } catch {
    return trimmed;
  }
}

/**
 * Resolve the queue job behind an ATS page URL. The phone fill script has only
 * the address bar to identify itself with — no `#jh-apply` handoff from the
 * dashboard, no extension dedup key. Canonical URL first, then the ATS's own id
 * in the last path segment, which survives board-token and host rewrites.
 */
export async function findJobByPostingUrl(
  db: DB,
  userId: number,
  rawUrl: string
): Promise<JobRow | undefined> {
  const url = normalizePostingUrl(rawUrl);
  if (!url) return undefined;
  const exact = (await db
    .prepare("SELECT * FROM jobs WHERE user_id = ? AND (url = ? OR url = ?) ORDER BY first_seen_at DESC")
    .get(userId, url, `${url}/`)) as JobRow | undefined;
  if (exact) return exact;
  const byPrefix = (await db
    .prepare("SELECT * FROM jobs WHERE user_id = ? AND url LIKE ? ORDER BY first_seen_at DESC")
    .get(userId, `${url}%`)) as JobRow | undefined;
  if (byPrefix) return byPrefix;
  // Board tokens and branded hosts get rewritten; the posting id does not.
  const externalId = url.split("/").filter(Boolean).pop() ?? "";
  if (externalId.length < 6) return undefined;
  return (await db
    .prepare("SELECT * FROM jobs WHERE user_id = ? AND external_id = ? ORDER BY first_seen_at DESC")
    .get(userId, externalId)) as JobRow | undefined;
}

export interface ListJobsQuery {
  state?: JobState;
  source?: string;
  sourceKind?: SourceKind;
  minScore?: number;
  /** Drop jobs scored exactly 0 (out-of-region / no match). Keeps unscored (null). */
  excludeZeroScore?: boolean;
  /** Drop jobs with no relevance score yet (null). With excludeZeroScore → only score > 0. */
  excludeUnscored?: boolean;
  sort?: "score" | "first_seen";
  /**
   * Only rows with COALESCE(posted_at, first_seen_at) >= this epoch-ms. Applied in
   * SQL (not post-fetch) so sort + limit operate on the fresh set — otherwise a
   * score-sorted top-N is filled by stale high-scored rows and freshness culls them.
   */
  freshSince?: number;
  /** Drop rows stamped out-of-region (region_status = 'out'); unknown (NULL) stays visible. */
  inRegionOnly?: boolean;
  /** Drop rows in any of these states (e.g. ['applied','skipped'] for the shortlist). */
  excludeStates?: JobState[];
  /** Filter by employment type; 'unknown' also matches NULL (pre-migration rows). */
  employmentType?: EmploymentType;
  /** Apply the salary bottom line (config.salary): known-below-floor rows drop;
   *  unknown salary always passes (surfaced with a tag instead). */
  salaryFloor?: boolean;
  limit?: number;
  offset?: number;
  /** List API omits heavy JD text (queue cards don't need it). */
  omitDescription?: boolean;
}

const JOB_LIST_COLS =
  "id, dedup_key, source, source_kind, company, title, location, url, external_id, " +
  "relevance_score, relevance_reason, state, posted_at, posted_text, " +
  "first_seen_at, last_seen_at, viewed_at, notified_at, applied_at, notes, region_status, " +
  "scored_by, scored_at, employment_type, salary_min_cad, salary_max_cad, workplace";

export async function listJobs(db: DB, userId: number, q: ListJobsQuery): Promise<JobRow[]> {
  const where: string[] = ["user_id = ?"];
  const params: unknown[] = [userId];
  if (q.state) {
    where.push("state = ?");
    params.push(q.state);
  }
  if (q.source) {
    where.push("source = ?");
    params.push(q.source);
  }
  if (q.sourceKind) {
    where.push("source_kind = ?");
    params.push(q.sourceKind);
  }
  if (typeof q.minScore === "number") {
    where.push("relevance_score >= ?");
    params.push(q.minScore);
  }
  if (q.excludeZeroScore) {
    where.push("(relevance_score IS NULL OR relevance_score > 0)");
  }
  if (q.excludeUnscored) {
    where.push("relevance_score IS NOT NULL");
  }
  if (typeof q.freshSince === "number") {
    where.push("COALESCE(posted_at, first_seen_at) >= ?");
    params.push(q.freshSince);
  }
  if (q.inRegionOnly) {
    where.push("(region_status IS NULL OR region_status != 'out')");
  }
  if (q.excludeStates?.length) {
    where.push(`state NOT IN (${q.excludeStates.map(() => "?").join(",")})`);
    params.push(...q.excludeStates);
  }
  if (q.employmentType) {
    if (q.employmentType === "unknown") {
      where.push("(employment_type IS NULL OR employment_type = 'unknown')");
    } else {
      where.push("employment_type = ?");
      params.push(q.employmentType);
    }
  }
  if (q.salaryFloor) {
    const [sql, p] = salaryFloorSql();
    where.push(sql);
    params.push(...p);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // Inactive jobs (applied OR skipped) sink to the bottom; active/un-actioned jobs
  // stay on top. The recency key is COALESCE(posted_at, first_seen_at) so the order
  // matches the timestamp the dashboard card shows ("X ago" = posted, else discovered).
  const inactiveLast = "CASE WHEN state IN ('applied','skipped') THEN 1 ELSE 0 END ASC";
  const recency = "COALESCE(posted_at, first_seen_at) DESC";
  const orderSql =
    q.sort === "score"
      ? `ORDER BY ${inactiveLast}, relevance_score DESC NULLS LAST, ${recency}`
      : `ORDER BY ${inactiveLast}, ${recency}`;
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);
  params.push(limit, offset);
  const cols = q.omitDescription ? JOB_LIST_COLS : "*";
  return (await db
    .prepare(`SELECT ${cols} FROM jobs ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
    .all(...params)) as JobRow[];
}

export interface SeenEntry {
  state: JobState;
  id: string;
  /** Stored relevance score/reason — lets the scan overlay repaint final scores after JD backfill. */
  score: number | null;
  reason: string | null;
}

/** Map dedup keys → state for extension badges / masking (cap 200). */
export async function seenStates(db: DB, userId: number, keys: string[]): Promise<Record<string, SeenEntry | null>> {
  const capped = keys.slice(0, 200);
  const out: Record<string, SeenEntry | null> = {};
  const stmt = db.prepare(
    "SELECT id, state, relevance_score, relevance_reason FROM jobs WHERE user_id = ? AND dedup_key = ?"
  );
  for (const k of capped) {
    const row = (await stmt.get(userId, k)) as
      | { id: string; state: JobState; relevance_score: number | null; relevance_reason: string | null }
      | undefined;
    out[k] = row
      ? { state: row.state, id: row.id, score: row.relevance_score, reason: row.relevance_reason }
      : null;
  }
  return out;
}

export async function setJobState(db: DB, userId: number, id: string, to: JobState): Promise<JobRow> {
  const job = await getJob(db, userId, id);
  if (!job) throw new NotFoundError(`job ${id}`);
  assertTransition(job.state, to);
  const ts = now();
  await db.prepare("UPDATE jobs SET state = ?, last_seen_at = ? WHERE id = ?").run(to, ts, id);
  if (to === "notified") await db.prepare("UPDATE jobs SET notified_at = ? WHERE id = ?").run(ts, id);
  if (to === "applied") await db.prepare("UPDATE jobs SET applied_at = ? WHERE id = ?").run(ts, id);
  bumpDataVersion();
  return (await getJob(db, userId, id))!;
}

export async function setJobNotes(db: DB, userId: number, id: string, notes: string): Promise<JobRow> {
  const job = await getJob(db, userId, id);
  if (!job) throw new NotFoundError(`job ${id}`);
  await db.prepare("UPDATE jobs SET notes = ? WHERE id = ?").run(notes, id);
  return (await getJob(db, userId, id))!;
}

export type ScoredBy = "llm" | "heuristic" | "region" | "triage" | "dealbreaker";

export async function setRelevance(
  db: DB,
  userId: number,
  id: string,
  score: number,
  reason: string,
  opts: { regionStatus?: "in" | "out"; method?: ScoredBy } = {}
): Promise<void> {
  const sets = ["relevance_score = ?", "relevance_reason = ?"];
  const params: unknown[] = [score, reason];
  if (opts.regionStatus) {
    sets.push("region_status = ?");
    params.push(opts.regionStatus);
  }
  if (opts.method) {
    sets.push("scored_by = ?", "scored_at = ?");
    params.push(opts.method, now());
  }
  params.push(id, userId);
  await db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
  bumpDataVersion();
}

/**
 * Machine skip (score below the screening threshold). Distinct from a human skip
 * via auto_skipped_at, so a bad threshold is bulk-reversible:
 *   UPDATE jobs SET state='relevant', auto_skipped_at=NULL WHERE auto_skipped_at IS NOT NULL
 */
export async function autoSkipJob(db: DB, userId: number, id: string): Promise<void> {
  const job = await getJob(db, userId, id);
  if (!job) throw new NotFoundError(`job ${id}`);
  assertTransition(job.state, "skipped");
  await db.prepare(
    "UPDATE jobs SET state = 'skipped', auto_skipped_at = ?, last_seen_at = ? WHERE id = ?"
  ).run(now(), now(), id);
  bumpDataVersion();
}

/** Bulk-apply the auto-skip threshold to already-scored discovered jobs (backfill). */
export async function bulkAutoScreen(db: DB, userId: number, threshold: number): Promise<{ skipped: number }> {
  const ts = now();
  const info = await db
    .prepare(
      `UPDATE jobs SET state = 'skipped', auto_skipped_at = ?, last_seen_at = ?
       WHERE user_id = ? AND state = 'discovered' AND scored_by = 'llm'
         AND relevance_score >= 0 AND relevance_score < ?`
    )
    .run(ts, ts, userId, threshold);
  if (info.changes) bumpDataVersion();
  return { skipped: info.changes };
}

export interface JobFacets {
  states: { value: string; count: number }[];
  sources: { value: string; count: number }[];
  sourceKinds: { value: string; count: number }[];
  employmentTypes: { value: string; count: number }[];
  total: number;
}

/**
 * Facet counts for the queue filter dropdowns. Applies the same base filters as
 * the queue list (freshness / region / score visibility) but NOT the dimension
 * selections themselves, so every option stays discoverable with its count.
 */
export async function jobFacets(
  db: DB,
  userId: number,
  q: {
    freshSince?: number;
    inRegionOnly?: boolean;
    excludeZeroScore?: boolean;
    excludeUnscored?: boolean;
  } = {}
): Promise<JobFacets> {
  const where: string[] = ["user_id = ?"];
  const params: unknown[] = [userId];
  if (typeof q.freshSince === "number") {
    where.push("COALESCE(posted_at, first_seen_at) >= ?");
    params.push(q.freshSince);
  }
  if (q.inRegionOnly) where.push("(region_status IS NULL OR region_status != 'out')");
  if (q.excludeZeroScore) where.push("(relevance_score IS NULL OR relevance_score > 0)");
  if (q.excludeUnscored) where.push("relevance_score IS NOT NULL");
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const facet = async (col: string) =>
    (
      (await db
        .prepare(`SELECT ${col} AS value, count(*) AS count FROM jobs ${whereSql} GROUP BY ${col} ORDER BY count DESC`)
        .all(...params)) as { value: string; count: number }[]
    ).filter((r) => r.value != null);

  const total = (
    (await db.prepare(`SELECT count(*) AS c FROM jobs ${whereSql}`).get(...params)) as { c: number }
  ).c;

  return {
    states: await facet("state"),
    sources: await facet("source"),
    sourceKinds: await facet("source_kind"),
    employmentTypes: await facet("COALESCE(employment_type, 'unknown')"),
    total,
  };
}

export async function setViewed(db: DB, userId: number, id: string): Promise<void> {
  await db
    .prepare("UPDATE jobs SET viewed_at = COALESCE(viewed_at, ?) WHERE id = ? AND user_id = ?")
    .run(now(), id, userId);
}

/** Listing captures (extension ingest) — mark applied so they don't clutter the ATS queue. */
export async function markExtensionCaptureJobsApplied(db: DB, userId: number, jobIds?: string[]): Promise<number> {
  const ts = now();
  let changes: number;
  if (jobIds?.length) {
    const placeholders = jobIds.map(() => "?").join(",");
    changes = (
      await db
        .prepare(
          `UPDATE jobs SET state = 'applied', applied_at = COALESCE(applied_at, ?), last_seen_at = ?
           WHERE user_id = ? AND source_kind = 'extension' AND state != 'applied' AND id IN (${placeholders})`
        )
        .run(ts, ts, userId, ...jobIds)
    ).changes;
  } else {
    changes = (
      await db
        .prepare(
          `UPDATE jobs SET state = 'applied', applied_at = COALESCE(applied_at, ?), last_seen_at = ?
           WHERE user_id = ? AND source_kind = 'extension' AND state != 'applied'`
        )
        .run(ts, ts, userId)
    ).changes;
  }
  if (changes) bumpDataVersion();
  return changes;
}

/** Jobs that are freshly ingested and not yet scored. */
export interface UnscoredJobsQuery {
  /** Only jobs within FRESHNESS_HOURS (posted_at or first_seen_at). */
  freshOnly?: boolean;
  /** Only jobs matching profile allowed regions (US/CA). */
  inRegionOnly?: boolean;
  limit?: number;
}

export async function listUnscoredJobs(db: DB, userId: number, q: UnscoredJobsQuery = {}): Promise<JobRow[]> {
  const limit = Math.min(Math.max(q.limit ?? 500, 1), 500);
  const where = ["user_id = ?", "relevance_score IS NULL"];
  const params: unknown[] = [userId];
  if (q.freshOnly) {
    where.push("COALESCE(posted_at, first_seen_at) >= ?");
    params.push(Date.now() - freshnessMs());
  }
  if (q.inRegionOnly) {
    where.push("(region_status IS NULL OR region_status != 'out')");
  }
  params.push(limit);
  return (await db
    .prepare(
      `SELECT * FROM jobs WHERE ${where.join(" AND ")}
       ORDER BY COALESCE(posted_at, first_seen_at) DESC LIMIT ?`
    )
    .all(...params)) as JobRow[];
}

/** Counts unscored jobs for the dashboard badge (pure SQL, no row scan). */
export async function unscoredJobsStats(db: DB, userId: number): Promise<{
  total: number;
  fresh: number;
  freshInRegion: number;
}> {
  const count = async (sql: string, ...params: unknown[]) =>
    ((await db.prepare(sql).get(...params)) as { c: number }).c;
  const freshCut = Date.now() - freshnessMs();
  const total = await count(
    "SELECT count(*) as c FROM jobs WHERE user_id = ? AND relevance_score IS NULL",
    userId
  );
  const fresh = await count(
    `SELECT count(*) as c FROM jobs
     WHERE user_id = ? AND relevance_score IS NULL AND COALESCE(posted_at, first_seen_at) >= ?`,
    userId,
    freshCut
  );
  const freshInRegion = await count(
    `SELECT count(*) as c FROM jobs
     WHERE user_id = ? AND relevance_score IS NULL AND COALESCE(posted_at, first_seen_at) >= ?
       AND (region_status IS NULL OR region_status != 'out')`,
    userId,
    freshCut
  );
  return { total, fresh, freshInRegion };
}

/**
 * Stamp region_status on legacy rows that predate the column (one-off backfill).
 * Deterministic regex check — no LLM. Batched so an 11k-row table doesn't sit
 * in memory at once.
 */
export async function backfillRegionStatus(db: DB, userId: number): Promise<{ updated: number }> {
  const prefs = (await getProfile(db, userId)).preferences;
  const stamp = db.prepare("UPDATE jobs SET region_status = ? WHERE id = ?");
  let updated = 0;
  for (;;) {
    const rows = (await db
      .prepare(
        "SELECT id, location, description FROM jobs WHERE user_id = ? AND region_status IS NULL LIMIT 500"
      )
      .all(userId)) as Pick<JobRow, "id" | "location" | "description">[];
    if (!rows.length) break;
    for (const r of rows) {
      await stamp.run(isJobInAllowedRegions(r.location, r.description, prefs) ? "in" : "out", r.id);
      updated++;
    }
  }
  return { updated };
}

/**
 * Classify employment_type on rows that predate the column (one-off backfill).
 * Regex-only — the original structured source fields are gone for old rows.
 * Batched like backfillRegionStatus.
 */
/** One-off stamp of salary_min/max_cad + workplace on rows that predate the
 *  columns (mirrors backfillEmploymentType). Re-runnable: only touches rows
 *  with workplace IS NULL. */
export async function backfillSalary(
  db: DB,
  userId: number
): Promise<{ updated: number; withSalary: number; belowFloor: number }> {
  const stamp = db.prepare(
    "UPDATE jobs SET salary_min_cad = ?, salary_max_cad = ?, workplace = ? WHERE id = ?"
  );
  let updated = 0;
  let withSalary = 0;
  let belowFloor = 0;
  for (;;) {
    const rows = (await db
      .prepare(
        "SELECT id, title, location, description, salary_text FROM jobs WHERE user_id = ? AND workplace IS NULL LIMIT 500"
      )
      .all(userId)) as Pick<JobRow, "id" | "title" | "location" | "description" | "salary_text">[];
    if (!rows.length) break;
    for (const r of rows) {
      const parse = parseSalary(`${r.salary_text ?? ""}\n${r.title}\n${r.description ?? ""}`, {
        defaultCurrency: defaultCurrencyFor(r.location),
        trusted: false,
      });
      const workplace = classifyWorkplace(r.location, r.description);
      await stamp.run(parse?.minCad ?? null, parse?.maxCad ?? null, workplace, r.id);
      updated++;
      if (parse) {
        withSalary++;
        if (parse.maxCad < floorFor(workplace)) belowFloor++;
      }
    }
  }
  if (updated) bumpDataVersion();
  return { updated, withSalary, belowFloor };
}

export async function backfillEmploymentType(
  db: DB,
  userId: number
): Promise<{ updated: number; counts: Record<string, number> }> {
  const stamp = db.prepare("UPDATE jobs SET employment_type = ? WHERE id = ?");
  let updated = 0;
  const counts: Record<string, number> = {};
  for (;;) {
    const rows = (await db
      .prepare(
        "SELECT id, title, description FROM jobs WHERE user_id = ? AND employment_type IS NULL LIMIT 500"
      )
      .all(userId)) as Pick<JobRow, "id" | "title" | "description">[];
    if (!rows.length) break;
    for (const r of rows) {
      const t = classifyEmployment({ title: r.title, description: r.description });
      await stamp.run(t, r.id);
      counts[t] = (counts[t] ?? 0) + 1;
      updated++;
    }
  }
  if (updated) bumpDataVersion();
  return { updated, counts };
}

/** Canonicalize stored posting URLs (one-off; new rows are fixed at ingest). */
export async function repairPostingUrls(db: DB, userId: number): Promise<{ updated: number }> {
  const rows = (await db
    .prepare(
      `SELECT id, source, company, external_id, url FROM jobs
       WHERE user_id = ? AND source IN ('workday', 'greenhouse')`
    )
    .all(userId)) as JobRow[];
  const cos = await urlCompanies(db);
  const upd = db.prepare("UPDATE jobs SET url = ? WHERE id = ?");
  let updated = 0;
  for (const job of rows) {
    const url = canonicalPostingUrl(job, cos);
    if (url && url !== job.url) {
      await upd.run(url, job.id);
      updated++;
    }
  }
  return { updated };
}

/** Lightweight counts for dashboard tab badges (no full job list fetch). */
export async function tabBadgeCounts(db: DB, userId: number): Promise<{
  queue: number;
  captures: number;
  referrals: number;
  keywords: number;
}> {
  const queue = (
    (await db.prepare(
      "SELECT count(*) as c FROM jobs WHERE user_id = ? AND state NOT IN ('applied', 'skipped')"
    ).get(userId)) as { c: number }
  ).c;
  const captures = (
    (await db.prepare("SELECT count(*) as c FROM page_captures WHERE user_id = ?").get(userId)) as { c: number }
  ).c;
  const referrals = (
    (await db.prepare("SELECT count(*) as c FROM referrals WHERE user_id = ? AND state = 'new'").get(userId)) as {
      c: number;
    }
  ).c;
  const keywords = (
    (await db
      .prepare("SELECT count(*) as c FROM keyword_suggestions WHERE user_id = ? AND status = 'suggested'")
      .get(userId)) as { c: number }
  ).c;
  return { queue, captures, referrals, keywords };
}

/** All unscored jobs (legacy — no freshness/region filter). */
export async function unscoredJobs(db: DB, userId: number): Promise<JobRow[]> {
  return listUnscoredJobs(db, userId, { limit: 500 });
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export async function listCompanies(db: DB, userId: number, onlyEnabled = false): Promise<CompanyRow[]> {
  const sql = onlyEnabled
    ? "SELECT * FROM companies WHERE user_id = ? AND enabled = 1 ORDER BY name"
    : "SELECT * FROM companies WHERE user_id = ? ORDER BY name";
  return (await db.prepare(sql).all(userId)) as CompanyRow[];
}

export async function addCompany(
  db: DB,
  userId: number,
  c: { name: string; ats: string; boardToken: string; enabled?: boolean }
): Promise<CompanyRow> {
  const info = await db
    .prepare("INSERT INTO companies (user_id, name, ats, board_token, enabled) VALUES (?,?,?,?,?)")
    .run(userId, c.name, c.ats, c.boardToken, c.enabled === false ? 0 : 1);
  invalidateCompanyCache(db);
  return (await db.prepare("SELECT * FROM companies WHERE id = ?").get(info.lastInsertRowid)) as CompanyRow;
}

export async function setCompanyEnabled(db: DB, userId: number, id: number, enabled: boolean): Promise<void> {
  if (enabled) {
    // A human re-enable clears the auto-disable marker (and its alert).
    await db.prepare(
      "UPDATE companies SET enabled = 1, auto_disabled_at = NULL, auto_disabled_reason = NULL WHERE id = ? AND user_id = ?"
    ).run(id, userId);
  } else {
    await db.prepare("UPDATE companies SET enabled = 0 WHERE id = ? AND user_id = ?").run(id, userId);
  }
  invalidateCompanyCache(db);
}

export async function updateCompany(
  db: DB,
  userId: number,
  id: number,
  patch: { ats?: string; boardToken?: string; enabled?: boolean }
): Promise<CompanyRow> {
  const row = (await db
    .prepare("SELECT * FROM companies WHERE id = ? AND user_id = ?")
    .get(id, userId)) as CompanyRow | undefined;
  if (!row) throw new NotFoundError(`company ${id}`);
  await db.prepare(
    `UPDATE companies SET
       ats = COALESCE(?, ats),
       board_token = COALESCE(?, board_token),
       enabled = COALESCE(?, enabled)
     WHERE id = ?`
  ).run(
    patch.ats ?? null,
    patch.boardToken ?? null,
    patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
    id
  );
  invalidateCompanyCache(db);
  return (await db.prepare("SELECT * FROM companies WHERE id = ?").get(id)) as CompanyRow;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface Profile {
  masterResume: string | null;
  preferences: Preferences;
  screeningAnswers: Record<string, string>;
}

export async function getProfile(db: DB, userId: number): Promise<Profile> {
  const row = (await db.prepare("SELECT * FROM profile WHERE user_id = ?").get(userId)) as
    | { master_resume: string | null; preferences_json: string | null; screening_answers_json: string | null }
    | undefined;
  return {
    masterResume: row?.master_resume ?? null,
    preferences: row?.preferences_json ? JSON.parse(row.preferences_json) : {},
    screeningAnswers: row?.screening_answers_json ? JSON.parse(row.screening_answers_json) : {},
  };
}

export async function setProfile(db: DB, userId: number, p: Partial<Profile>): Promise<Profile> {
  const current = await getProfile(db, userId);
  const merged: Profile = {
    masterResume: p.masterResume !== undefined ? p.masterResume : current.masterResume,
    preferences: p.preferences ?? current.preferences,
    screeningAnswers: p.screeningAnswers ?? current.screeningAnswers,
  };
  await db.prepare(
    `INSERT INTO profile (user_id, master_resume, preferences_json, screening_answers_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       master_resume = excluded.master_resume,
       preferences_json = excluded.preferences_json,
       screening_answers_json = excluded.screening_answers_json`
  ).run(
    userId,
    merged.masterResume,
    JSON.stringify(merged.preferences),
    JSON.stringify(merged.screeningAnswers)
  );
  return merged;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`Not found: ${what}`);
    this.name = "NotFoundError";
  }
}
