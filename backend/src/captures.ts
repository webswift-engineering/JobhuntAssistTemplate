import { createHash } from "node:crypto";
import type { DB } from "./db/client.js";
import { bumpDataVersion } from "./dataVersion.js";
import { jobIdFromDedupKey } from "./dedup.js";
import type { CaptureEventType, ReferralState } from "./types.js";
import { getJob, ingestJob, regionStatusFor, setViewed } from "./store.js";

const now = () => Date.now();

// ---------------------------------------------------------------------------
// Capture events (Path B) — NEVER writes poll_runs
// ---------------------------------------------------------------------------

export interface CaptureEventInput {
  source: string;
  event: CaptureEventType;
  jobId?: string | null;
  url?: string | null;
  meta?: Record<string, unknown> | null;
}

export async function recordEvent(db: DB, userId: number, e: CaptureEventInput): Promise<{ id: number }> {
  const info = await db
    .prepare(
      "INSERT INTO capture_events (user_id, source, event, job_id, url, meta_json, occurred_at) VALUES (?,?,?,?,?,?,?)"
    )
    .run(
      userId,
      e.source,
      e.event,
      e.jobId ?? null,
      e.url ?? null,
      e.meta ? JSON.stringify(e.meta) : null,
      now()
    );
  // A 'viewed' event is an interest signal → stamp jobs.viewed_at (§6.2 role 2).
  if (e.event === "viewed" && e.jobId) await setViewed(db, userId, e.jobId);
  bumpDataVersion();
  return { id: Number(info.lastInsertRowid) };
}

// ---------------------------------------------------------------------------
// Page captures (apply-moment snapshots) — may create an off-pipeline job row
// ---------------------------------------------------------------------------

export interface PageCaptureInput {
  url: string;
  source?: string | null;
  rawText: string;
  jobId?: string | null;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  externalId?: string | null;
  salaryText?: string | null;
  captureKind?: "right_click" | "apply_page";
  meta?: Record<string, unknown> | null;
}

const JD_MAX = 50000;

async function upsertJobFromCapture(db: DB, userId: number, c: PageCaptureInput, jobId: string | null): Promise<string> {
  const desc = c.rawText.slice(0, JD_MAX);
  if (!jobId) {
    const res = await ingestJob(db, userId, {
      source: c.source ?? "capture",
      sourceKind: "extension",
      company: c.company ?? null,
      title: c.title ?? "(captured application)",
      location: c.location ?? null,
      url: c.url,
      externalId: c.externalId ?? null,
      description: desc,
    });
    jobId = res.id;
  }
  const existing = await getJob(db, userId, jobId);
  if (existing) {
    const isRealJd = (t: string) =>
      /about the job/i.test(t) || t.length > 2500;
    const keepDesc =
      isRealJd(desc) &&
      (!isRealJd(existing.description ?? "") || desc.length >= (existing.description?.length ?? 0))
        ? desc
        : (existing.description?.length ?? 0) >= desc.length
          ? existing.description
          : desc;
    // Captured JD/location can flip the region verdict — re-stamp from merged values.
    const regionStatus = await regionStatusFor(db, userId, c.location ?? existing.location, keepDesc);
    await db.prepare(
      `UPDATE jobs SET
         last_seen_at = ?,
         company      = COALESCE(?, company),
         title          = COALESCE(?, title),
         location       = COALESCE(?, location),
         description    = ?,
         salary_text    = COALESCE(?, salary_text),
         url            = COALESCE(?, url),
         region_status  = ?
       WHERE id = ?`
    ).run(
      now(),
      c.company ?? null,
      c.title ?? null,
      c.location ?? null,
      keepDesc,
      c.salaryText ?? null,
      c.url ?? null,
      regionStatus,
      jobId
    );
  }
  return jobId;
}

export async function recordPageCapture(
  db: DB,
  userId: number,
  c: PageCaptureInput
): Promise<{ id: number; jobId: string | null }> {
  const jobId = await upsertJobFromCapture(db, userId, c, c.jobId ?? null);

  // Re-capture same job → refresh the latest row instead of duplicating in the UI.
  const existing = (await db
    .prepare("SELECT id FROM page_captures WHERE job_id = ? ORDER BY id DESC LIMIT 1")
    .get(jobId)) as { id: number } | undefined;

  if (existing) {
    await db.prepare(
      `UPDATE page_captures SET
         url = ?, source = ?, title = ?, company = ?, location = ?,
         salary_text = ?, capture_kind = ?, raw_text = ?, meta_json = ?, captured_at = ?
       WHERE id = ?`
    ).run(
      c.url,
      c.source ?? null,
      c.title ?? null,
      c.company ?? null,
      c.location ?? null,
      c.salaryText ?? null,
      c.captureKind ?? "right_click",
      c.rawText.slice(0, JD_MAX),
      c.meta ? JSON.stringify(c.meta) : null,
      now(),
      existing.id
    );
    bumpDataVersion();
    return { id: existing.id, jobId };
  }

  const info = await db
    .prepare(
      `INSERT INTO page_captures
        (user_id, job_id, url, source, title, company, location, salary_text, capture_kind, raw_text, meta_json, captured_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      userId,
      jobId,
      c.url,
      c.source ?? null,
      c.title ?? null,
      c.company ?? null,
      c.location ?? null,
      c.salaryText ?? null,
      c.captureKind ?? "right_click",
      c.rawText.slice(0, JD_MAX),
      c.meta ? JSON.stringify(c.meta) : null,
      now()
    );
  bumpDataVersion();
  return { id: Number(info.lastInsertRowid), jobId };
}

export async function latestPageCapture(db: DB, userId: number, jobId: string): Promise<{ raw_text: string } | undefined> {
  return (await db
    .prepare(
      "SELECT raw_text FROM page_captures WHERE job_id = ? AND user_id = ? ORDER BY captured_at DESC LIMIT 1"
    )
    .get(jobId, userId)) as { raw_text: string } | undefined;
}

export interface CaptureListRow {
  capture_id: number;
  job_id: string;
  url: string;
  source: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  salary_text: string | null;
  capture_kind: string | null;
  raw_text: string;
  captured_at: number;
  job_state: string;
  job_title: string;
  resume_generated_at: number | null;
  resume_formats: string | null;
}

/** Dashboard Captures tab — latest snapshot per job (deduped). */
export async function listCaptures(db: DB, userId: number, limit = 100): Promise<CaptureListRow[]> {
  return (await db
    .prepare(
      `SELECT
         pc.id AS capture_id,
         pc.job_id,
         pc.url,
         pc.source,
         pc.title,
         pc.company,
         pc.location,
         pc.salary_text,
         pc.capture_kind,
         pc.raw_text,
         pc.captured_at,
         j.state AS job_state,
         j.title AS job_title,
         (SELECT MAX(generated_at) FROM resume_artifacts ra WHERE ra.job_id = pc.job_id) AS resume_generated_at,
         (SELECT string_agg(format, ',') FROM resume_artifacts ra WHERE ra.job_id = pc.job_id) AS resume_formats
       FROM page_captures pc
       JOIN jobs j ON j.id = pc.job_id
       INNER JOIN (
         SELECT job_id, MAX(id) AS latest_id
         FROM page_captures
         GROUP BY job_id
       ) latest ON pc.id = latest.latest_id
       WHERE pc.user_id = ?
       ORDER BY pc.captured_at DESC
       LIMIT ?`
    )
    .all(userId, Math.min(limit, 200))) as CaptureListRow[];
}

export async function getCapture(db: DB, userId: number, captureId: number): Promise<CaptureListRow | undefined> {
  return (await db
    .prepare(
      `SELECT
         pc.id AS capture_id,
         pc.job_id,
         pc.url,
         pc.source,
         pc.title,
         pc.company,
         pc.location,
         pc.salary_text,
         pc.capture_kind,
         pc.raw_text,
         pc.captured_at,
         j.state AS job_state,
         j.title AS job_title,
         (SELECT MAX(generated_at) FROM resume_artifacts ra WHERE ra.job_id = pc.job_id) AS resume_generated_at,
         (SELECT string_agg(format, ',') FROM resume_artifacts ra WHERE ra.job_id = pc.job_id) AS resume_formats
       FROM page_captures pc
       JOIN jobs j ON j.id = pc.job_id
       WHERE pc.id = ? AND pc.user_id = ?`
    )
    .get(captureId, userId)) as CaptureListRow | undefined;
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

export interface ReferralRow {
  id: string;
  source: string;
  company: string | null;
  roles: string | null;
  referrer: string | null;
  contact: string | null;
  deadline: string | null;
  thread_url: string;
  raw_text: string | null;
  dedup_key: string;
  state: ReferralState;
  job_id: string | null;
  captured_at: number;
}

export interface UpsertReferralInput {
  source?: string;
  company?: string | null;
  roles?: string[];
  referrer?: string | null;
  contact?: string | null;
  deadline?: string | null;
  threadUrl: string;
  rawText?: string | null;
  index?: number; // disambiguate multiple referrals from the same thread
}

function referralDedupKey(threadUrl: string, index = 0): string {
  const base = `ref:${createHash("sha1").update(threadUrl).digest("hex")}`;
  return index > 0 ? `${base}:${index}` : base;
}

export async function upsertReferral(db: DB, userId: number, r: UpsertReferralInput): Promise<ReferralRow> {
  const dedup = referralDedupKey(r.threadUrl, r.index ?? 0);
  const id = jobIdFromDedupKey(userId === 1 ? dedup : `u${userId}:${dedup}`);
  const existing = (await db
    .prepare("SELECT * FROM referrals WHERE user_id = ? AND dedup_key = ?")
    .get(userId, dedup)) as ReferralRow | undefined;
  const rolesStr = r.roles && r.roles.length ? r.roles.join(", ") : null;

  if (existing) {
    await db.prepare(
      `UPDATE referrals SET company=COALESCE(?,company), roles=COALESCE(?,roles),
        referrer=COALESCE(?,referrer), contact=COALESCE(?,contact),
        deadline=COALESCE(?,deadline), raw_text=COALESCE(?,raw_text) WHERE user_id=? AND dedup_key=?`
    ).run(
      r.company ?? null,
      rolesStr,
      r.referrer ?? null,
      r.contact ?? null,
      r.deadline ?? null,
      r.rawText ?? null,
      userId,
      dedup
    );
    return (await db
      .prepare("SELECT * FROM referrals WHERE user_id = ? AND dedup_key = ?")
      .get(userId, dedup)) as ReferralRow;
  }

  await db.prepare(
    `INSERT INTO referrals
      (id, user_id, source, company, roles, referrer, contact, deadline, thread_url, raw_text, dedup_key, state, captured_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'new', ?)`
  ).run(
    id,
    userId,
    r.source ?? "forum",
    r.company ?? null,
    rolesStr,
    r.referrer ?? null,
    r.contact ?? null,
    r.deadline ?? null,
    r.threadUrl,
    r.rawText ?? null,
    dedup,
    now()
  );
  bumpDataVersion();
  return (await db.prepare("SELECT * FROM referrals WHERE id = ?").get(id)) as ReferralRow;
}

export async function listReferrals(db: DB, userId: number, state?: ReferralState): Promise<ReferralRow[]> {
  return state
    ? ((await db
        .prepare("SELECT * FROM referrals WHERE user_id = ? AND state = ? ORDER BY captured_at DESC")
        .all(userId, state)) as ReferralRow[])
    : ((await db
        .prepare("SELECT * FROM referrals WHERE user_id = ? ORDER BY captured_at DESC")
        .all(userId)) as ReferralRow[]);
}

const REFERRAL_STATES: ReferralState[] = ["new", "contacted", "applied", "skipped"];

export async function updateReferral(
  db: DB,
  userId: number,
  id: string,
  patch: { state?: ReferralState; jobId?: string | null; notes?: string }
): Promise<ReferralRow> {
  const existing = (await db
    .prepare("SELECT * FROM referrals WHERE id = ? AND user_id = ?")
    .get(id, userId)) as ReferralRow | undefined;
  if (!existing) throw new Error(`referral ${id} not found`);
  if (patch.state && !REFERRAL_STATES.includes(patch.state)) {
    throw new Error(`invalid referral state ${patch.state}`);
  }
  await db.prepare("UPDATE referrals SET state=COALESCE(?,state), job_id=COALESCE(?,job_id) WHERE id=?").run(
    patch.state ?? null,
    patch.jobId ?? null,
    id
  );
  return (await db.prepare("SELECT * FROM referrals WHERE id = ?").get(id)) as ReferralRow;
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export async function recordApplication(
  db: DB,
  userId: number,
  jobId: string,
  data: { resumeVariant?: string; coverLetter?: string; notes?: string }
): Promise<void> {
  await db.prepare(
    `INSERT INTO applications (job_id, user_id, applied_at, resume_variant, cover_letter, notes)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(job_id) DO UPDATE SET
       applied_at=excluded.applied_at,
       resume_variant=COALESCE(excluded.resume_variant, applications.resume_variant),
       cover_letter=COALESCE(excluded.cover_letter, applications.cover_letter),
       notes=COALESCE(excluded.notes, applications.notes)`
  ).run(jobId, userId, now(), data.resumeVariant ?? null, data.coverLetter ?? null, data.notes ?? null);
}

// ---------------------------------------------------------------------------
// Keyword suggestions
// ---------------------------------------------------------------------------

export interface KeywordRow {
  id: number;
  term: string;
  rationale: string | null;
  created_at: number;
  status: "suggested" | "used" | "dismissed";
}

export async function addKeywordSuggestion(db: DB, userId: number, term: string, rationale: string): Promise<void> {
  // Avoid duplicate suggested terms.
  const exists = await db
    .prepare("SELECT 1 FROM keyword_suggestions WHERE user_id = ? AND term = ? AND status = 'suggested'")
    .get(userId, term);
  if (exists) return;
  await db.prepare(
    "INSERT INTO keyword_suggestions (user_id, term, rationale, created_at, status) VALUES (?,?,?,?, 'suggested')"
  ).run(userId, term, rationale, now());
}

export async function listKeywords(db: DB, userId: number, status?: string): Promise<KeywordRow[]> {
  return status
    ? ((await db
        .prepare("SELECT * FROM keyword_suggestions WHERE user_id = ? AND status = ? ORDER BY created_at DESC")
        .all(userId, status)) as KeywordRow[])
    : ((await db
        .prepare("SELECT * FROM keyword_suggestions WHERE user_id = ? ORDER BY created_at DESC")
        .all(userId)) as KeywordRow[]);
}

export async function updateKeyword(db: DB, userId: number, id: number, status: string): Promise<KeywordRow> {
  await db
    .prepare("UPDATE keyword_suggestions SET status = ? WHERE id = ? AND user_id = ?")
    .run(status, id, userId);
  return (await db.prepare("SELECT * FROM keyword_suggestions WHERE id = ?").get(id)) as KeywordRow;
}

// ---------------------------------------------------------------------------
// Poll runs + stats
// ---------------------------------------------------------------------------

import { reconcileStalePollRuns } from "./scheduler.js";

export async function listPollRuns(db: DB, userId: number, limit = 50): Promise<unknown[]> {
  await reconcileStalePollRuns(db);
  return db
    .prepare("SELECT * FROM poll_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(userId, Math.min(limit, 200));
}

export async function lastPollRun(db: DB, userId: number): Promise<unknown> {
  await reconcileStalePollRuns(db);
  return (
    (await db
      .prepare("SELECT * FROM poll_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(userId)) ?? null
  );
}

/** Extension activity (Path B) — derived from capture_events / jobs / referrals, NEVER poll_runs. */
export async function activityStats(db: DB, userId: number, sinceMs?: number): Promise<{
  since: number;
  jobsCaptured: number;
  jobsViewed: number;
  referralLeads: number;
  applications: number;
  byEvent: Record<string, number>;
}> {
  const since = sinceMs ?? startOfTodayMs();
  const jobsCaptured = (
    (await db
      .prepare(
        "SELECT COUNT(*) n FROM jobs WHERE user_id = ? AND source_kind='extension' AND first_seen_at >= ?"
      )
      .get(userId, since)) as { n: number }
  ).n;
  const jobsViewed = (
    (await db
      .prepare("SELECT COUNT(*) n FROM jobs WHERE user_id = ? AND viewed_at >= ?")
      .get(userId, since)) as { n: number }
  ).n;
  const referralLeads = (
    (await db
      .prepare("SELECT COUNT(*) n FROM referrals WHERE user_id = ? AND captured_at >= ?")
      .get(userId, since)) as { n: number }
  ).n;
  const applications = (
    (await db
      .prepare("SELECT COUNT(*) n FROM applications WHERE user_id = ? AND applied_at >= ?")
      .get(userId, since)) as { n: number }
  ).n;
  const byEventRows = (await db
    .prepare(
      "SELECT event, COUNT(*) n FROM capture_events WHERE user_id = ? AND occurred_at >= ? GROUP BY event"
    )
    .all(userId, since)) as { event: string; n: number }[];
  const byEvent: Record<string, number> = {};
  for (const r of byEventRows) byEvent[r.event] = r.n;
  return { since, jobsCaptured, jobsViewed, referralLeads, applications, byEvent };
}

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
