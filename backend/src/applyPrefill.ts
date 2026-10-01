/**
 * Prefill-ahead (mobile go-live Phase 2, docs/mobile-live-plan.md §4).
 *
 * The phone decides, the desktop fills. When a job is queued for apply (from the
 * phone or the dashboard), the extension's background worker opens the ATS form
 * in an unfocused desktop Chrome window, runs the normal apply engine (bank +
 * profile + heuristics, résumé attached, STOPS before Submit) and reports the
 * result here: which fields it filled, which questions still need the human, a
 * screenshot. The tab stays parked. On the phone the "Ready" card shows the
 * field table and the open questions as inputs; each answer is banked and the
 * parked tab re-runs its fill pass. Submit is still a human click in that tab
 * (desktop, or remote desktop from the phone — Phase 3 decides remote approve).
 *
 * State machine (apply_prefills.status):
 *   queued → running → ready ──(answers)──→ ready (refill)
 *                   ↘ needs_desktop / error        ↘ submitted (human applied)
 *   any active → cancelled (skip / cancel) · expired (TTL)
 *
 * Everything the extension needs per poll comes from ONE call (nextPrefillWork):
 * tabs to close, refills to trigger, and at most one new job to open.
 */

import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db/client.js";
import { config } from "./config.js";
import { ASSIST_HOST_RE } from "./applyStream.js";
import { resumeStatusForJobs } from "./resumePipeline.js";
import { getJob, getProfile, setProfile } from "./store.js";
import type { JobRow } from "./types.js";

export type PrefillStatus =
  | "queued"
  | "running"
  | "ready"
  | "needs_desktop"
  | "error"
  | "submitted"
  | "cancelled"
  | "expired";

/** Parked tabs live this long; after that the form is stale and the tab is closed. */
export const PREFILL_TTL_MS = 12 * 3600 * 1000;
/** Max parked (running + ready) tabs at once — desktop memory and LinkedIn-style politeness. */
export const MAX_PARKED = Number(process.env.PREFILL_MAX_PARKED ?? 5);
/** A run that hasn't reported in this long is considered stuck. */
const RUNNING_STUCK_MS = 6 * 60 * 1000;
const MAX_ATTEMPTS = 2;

export interface PrefillField {
  label: string;
  value: string;
  source: "engine" | "human" | "human-edited" | "empty";
}

export interface PrefillRow {
  job_id: string;
  user_id: number;
  status: PrefillStatus;
  requested_at: number;
  started_at: number | null;
  updated_at: number;
  tab_id: number | null;
  tab_open: number;
  refill_requested: number;
  attempts: number;
  resume_state: string | null;
  drafted: number | null;
  fields_json: string | null;
  unanswered_json: string | null;
  error: string | null;
  screenshot_path: string | null;
}

export interface PrefillDetail {
  jobId: string;
  status: PrefillStatus;
  requestedAt: number;
  startedAt: number | null;
  updatedAt: number;
  tabOpen: boolean;
  refillRequested: boolean;
  attempts: number;
  resumeState: string | null;
  drafted: number;
  fields: PrefillField[];
  unanswered: string[];
  error: string | null;
  hasScreenshot: boolean;
}

const ACTIVE: PrefillStatus[] = ["queued", "running", "ready"];

function parseRow(r: PrefillRow): PrefillDetail {
  const safe = <T>(s: string | null, dflt: T): T => {
    if (!s) return dflt;
    try {
      return JSON.parse(s) as T;
    } catch {
      return dflt;
    }
  };
  return {
    jobId: r.job_id,
    status: r.status,
    requestedAt: Number(r.requested_at),
    startedAt: r.started_at == null ? null : Number(r.started_at),
    updatedAt: Number(r.updated_at),
    tabOpen: Number(r.tab_open) === 1,
    refillRequested: Number(r.refill_requested) === 1,
    attempts: Number(r.attempts ?? 0),
    resumeState: r.resume_state,
    drafted: Number(r.drafted ?? 0),
    fields: safe<PrefillField[]>(r.fields_json, []),
    unanswered: safe<string[]>(r.unanswered_json, []),
    error: r.error,
    hasScreenshot: !!r.screenshot_path && fs.existsSync(r.screenshot_path),
  };
}

async function rowFor(db: DB, userId: number, jobId: string): Promise<PrefillRow | undefined> {
  return (await db
    .prepare("SELECT * FROM apply_prefills WHERE user_id = ? AND job_id = ?")
    .get(userId, jobId)) as PrefillRow | undefined;
}

async function setStatus(
  db: DB,
  jobId: string,
  status: PrefillStatus,
  extra: Partial<Record<"error" | "tab_open" | "refill_requested", string | number | null>> = {},
  now = Date.now()
): Promise<void> {
  const sets = ["status = ?", "updated_at = ?"];
  const params: unknown[] = [status, now];
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    params.push(v);
  }
  params.push(jobId);
  await db.prepare(`UPDATE apply_prefills SET ${sets.join(", ")} WHERE job_id = ?`).run(...params);
}

export function canPrefillHost(url: string | null | undefined): boolean {
  return ASSIST_HOST_RE.test(url ?? "");
}

/** Extension hand-off URL: canonical Greenhouse host + engine hash in prefill mode. */
export function prefillUrl(job: JobRow): string {
  const base = (job.url ?? "").replace("https://boards.greenhouse.io/", "https://job-boards.greenhouse.io/");
  return `${base}#jh-apply=${job.id}&jh-prefill=1`;
}

export interface RequestPrefillResult {
  ok: boolean;
  status?: PrefillStatus;
  reason?: "not_found" | "not_actionable" | "no_resume" | "unsupported_host" | "already_active";
}

/** Queue a job for prefill-ahead. Idempotent: an active row is left alone. */
export async function requestPrefill(
  db: DB,
  userId: number,
  jobId: string,
  now = Date.now()
): Promise<RequestPrefillResult> {
  const job = await getJob(db, userId, jobId);
  if (!job) return { ok: false, reason: "not_found" };
  if (job.state === "applied" || job.state === "skipped") return { ok: false, reason: "not_actionable" };
  const existing = await rowFor(db, userId, jobId);
  if (existing && ACTIVE.includes(existing.status)) {
    return { ok: true, status: existing.status, reason: "already_active" };
  }
  if (!canPrefillHost(job.url)) {
    // Not an engine host (LinkedIn, Workday, company site): record the intent so
    // the phone card says "needs desktop" instead of silently doing nothing.
    await upsert(db, userId, jobId, "needs_desktop", now, "unsupported host — Copilot panel assists on the desktop");
    return { ok: false, status: "needs_desktop", reason: "unsupported_host" };
  }
  const resume = (await resumeStatusForJobs(db, [jobId])).get(jobId);
  if (resume?.status !== "ready") return { ok: false, reason: "no_resume" };
  await upsert(db, userId, jobId, "queued", now, null);
  return { ok: true, status: "queued" };
}

async function upsert(
  db: DB,
  userId: number,
  jobId: string,
  status: PrefillStatus,
  now: number,
  error: string | null
): Promise<void> {
  const existing = await rowFor(db, userId, jobId);
  if (existing) {
    await db
      .prepare(
        `UPDATE apply_prefills
         SET status = ?, requested_at = ?, updated_at = ?, started_at = NULL, refill_requested = 0, attempts = 0,
             error = ?, fields_json = NULL, unanswered_json = NULL, resume_state = NULL, drafted = 0
         WHERE job_id = ?`
      )
      .run(status, now, now, error, jobId);
  } else {
    await db
      .prepare(
        `INSERT INTO apply_prefills (job_id, user_id, status, requested_at, updated_at, error)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(jobId, userId, status, now, now, error);
  }
}

export async function cancelPrefill(db: DB, userId: number, jobId: string, now = Date.now()): Promise<boolean> {
  const row = await rowFor(db, userId, jobId);
  if (!row) return false;
  if (ACTIVE.includes(row.status)) await setStatus(db, jobId, "cancelled", { refill_requested: 0 }, now);
  return true;
}

export async function getPrefill(db: DB, userId: number, jobId: string): Promise<PrefillDetail | null> {
  const row = await rowFor(db, userId, jobId);
  return row ? parseRow(row) : null;
}

export async function screenshotPathFor(db: DB, userId: number, jobId: string): Promise<string | null> {
  const row = await rowFor(db, userId, jobId);
  return row?.screenshot_path && fs.existsSync(row.screenshot_path) ? row.screenshot_path : null;
}

// ---- extension side ---------------------------------------------------------

export interface PrefillWork {
  /** Parked tabs to close (job no longer active, expired, cancelled). Ack with markPrefillClosed. */
  close: { jobId: string; tabId: number; reason: string }[];
  /** Parked tabs whose form should re-run its fill pass (new banked answers). */
  refills: { jobId: string; tabId: number }[];
  /** At most one new job to open (null when the parked cap is reached or nothing is queued). */
  next: { jobId: string; url: string; title: string; company: string | null } | null;
  active: number;
  cap: number;
}

/**
 * One poll from the extension: reconcile parked tabs against job state and the
 * TTL, hand out refills, and open the next queued job when there is room.
 */
export async function nextPrefillWork(db: DB, userId: number, now = Date.now()): Promise<PrefillWork> {
  const rows = (await db
    .prepare(
      `SELECT p.*, j.state AS job_state
       FROM apply_prefills p JOIN jobs j ON j.id = p.job_id
       WHERE p.user_id = ? AND (p.status IN ('queued','running','ready') OR p.tab_open = 1)
       ORDER BY p.requested_at ASC`
    )
    .all(userId)) as (PrefillRow & { job_state: string })[];

  const close: PrefillWork["close"] = [];
  const refills: PrefillWork["refills"] = [];
  let hasRunning = false;
  /** Re-queued in THIS poll: not re-opened until the close of their old tab is acked. */
  const requeued = new Set<string>();

  for (const r of rows) {
    const open = Number(r.tab_open) === 1 && r.tab_id != null;
    const closeWith = async (status: PrefillStatus, reason: string) => {
      if (r.status !== status) await setStatus(db, r.job_id, status, { refill_requested: 0 }, now);
      if (open) close.push({ jobId: r.job_id, tabId: Number(r.tab_id), reason });
    };

    if (r.job_state === "applied") {
      await closeWith("submitted", "applied");
      continue;
    }
    if (r.job_state === "skipped") {
      await closeWith("cancelled", "skipped");
      continue;
    }
    if (!ACTIVE.includes(r.status)) {
      // cancelled / error / needs_desktop rows that still hold a tab
      if (open) close.push({ jobId: r.job_id, tabId: Number(r.tab_id), reason: r.status });
      continue;
    }
    if (now - Number(r.requested_at) > PREFILL_TTL_MS) {
      await closeWith("expired", "ttl");
      continue;
    }
    if (r.status === "running") {
      if (r.started_at != null && now - Number(r.started_at) > RUNNING_STUCK_MS) {
        if (Number(r.attempts) >= MAX_ATTEMPTS) {
          await setStatus(db, r.job_id, "error", { error: "engine never reported (stuck)" }, now);
          if (open) close.push({ jobId: r.job_id, tabId: Number(r.tab_id), reason: "stuck" });
        } else {
          // Retry: close the dead tab, back to the queue (re-opened on the next poll).
          await db
            .prepare("UPDATE apply_prefills SET status = 'queued', started_at = NULL, updated_at = ? WHERE job_id = ?")
            .run(now, r.job_id);
          requeued.add(r.job_id);
          if (open) close.push({ jobId: r.job_id, tabId: Number(r.tab_id), reason: "retry" });
        }
        continue;
      }
      hasRunning = true;
      continue;
    }
    if (r.status === "ready" && Number(r.refill_requested) === 1) {
      if (open) refills.push({ jobId: r.job_id, tabId: Number(r.tab_id) });
      else {
        // The tab is gone (Chrome restarted) — open it again from scratch.
        await db
          .prepare(
            "UPDATE apply_prefills SET status = 'queued', started_at = NULL, refill_requested = 0, updated_at = ? WHERE job_id = ?"
          )
          .run(now, r.job_id);
      }
    }
  }

  // Parked = tabs we hold open (running or ready). Re-read after the reconciliation above.
  const activeRow = (await db
    .prepare(
      `SELECT COUNT(*) AS n FROM apply_prefills
       WHERE user_id = ? AND status IN ('running','ready') AND tab_open = 1`
    )
    .get(userId)) as { n: number };
  const active = Number(activeRow?.n ?? 0);

  let next: PrefillWork["next"] = null;
  // One fill at a time (the engine is DOM-heavy and LinkedIn-style pacing applies).
  if (!hasRunning && active < MAX_PARKED) {
    const skip = [...requeued];
    const notIn = skip.length ? ` AND p.job_id NOT IN (${skip.map(() => "?").join(",")})` : "";
    const q = (await db
      .prepare(
        `SELECT p.job_id FROM apply_prefills p JOIN jobs j ON j.id = p.job_id
         WHERE p.user_id = ? AND p.status = 'queued' AND j.state NOT IN ('applied','skipped')${notIn}
         ORDER BY p.requested_at ASC LIMIT 1`
      )
      .get(userId, ...skip)) as { job_id: string } | undefined;
    if (q) {
      const job = await getJob(db, userId, q.job_id);
      if (job) {
        await db
          .prepare(
            "UPDATE apply_prefills SET status = 'running', started_at = ?, updated_at = ?, attempts = attempts + 1, tab_open = 0, tab_id = NULL WHERE job_id = ?"
          )
          .run(now, now, job.id);
        next = { jobId: job.id, url: prefillUrl(job), title: job.title, company: job.company };
      }
    }
  }

  return { close, refills, next, active, cap: MAX_PARKED };
}

export async function markPrefillStarted(db: DB, userId: number, jobId: string, tabId: number, now = Date.now()): Promise<boolean> {
  const row = await rowFor(db, userId, jobId);
  if (!row) return false;
  await db
    .prepare("UPDATE apply_prefills SET tab_id = ?, tab_open = 1, updated_at = ? WHERE job_id = ?")
    .run(tabId, now, jobId);
  return true;
}

export interface PrefillReport {
  fields: PrefillField[];
  unanswered: string[];
  resumeState?: string | null;
  drafted?: number;
  screenshotBase64?: string;
}

function shotDir(): string {
  return path.join(path.dirname(config.resumeDir), "prefill-shots");
}

export async function markPrefillReady(
  db: DB,
  userId: number,
  jobId: string,
  report: PrefillReport,
  now = Date.now()
): Promise<PrefillDetail | null> {
  const row = await rowFor(db, userId, jobId);
  if (!row) return null;
  let screenshotPath: string | null = row.screenshot_path;
  if (report.screenshotBase64) {
    try {
      fs.mkdirSync(shotDir(), { recursive: true });
      screenshotPath = path.join(shotDir(), `${jobId}.jpg`);
      fs.writeFileSync(screenshotPath, Buffer.from(report.screenshotBase64, "base64"));
    } catch {
      /* screenshot is best effort */
    }
  }
  const fields = report.fields.slice(0, 120).map((f) => ({
    label: String(f.label ?? "").slice(0, 200),
    value: String(f.value ?? "").slice(0, 2000),
    source: f.source,
  }));
  const unanswered = [...new Set(report.unanswered.map((u) => String(u).slice(0, 200)))].slice(0, 40);
  await db
    .prepare(
      `UPDATE apply_prefills
       SET status = 'ready', refill_requested = 0, updated_at = ?, fields_json = ?, unanswered_json = ?,
           resume_state = ?, drafted = ?, error = NULL, screenshot_path = ?
       WHERE job_id = ?`
    )
    .run(now, JSON.stringify(fields), JSON.stringify(unanswered), report.resumeState ?? null, report.drafted ?? 0, screenshotPath, jobId);
  return getPrefill(db, userId, jobId);
}

export async function markPrefillFailed(db: DB, userId: number, jobId: string, reason: string, now = Date.now()): Promise<boolean> {
  const row = await rowFor(db, userId, jobId);
  if (!row) return false;
  // No form / login wall / captcha / redirect off the ATS host → the desktop human
  // path (Copilot panel) is the fallback, not another blind retry.
  await setStatus(db, jobId, "needs_desktop", { error: reason.slice(0, 300) }, now);
  return true;
}

export async function markPrefillClosed(db: DB, userId: number, jobId: string, now = Date.now()): Promise<boolean> {
  const row = await rowFor(db, userId, jobId);
  if (!row) return false;
  await db
    .prepare("UPDATE apply_prefills SET tab_open = 0, tab_id = NULL, updated_at = ? WHERE job_id = ?")
    .run(now, jobId);
  return true;
}

/**
 * Phone answers for the open questions: banked into screeningAnswers (the
 * human's own words, same policy as the submit-time bank) and the parked tab is
 * asked to re-run its fill pass. Contact-ish labels are filled from the profile,
 * never banked.
 */
export async function answerPrefill(
  db: DB,
  userId: number,
  jobId: string,
  answers: Record<string, string>,
  now = Date.now()
): Promise<{ banked: number; refill: boolean; propagated: number } | null> {
  const row = await rowFor(db, userId, jobId);
  if (!row) return null;
  const NO_BANK_RE = /name|email|phone|linkedin|website|portfolio|github|resume|cover letter/i;
  const entries = Object.entries(answers)
    .map(([k, v]) => [k.replace(/\s*\(yours to answer\)\s*$/i, "").trim().slice(0, 300), String(v).trim().slice(0, 2000)] as const)
    .filter(([k, v]) => k.length >= 3 && v.length > 0 && !NO_BANK_RE.test(k))
    .slice(0, 40);
  if (entries.length) {
    const current = await getProfile(db, userId);
    await setProfile(db, userId, {
      screeningAnswers: { ...current.screeningAnswers, ...Object.fromEntries(entries) },
    });
  }
  const refill = row.status === "ready" || row.status === "running";
  if (refill) await setStatus(db, jobId, row.status, { refill_requested: 1 }, now);

  // The same question is usually open on several parked forms ("Country", work
  // authorization, sponsorship…). One phone answer should clear it everywhere:
  // flag every other ready form whose open questions include a banked label.
  let propagated = 0;
  if (entries.length) {
    const norm = (s: string) =>
      s.toLowerCase().replace(/\s*\(yours to answer\)\s*$/i, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const banked = new Set(entries.map(([k]) => norm(k)));
    const others = (await db
      .prepare(
        "SELECT job_id, unanswered_json FROM apply_prefills WHERE user_id = ? AND status = 'ready' AND refill_requested = 0 AND job_id != ?"
      )
      .all(userId, jobId)) as { job_id: string; unanswered_json: string | null }[];
    for (const o of others) {
      let open: string[] = [];
      try {
        open = o.unanswered_json ? (JSON.parse(o.unanswered_json) as string[]) : [];
      } catch {
        open = [];
      }
      if (open.some((q) => banked.has(norm(q)))) {
        await setStatus(db, o.job_id, "ready", { refill_requested: 1 }, now);
        propagated++;
      }
    }
  }
  return { banked: entries.length, refill, propagated };
}

export interface PrefillListRow extends PrefillDetail {
  title: string;
  company: string | null;
  score: number | null;
  url: string;
  jobState: string;
}

export async function listPrefills(db: DB, userId: number, limit = 50): Promise<PrefillListRow[]> {
  const rows = (await db
    .prepare(
      `SELECT p.*, j.title, j.company, j.relevance_score AS score, j.url, j.state AS job_state
       FROM apply_prefills p JOIN jobs j ON j.id = p.job_id
       WHERE p.user_id = ?
       ORDER BY CASE p.status WHEN 'ready' THEN 0 WHEN 'running' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
                p.updated_at DESC
       LIMIT ?`
    )
    .all(userId, limit)) as (PrefillRow & { title: string; company: string | null; score: number | null; url: string; job_state: string })[];
  return rows.map((r) => ({
    ...parseRow(r),
    title: r.title,
    company: r.company,
    score: r.score == null ? null : Number(r.score),
    url: r.url,
    jobState: r.job_state,
  }));
}

export interface PrefillBadge {
  status: PrefillStatus;
  unanswered: number;
  updatedAt: number;
}

/** Per-job badge for the jobs list (attached like `resume`). */
export async function prefillStatusForJobs(db: DB, jobIds: string[]): Promise<Map<string, PrefillBadge>> {
  const out = new Map<string, PrefillBadge>();
  if (!jobIds.length) return out;
  const ph = jobIds.map(() => "?").join(",");
  const rows = (await db
    .prepare(`SELECT job_id, status, unanswered_json, updated_at FROM apply_prefills WHERE job_id IN (${ph})`)
    .all(...jobIds)) as Pick<PrefillRow, "job_id" | "status" | "unanswered_json" | "updated_at">[];
  for (const r of rows) {
    let n = 0;
    try {
      n = r.unanswered_json ? (JSON.parse(r.unanswered_json) as unknown[]).length : 0;
    } catch {
      n = 0;
    }
    out.set(r.job_id, { status: r.status, unanswered: n, updatedAt: Number(r.updated_at) });
  }
  return out;
}
