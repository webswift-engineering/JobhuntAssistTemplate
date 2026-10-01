/**
 * High-match Slack push — THE one notifier
 * that pings individual jobs (the per-source "new jobs > 0%" digests are gone).
 * One batched message per event listing unnotified jobs at or above the notify
 * threshold (NOTIFY_THRESHOLD, default 0.78), FTE-only: contract / part-time /
 * intern rows never ping (they stay visible on the dashboard); unknown-type rows
 * ping but carry a `type?` flag. Companies in prefs.targetCompanies qualify at
 * the lower NOTIFY_TARGET_COMPANY_THRESHOLD bar (flagged 🎯).
 *
 * `notified_at` is the single source of truth for "already pinged": every path that
 * Slacks a per-job link stamps it (via setJobState → 'notified'), and this helper
 * only ever selects rows where it is NULL — so a job is linked in at most one
 * message ever.
 *
 * Two modes:
 *  - auto-push (`scoredSince` set): called after a scoring pass (scan triage batch,
 *    poll, JD-backfill rescore) and only picks jobs scored during that pass AND
 *    within the freshness window, so a backlog of previously-scored-but-never-
 *    notified jobs cannot spam the channel.
 *  - publish (`scoredSince` unset): explicit catch-up (POST /notify/publish) that
 *    batch-notifies the whole unnotified backlog regardless of when it was scored
 *    (still FTE-gated).
 */

import type { DB } from "./db/client.js";
import { salaryFloorSql } from "./salary.js";
import { config } from "./config.js";
import { freshnessMs } from "./freshness.js";
import { sendSlackMessage } from "./notify/slack.js";
import { getProfile, setJobState } from "./store.js";
import { userWebhook } from "./users.js";
import type { JobRow } from "./types.js";

/** Deep links shown per message; the rest is folded into "+N more". */
const MAX_LINES = 20;
/** Hard cap per publish so a pathological backlog can't build a megabyte of SQL updates. */
const MAX_BATCH = 200;

export interface HighScoreNotifyDeps {
  /** Match threshold (0..1). Defaults to config.notify.threshold (NOTIFY_THRESHOLD, 0.78). */
  threshold?: number;
  /** Auto-push: only jobs whose last scoring pass is at/after this epoch-ms. Omit = full backlog (publish). */
  scoredSince?: number;
  dashboardUrl?: string;
  /** Test seam: replaces the real Slack webhook send. */
  sendFn?: (text: string, webhookUrl: string) => Promise<boolean>;
}

export interface HighScoreNotifyResult {
  /** Unnotified jobs that qualified for this push (main bar or target-company bar). */
  matched: number;
  /** Jobs actually stamped notified (0 when the Slack send failed / no webhook). */
  notified: number;
  sent: boolean;
}

/** FTE-probable = not positively classified as contract/part-time/intern. */
function isUnknownType(j: JobRow): boolean {
  return j.employment_type == null || j.employment_type === "unknown";
}

export async function notifyHighScoreJobs(
  db: DB,
  userId: number,
  deps: HighScoreNotifyDeps = {}
): Promise<HighScoreNotifyResult> {
  const threshold = deps.threshold ?? config.notify.threshold;
  const dashboardUrl = deps.dashboardUrl ?? config.notify.dashboardUrl;

  const targetCompanies = new Set(
    ((await getProfile(db, userId)).preferences.targetCompanies ?? [])
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean)
  );
  const targetThreshold = Math.min(threshold, config.notify.targetCompanyThreshold);
  // Query at the lower bar when target companies exist, then filter per-row in JS
  // (SQL can't cheaply match "company is in the target set" case-insensitively).
  const queryThreshold = targetCompanies.size ? targetThreshold : threshold;

  // Only still-actionable states: 'discovered'/'relevant' can transition to 'notified';
  // applied/skipped are the human saying "done with this", and 'notified' rows were
  // already pinged (their notified_at is set by setJobState).
  const where = [
    "user_id = ?",
    "notified_at IS NULL",
    "relevance_score >= ?",
    "state IN ('discovered', 'relevant')",
    "(region_status IS NULL OR region_status != 'out')",
    // FTE gate: positively-classified contract/part-time/intern never ping.
    // NULL / 'unknown' = FTE-probable — allowed through, flagged in the message.
    "(employment_type IS NULL OR employment_type IN ('full_time', 'unknown'))",
  ];
  // Salary floor (if configured): a KNOWN below-floor salary never pings;
  // unknown salary passes.
  const [salarySql, salaryParams] = salaryFloorSql();
  where.push(salarySql);
  const params: unknown[] = [userId, queryThreshold, ...salaryParams];
  if (deps.scoredSince != null) {
    where.push("scored_at >= ?");
    params.push(deps.scoredSince);
    // Auto-push also respects the freshness window; explicit publish keeps
    // full-backlog semantics.
    where.push("COALESCE(posted_at, first_seen_at) >= ?");
    params.push(Date.now() - freshnessMs());
  }
  params.push(MAX_BATCH);

  const candidates = (await db
    .prepare(
      `SELECT * FROM jobs WHERE ${where.join(" AND ")}
       ORDER BY relevance_score DESC LIMIT ?`
    )
    .all(...params)) as JobRow[];

  const isTarget = (j: JobRow) =>
    j.company != null && targetCompanies.has(j.company.trim().toLowerCase());
  const jobs = candidates.filter(
    (j) => (j.relevance_score ?? 0) >= threshold || isTarget(j)
  );
  if (jobs.length === 0) return { matched: 0, notified: 0, sent: false };

  const pctT = Math.round(threshold * 100);
  const shown = jobs.slice(0, MAX_LINES);
  const lines = [
    `:dart: *${jobs.length} high-match FTE job(s) (≥ ${pctT}%)*`,
    "",
    ...shown.map((j) => {
      const pct = Math.round((j.relevance_score ?? 0) * 100);
      const co = j.company ?? "Unknown";
      const flags =
        (isUnknownType(j) ? " · type?" : "") +
        (isTarget(j) && (j.relevance_score ?? 0) < threshold ? " · :dart: target" : "");
      return `• *${pct}%* <${dashboardUrl}/?job=${j.id}|${j.title}> @ ${co} — <${j.url}|apply>${flags}`;
    }),
    ...(jobs.length > shown.length ? [`• _+${jobs.length - shown.length} more on the dashboard_`] : []),
    "",
    `<${dashboardUrl}|Open dashboard queue>`,
  ];

  const send = deps.sendFn ?? sendSlackMessage;
  const sent = await send(lines.join("\n"), await userWebhook(db, userId));
  // Not delivered (no webhook configured, or Slack HTTP failure) → leave notified_at
  // NULL so the jobs stay eligible for the next push / an explicit publish.
  if (!sent) return { matched: jobs.length, notified: 0, sent: false };

  for (const j of jobs) {
    await setJobState(db, userId, j.id, "notified");
  }
  return { matched: jobs.length, notified: jobs.length, sent: true };
}
