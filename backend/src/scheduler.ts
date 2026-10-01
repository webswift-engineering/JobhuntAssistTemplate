import cron, { type ScheduledTask } from "node-cron";
import type { DB } from "./db/client.js";
import { config } from "./config.js";
import { scoreJob } from "./llm/scoreJob.js";
import { computeMatchFacts } from "./profile/matchFacts.js";
import { loadMasterProfile } from "./profile/tailorSource.js";
import { getLlm, type LlmClient } from "./llm/client.js";
import { checkJobRegion, regionPolicyFromPrefs } from "./regionFilter.js";
import { recordCompanyHealthFromPoll, pollCareerWatches, autoDisableBrokenCompanies } from "./companyHealth.js";
import { pollAll, type OrchestratorResult } from "./sources/orchestrator.js";
import {
  autoSkipJob,
  getJob,
  getProfile,
  ingestMany,
  listCompanies,
  setJobState,
  setRelevance,
} from "./store.js";
import { listUsers, OWNER_USER_ID } from "./users.js";
import { notifyHighScoreJobs } from "./highScoreNotify.js";

export interface PollDeps {
  llm?: LlmClient;
  dashboardUrl?: string;
  /** Test seam: override the ATS polling (defaults to the live orchestrator). */
  pollFn?: (companies: Awaited<ReturnType<typeof listCompanies>>) => Promise<OrchestratorResult>;
  /** When set, called after scoring/notification so high-match jobs get résumés queued. */
  enqueueResumes?: (db: DB, userId: number) => void | Promise<void>;
  /** Test seam: forwarded to notifyHighScoreJobs (replaces the real Slack send). */
  sendFn?: (text: string, webhookUrl: string) => Promise<boolean>;
}

export type ScoreDeps = Pick<PollDeps, "llm" | "dashboardUrl">;

/** Score jobs that have no relevance_score yet (extension ingest, backfill, poll upsert). */
export async function scoreUnscoredJobs(
  db: DB,
  userId: number,
  jobIds: string[],
  deps: ScoreDeps = {}
): Promise<{ scored: number }> {
  const llm = deps.llm ?? getLlm();
  const prefs = (await getProfile(db, userId)).preferences;
  const candidateSkills = computeMatchFacts(loadMasterProfile(userId), prefs).skills;

  let scored = 0;

  for (const id of jobIds) {
    const job = await getJob(db, userId, id);
    if (!job || job.relevance_score != null) continue;

    const { score, reason, method } = await scoreJob(
      llm,
      {
        title: job.title,
        company: job.company,
        location: job.location,
        description: job.description,
      },
      prefs,
      { candidateSkills }
    );
    const region = checkJobRegion(job.location, job.description, regionPolicyFromPrefs(prefs));
    await setRelevance(db, userId, job.id, score, reason, {
      regionStatus: region.allowed ? "in" : "out",
      method,
    });
    scored++;

    if (!region.allowed && job.state === "discovered") {
      await setJobState(db, userId, job.id, "skipped");
    } else if (shouldAutoSkip(score, method, job.state)) {
      await autoSkipJob(db, userId, job.id);
    }
  }

  return { scored };
}

/**
 * Machine-skip obvious non-matches so the human never sees them — but ONLY for
 * LLM-scored jobs. Heuristic scores (LLM down) are low-confidence by design;
 * auto-skipping on them would silently trash the queue during an outage.
 */
function shouldAutoSkip(score: number, method: string, state: string): boolean {
  return (
    method === "llm" &&
    state === "discovered" &&
    score >= 0 &&
    score < config.screening.autoSkipBelow
  );
}

/**
 * Force a re-score of every job inside the freshness window (last FRESHNESS_HOURS),
 * regardless of whether it already has a score. Used after the scoring logic changes
 * so the visible queue reflects the new rubric without waiting for the next poll.
 * Out-of-region fresh jobs are re-marked skipped, consistent with scoreUnscoredJobs.
 */
export async function rescoreFreshJobs(
  db: DB,
  userId: number,
  deps: ScoreDeps & { limit?: number; hours?: number } = {}
): Promise<{ rescored: number; windowHours: number; sample: { title: string; score: number }[] }> {
  const llm = deps.llm ?? getLlm();
  const prefs = (await getProfile(db, userId)).preferences;
  const candidateSkills = computeMatchFacts(loadMasterProfile(userId), prefs).skills;
  const windowHours = deps.hours ?? config.freshness.hours;
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const limit = Math.min(Math.max(deps.limit ?? 200, 1), 500);

  const rows = (await db
    .prepare(
      "SELECT id FROM jobs WHERE user_id = ? AND COALESCE(posted_at, first_seen_at) >= ? " +
        "ORDER BY COALESCE(posted_at, first_seen_at) DESC LIMIT ?"
    )
    .all(userId, cutoff, limit)) as { id: string }[];

  let rescored = 0;
  const sample: { title: string; score: number }[] = [];
  for (const { id } of rows) {
    const job = await getJob(db, userId, id);
    if (!job) continue;
    const { score, reason, method } = await scoreJob(
      llm,
      { title: job.title, company: job.company, location: job.location, description: job.description },
      prefs,
      { candidateSkills }
    );
    const region = checkJobRegion(job.location, job.description, regionPolicyFromPrefs(prefs));
    await setRelevance(db, userId, job.id, score, reason, {
      regionStatus: region.allowed ? "in" : "out",
      method,
    });
    rescored++;
    if (sample.length < 10) sample.push({ title: job.title, score });

    if (!region.allowed && job.state === "discovered") {
      await setJobState(db, userId, job.id, "skipped");
    } else if (shouldAutoSkip(score, method, job.state)) {
      await autoSkipJob(db, userId, job.id);
    }
  }
  return { rescored, windowHours, sample };
}

// High-intent pivot 2026-08: the per-poll "new ATS job(s) (match > 0%)" digest is
// gone. notifyHighScoreJobs (FTE-only, ≥ NOTIFY_THRESHOLD) is the only job ping;
// crucially, nothing below the bar stamps notified_at anymore, so high-scoring
// jobs can't be masked by a low-bar digest that saw them first.

export interface PollRunSummary {
  id: number;
  status: "success" | "partial" | "error" | "skipped";
  companiesPolled: number;
  jobsSeen: number;
  jobsNew: number;
  jobsScored: number;
  notificationsSent: number;
  errors: Record<string, string>;
  durationMs: number;
  /** True when this trigger was skipped because another poll was already in flight. */
  skipped?: boolean;
}

export interface PollStatus {
  running: boolean;
  runId?: number;
  trigger?: "schedule" | "manual";
  startedAt?: number;
  elapsedMs?: number;
}

/** Mark orphaned `running` rows left by server restarts or killed mid-poll. */
export async function reconcileStalePollRuns(
  db: DB,
  now = Date.now(),
  opts: { startup?: boolean } = {}
): Promise<number> {
  // Never reconcile while a poll is actively running — companies_polled stays 0 until the end.
  if (pollInFlight && !opts.startup) return 0;

  const MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4h — only ancient orphans during normal ops
  const rows = (await db
    .prepare("SELECT id, started_at FROM poll_runs WHERE status = 'running'")
    .all()) as { id: number; started_at: number }[];

  let closed = 0;
  for (const row of rows) {
    const age = now - row.started_at;
    if (!opts.startup && age < MAX_AGE_MS) continue;

    await db.prepare(
      `UPDATE poll_runs SET
         finished_at = ?, status = 'error', duration_ms = ? - started_at,
         errors_json = ?
       WHERE id = ?`
    ).run(
      now,
      now,
      JSON.stringify({
        aborted: opts.startup
          ? "Poll interrupted (server restarted while running)"
          : "Poll timed out (stale running row)",
      }),
      row.id
    );
    closed++;
  }
  if (closed) console.warn(`[scheduler] closed ${closed} stale poll_run(s) stuck in 'running'`);
  return closed;
}

let scoreBackfillInFlight: Promise<{ scored: number }> | null = null;

export function isScoreBackfillRunning(): boolean {
  return scoreBackfillInFlight != null;
}

/** Score a batch of unscored job ids (manual backfill). Skips if another backfill is running. */
export async function runScoreBackfill(
  db: DB,
  userId: number,
  jobIds: string[],
  deps: ScoreDeps = {}
): Promise<{ scored: number; skipped: boolean }> {
  if (scoreBackfillInFlight) {
    return { scored: 0, skipped: true };
  }
  scoreBackfillInFlight = scoreUnscoredJobs(db, userId, jobIds, deps).finally(() => {
    scoreBackfillInFlight = null;
  });
  const { scored } = await scoreBackfillInFlight;
  return { scored, skipped: false };
}

let pollInFlight: Promise<PollRunSummary> | null = null;
let activePollMeta: {
  runId: number;
  startedAt: number;
  trigger: "schedule" | "manual";
} | null = null;

/** Live poll state for /health and dashboard (in-memory; authoritative while process runs). */
export function getPollStatus(now = Date.now()): PollStatus {
  if (!pollInFlight || !activePollMeta) return { running: false };
  return {
    running: true,
    runId: activePollMeta.runId,
    trigger: activePollMeta.trigger,
    startedAt: activePollMeta.startedAt,
    elapsedMs: now - activePollMeta.startedAt,
  };
}

async function executePoll(
  db: DB,
  userId: number,
  trigger: "schedule" | "manual",
  deps: PollDeps,
  runId: number,
  started: number
): Promise<PollRunSummary> {
  try {
    const companies = await listCompanies(db, userId, true);
    const pollFn = deps.pollFn ?? ((c) => pollAll(c));
    const { jobs, companiesPolled, errors } = await pollFn(companies);

    const jobsByCompany = new Map<string, number>();
    for (const j of jobs) {
      const co = j.company ?? "";
      jobsByCompany.set(co, (jobsByCompany.get(co) ?? 0) + 1);
    }
    await recordCompanyHealthFromPoll(db, companies, jobsByCompany, errors);
    await autoDisableBrokenCompanies(db, companies, errors);

    const results = await ingestMany(db, userId, jobs);
    const newResults = results.filter((r) => r.isNew);

    const { scored } = await scoreUnscoredJobs(db, userId, results.map((r) => r.id), deps);
    if (newResults.length) {
      console.log(
        `[scheduler] ${newResults.length} new ATS job(s) ingested (notifications: high-score push only)`
      );
    }
    const highPush = await notifyHighScoreJobs(db, userId, {
      scoredSince: started,
      dashboardUrl: deps.dashboardUrl,
      sendFn: deps.sendFn,
    });
    const notificationsSent = highPush.sent ? 1 : 0;

    if (deps.enqueueResumes) {
      try {
        await deps.enqueueResumes(db, userId);
      } catch (err) {
        console.warn("[scheduler] resume enqueue failed:", (err as Error).message);
      }
    }

    void pollCareerWatches(db, userId).catch((err) =>
      console.warn("[scheduler] career watch poll failed:", (err as Error).message)
    );

    const durationMs = Date.now() - started;
    const hasErrors = Object.keys(errors).length > 0;
    const status: PollRunSummary["status"] = hasErrors
      ? companiesPolled > 0
        ? "partial"
        : "error"
      : "success";

    await db.prepare(
      `UPDATE poll_runs SET
         finished_at=?, status=?, companies_polled=?, jobs_seen=?, jobs_new=?,
         jobs_scored=?, notifications_sent=?, errors_json=?, duration_ms=?
       WHERE id=?`
    ).run(
      Date.now(),
      status,
      companiesPolled,
      jobs.length,
      newResults.length,
      scored,
      notificationsSent,
      hasErrors ? JSON.stringify(errors) : null,
      durationMs,
      runId
    );

    return {
      id: runId,
      status,
      companiesPolled,
      jobsSeen: jobs.length,
      jobsNew: newResults.length,
      jobsScored: scored,
      notificationsSent,
      errors,
      durationMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.prepare(
      `UPDATE poll_runs SET
         finished_at=?, status='error', errors_json=?, duration_ms=? - started_at
       WHERE id=?`
    ).run(Date.now(), JSON.stringify({ fatal: msg }), Date.now(), runId);
    throw err;
  }
}

/**
 * One poll run (§7.1). ATS-only (Path A). Opens a `poll_runs` row, polls adapters,
 * ingests, scores new jobs, notifies on fresh high-match, then closes the row.
 * The extension (Path B) must NEVER call this — it never touches poll_runs.
 */
export function runPoll(
  db: DB,
  userId: number,
  trigger: "schedule" | "manual",
  deps: PollDeps = {}
): Promise<PollRunSummary> {
  // Single-flight guard is checked AND claimed synchronously — no await may sit
  // before it, or two near-simultaneous triggers would both start a poll.
  if (pollInFlight) {
    console.warn(`[scheduler] poll skipped (${trigger}): another poll is already running`);
    return skippedPollSummary(db);
  }

  pollInFlight = (async () => {
    await reconcileStalePollRuns(db);
    const started = Date.now();
    const runId = Number(
      (
        await db
          .prepare("INSERT INTO poll_runs (user_id, started_at, trigger, status) VALUES (?,?,?, 'running')")
          .run(userId, started, trigger)
      ).lastInsertRowid
    );
    activePollMeta = { runId, startedAt: started, trigger };
    return executePoll(db, userId, trigger, deps, runId, started);
  })().finally(() => {
    pollInFlight = null;
    activePollMeta = null;
  });
  return pollInFlight;
}

async function skippedPollSummary(db: DB): Promise<PollRunSummary> {
  const running = (await db
    .prepare(
      "SELECT id, started_at FROM poll_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1"
    )
    .get()) as { id: number; started_at: number } | undefined;
  return {
    id: running?.id ?? 0,
    status: "skipped",
    companiesPolled: 0,
    jobsSeen: 0,
    jobsNew: 0,
    jobsScored: 0,
    notificationsSent: 0,
    errors: { skipped: "Poll already in progress" },
    durationMs: running ? Date.now() - running.started_at : 0,
    skipped: true,
  };
}

let task: ScheduledTask | null = null;

/** Start the business-hours cron (§7.1). Cadence + TZ from env. */
export function startScheduler(db: DB, deps: PollDeps = {}): void {
  if (!config.scheduler.enabled) {
    console.log("[scheduler] disabled (SCHEDULER_ENABLED=0); use POST /admin/poll-now");
    return;
  }
  if (!cron.validate(config.scheduler.cron)) {
    console.warn(`[scheduler] invalid POLL_CRON '${config.scheduler.cron}', not starting`);
    return;
  }
  task = cron.schedule(
    config.scheduler.cron,
    () => {
      void (async () => {
        // Poll each account's boards sequentially (single-flight guard stays per
        // process). Users without enabled companies are a no-op.
        let users: { id: number }[];
        try {
          users = await listUsers(db);
        } catch {
          users = [{ id: OWNER_USER_ID }];
        }
        if (!users.length) users = [{ id: OWNER_USER_ID }];
        for (const u of users) {
          const companies = await listCompanies(db, u.id, true).catch(() => []);
          if (!companies.length) continue;
          await runPoll(db, u.id, "schedule", deps).catch((err) =>
            console.error(`[scheduler] poll run failed (user ${u.id}):`, err)
          );
        }
      })();
    },
    { timezone: config.scheduler.tz }
  );
  console.log(
    `[scheduler] started — cron '${config.scheduler.cron}' TZ '${config.scheduler.tz}'`
  );
}

export function stopScheduler(): void {
  task?.stop();
  task = null;
}
