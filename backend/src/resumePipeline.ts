/**
 * Auto résumé pipeline: after a scan / poll scores jobs, every fresh in-queue job at
 * or above RESUME_AUTO_THRESHOLD (default 0.7 — decoupled from the notify bar) is
 * enqueued into resume_tasks and processed sequentially (each job = one LLM
 * tailoring pass + a Puppeteer PDF render, too heavy to parallelize). The dashboard
 * reads per-job status from the jobs list and pipeline progress from GET /resume-pipeline.
 */

import type { DB } from "./db/client.js";
import { config } from "./config.js";
import { bumpDataVersion } from "./dataVersion.js";
import { freshnessMs } from "./freshness.js";
import { getTailorSource } from "./profile/tailorSource.js";
import { generateResumeForJob } from "./render/generateResume.js";
import { listArtifacts } from "./render/resumeStore.js";
import type { LlmClient } from "./llm/client.js";

export type ResumeTaskStatus = "queued" | "running" | "done" | "error";

export interface ResumeTaskRow {
  job_id: string;
  status: ResumeTaskStatus;
  error: string | null;
  attempts: number;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface ResumePipelineDeps {
  llm?: LlmClient;
  /** Test seam: replaces the real generation (LLM + DOCX/PDF render + disk writes). */
  generateFn?: (db: DB, userId: number, jobId: string, llm?: LlmClient) => Promise<unknown>;
  /** Test seam: skip the master-resume adequacy pre-check. */
  requireMasterResume?: boolean;
  threshold?: number;
  /** Eligibility window in hours (default: the freshness window). */
  hours?: number;
  /** Max auto-enqueued tasks per local day (default config.resume.dailyCap; 0 = unlimited). */
  dailyCap?: number;
  /** Clock seam for the daily-cap window. */
  now?: number;
}

export interface EnqueueResult {
  enqueued: number;
  skippedReason?: string;
  /** Eligible jobs left un-queued because the daily cap was reached. */
  capped?: number;
}

/** Epoch-ms of local midnight (scheduler TZ) for the day containing `now`. */
export function startOfLocalDay(now: number, tz = config.scheduler.tz): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(now));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    // Wall-clock seconds elapsed since local midnight, subtracted from `now`.
    const sinceMidnightMs = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
    return now - sinceMidnightMs - (now % 1000);
  } catch {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}

/** Auto-tailor tasks queued since local midnight (manual generations don't enqueue tasks). */
export async function tasksQueuedToday(db: DB, userId: number, now = Date.now()): Promise<number> {
  const row = (await db
    .prepare("SELECT COUNT(*) AS n FROM resume_tasks WHERE user_id = ? AND queued_at >= ?")
    .get(userId, startOfLocalDay(now))) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Queue every eligible job that doesn't already have a task or artifacts:
 * fresh, score >= threshold, still actionable (not applied/skipped).
 * Kicks the worker; returns immediately with the enqueued count.
 */
export async function enqueueEligibleResumes(
  db: DB,
  userId: number,
  deps: ResumePipelineDeps = {}
): Promise<EnqueueResult> {
  if (deps.requireMasterResume !== false && !(await getTailorSource(db, userId)).masterResumeAdequate) {
    return { enqueued: 0, skippedReason: "master resume / profile not set up" };
  }

  const threshold = deps.threshold ?? config.resume.autoThreshold;
  const windowMs = deps.hours != null ? deps.hours * 3600 * 1000 : freshnessMs();
  const cutoff = Date.now() - windowMs;

  const rows = (await db
    .prepare(
      `SELECT id FROM jobs
       WHERE user_id = ?
         AND relevance_score >= ?
         AND state IN ('discovered', 'relevant', 'notified')
         AND COALESCE(posted_at, first_seen_at) >= ?
         AND id NOT IN (SELECT job_id FROM resume_tasks)
         AND id NOT IN (SELECT DISTINCT job_id FROM resume_artifacts)
       ORDER BY relevance_score DESC`
    )
    .all(userId, threshold, cutoff)) as { id: string }[];

  // Daily cap: the unattended watch must not turn a noisy day into an unbounded
  // LLM bill. Highest scores first (query order); the remainder simply waits —
  // if still fresh tomorrow it is queued then, otherwise it stays manual-only.
  const now = deps.now ?? Date.now();
  const cap = deps.dailyCap ?? config.resume.dailyCap;
  let eligible = rows;
  let capped = 0;
  if (cap > 0) {
    const used = await tasksQueuedToday(db, userId, now);
    const room = Math.max(0, cap - used);
    if (rows.length > room) {
      capped = rows.length - room;
      eligible = rows.slice(0, room);
    }
  }

  if (eligible.length) {
    // ON CONFLICT DO NOTHING is valid in both SQLite (≥3.24) and Postgres.
    const ins = db.prepare(
      "INSERT INTO resume_tasks (job_id, user_id, status, queued_at) VALUES (?, ?, 'queued', ?) ON CONFLICT(job_id) DO NOTHING"
    );
    const ids = eligible.map((r) => r.id);
    await db.transaction(async () => {
      for (const id of ids) await ins.run(id, userId, now);
    });
  }
  if (capped > 0) {
    console.warn(`[resume-pipeline] daily cap ${cap} reached — ${capped} eligible job(s) left for tomorrow / manual`);
  }

  void startResumeWorker(db, deps);
  return {
    enqueued: eligible.length,
    ...(capped > 0 ? { capped, skippedReason: `daily cap (${cap}) reached` } : {}),
  };
}

let workerInFlight: Promise<void> | null = null;
let currentJobId: string | null = null;

/** Drain the queue one task at a time. Idempotent: a second call while running is a no-op. */
export function startResumeWorker(db: DB, deps: ResumePipelineDeps = {}): Promise<void> {
  if (workerInFlight) return workerInFlight;
  workerInFlight = drainQueue(db, deps).finally(() => {
    workerInFlight = null;
    currentJobId = null;
  });
  return workerInFlight;
}

async function drainQueue(db: DB, deps: ResumePipelineDeps): Promise<void> {
  const generate = deps.generateFn ?? generateResumeForJob;

  for (;;) {
    const next = (await db
      .prepare("SELECT job_id, user_id FROM resume_tasks WHERE status = 'queued' ORDER BY queued_at LIMIT 1")
      .get()) as { job_id: string; user_id: number } | undefined;
    if (!next) return;

    currentJobId = next.job_id;
    await db.prepare(
      "UPDATE resume_tasks SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE job_id = ?"
    ).run(Date.now(), next.job_id);

    try {
      await generate(db, next.user_id ?? 1, next.job_id, deps.llm);
      await db.prepare(
        "UPDATE resume_tasks SET status = 'done', error = NULL, finished_at = ? WHERE job_id = ?"
      ).run(Date.now(), next.job_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.prepare(
        "UPDATE resume_tasks SET status = 'error', error = ?, finished_at = ? WHERE job_id = ?"
      ).run(msg.slice(0, 500), Date.now(), next.job_id);
      console.warn(`[resume-pipeline] generation failed for ${next.job_id}: ${msg}`);
    }
    bumpDataVersion(); // per-job résumé badge on the dashboard is now stale
  }
}

/** Server restart while a task was running: put it back in the queue. */
export async function requeueInterruptedResumeTasks(db: DB): Promise<number> {
  const info = await db
    .prepare("UPDATE resume_tasks SET status = 'queued', started_at = NULL WHERE status = 'running'")
    .run();
  if (info.changes) console.warn(`[resume-pipeline] requeued ${info.changes} interrupted task(s)`);
  return info.changes;
}

export interface ResumePipelineStatus {
  running: boolean;
  currentJobId: string | null;
  counts: { queued: number; running: number; done: number; error: number };
  tasks: (ResumeTaskRow & { title: string | null; company: string | null; score: number | null })[];
}

export async function resumePipelineStatus(db: DB, userId: number, limit = 30): Promise<ResumePipelineStatus> {
  const counts = { queued: 0, running: 0, done: 0, error: 0 };
  const rows = (await db
    .prepare("SELECT status, COUNT(*) AS n FROM resume_tasks WHERE user_id = ? GROUP BY status")
    .all(userId)) as { status: ResumeTaskStatus; n: number }[];
  for (const r of rows) {
    if (r.status in counts) counts[r.status] = r.n;
  }

  const tasks = (await db
    .prepare(
      `SELECT t.*, j.title, j.company, j.relevance_score AS score
       FROM resume_tasks t LEFT JOIN jobs j ON j.id = t.job_id
       WHERE t.user_id = ?
       ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
                COALESCE(t.finished_at, t.queued_at) DESC
       LIMIT ?`
    )
    .all(userId, limit)) as ResumePipelineStatus["tasks"];

  return { running: workerInFlight != null, currentJobId, counts, tasks };
}

/**
 * Detailed single-job status for the modal's GET /jobs/:id/resume-status poller.
 * Precedence: an active task beats existing artifact rows (the worker writes
 * artifacts incrementally mid-run, which must not read as "done"), and artifacts
 * beat a stale error from an older failed attempt that a later run recovered from.
 */
export interface JobResumeStatusDetail {
  status: "idle" | "queued" | "running" | "done" | "failed";
  error?: string;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  /** MAX(generated_at) across artifacts — lets a poller detect a fresh regeneration. */
  generatedAt: number | null;
  artifacts: { format: string; path: string; bytes: number; generatedAt: number }[];
}

export async function resumeStatusForJob(db: DB, jobId: string): Promise<JobResumeStatusDetail> {
  const task = (await db
    .prepare(
      "SELECT status, error, queued_at, started_at, finished_at FROM resume_tasks WHERE job_id = ?"
    )
    .get(jobId)) as
    | { status: ResumeTaskStatus; error: string | null; queued_at: number; started_at: number | null; finished_at: number | null }
    | undefined;

  const artifacts = (await listArtifacts(db, jobId)).map((a) => ({
    format: a.format,
    path: a.path,
    bytes: a.bytes ?? 0,
    generatedAt: a.generated_at,
  }));
  const generatedAt = artifacts.length ? Math.max(...artifacts.map((a) => a.generatedAt)) : null;

  let status: JobResumeStatusDetail["status"];
  if (task?.status === "running") status = "running";
  else if (task?.status === "queued") status = "queued";
  else if (artifacts.length) status = "done";
  else if (task?.status === "error") status = "failed";
  else status = "idle";

  return {
    status,
    ...(status === "failed" && task?.error ? { error: task.error } : {}),
    ...(task
      ? {
          queuedAt: task.queued_at,
          startedAt: task.started_at ?? undefined,
          finishedAt: task.finished_at ?? undefined,
        }
      : {}),
    generatedAt,
    artifacts,
  };
}

/** Per-job resume state for a set of job ids (attached to the jobs list response). */
export async function resumeStatusForJobs(
  db: DB,
  jobIds: string[]
): Promise<Map<string, { status: "none" | "queued" | "generating" | "ready" | "error"; formats: string[]; error?: string }>> {
  const out = new Map<
    string,
    { status: "none" | "queued" | "generating" | "ready" | "error"; formats: string[]; error?: string }
  >();
  if (!jobIds.length) return out;
  const ph = jobIds.map(() => "?").join(",");

  const artifacts = (await db
    .prepare(`SELECT job_id, format FROM resume_artifacts WHERE job_id IN (${ph})`)
    .all(...jobIds)) as { job_id: string; format: string }[];
  const formatsByJob = new Map<string, string[]>();
  for (const a of artifacts) {
    const list = formatsByJob.get(a.job_id) ?? [];
    list.push(a.format);
    formatsByJob.set(a.job_id, list);
  }

  const tasks = (await db
    .prepare(`SELECT job_id, status, error FROM resume_tasks WHERE job_id IN (${ph})`)
    .all(...jobIds)) as { job_id: string; status: ResumeTaskStatus; error: string | null }[];
  const taskByJob = new Map(tasks.map((t) => [t.job_id, t]));

  for (const id of jobIds) {
    const formats = formatsByJob.get(id) ?? [];
    const task = taskByJob.get(id);
    if (formats.length) {
      out.set(id, { status: "ready", formats });
    } else if (task?.status === "running") {
      out.set(id, { status: "generating", formats });
    } else if (task?.status === "queued") {
      out.set(id, { status: "queued", formats });
    } else if (task?.status === "error") {
      out.set(id, { status: "error", formats, error: task.error ?? undefined });
    } else {
      out.set(id, { status: "none", formats });
    }
  }
  return out;
}
