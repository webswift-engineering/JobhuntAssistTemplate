/**
 * Browser-driven LinkedIn watch (extension auto-scan) — backend side.
 *
 * The extension scans the user's logged-in LinkedIn search on a Chrome alarm and
 * persists strong/maybe matches through the existing /jobs/triage path. When a run
 * finishes it POSTs a summary to /scan/report; we record the run (the high-score
 * push in the /scan/report route is the only job ping since the high-intent
 * pivot) and use the report timestamps to warn when the watch appears stopped.
 */

import type { DB } from "./db/client.js";
import { config } from "./config.js";
import { sendSlackMessage } from "./notify/slack.js";
import { userWebhook } from "./users.js";

export interface ScanReport {
  source: string;
  scanned: number;
  strong: number;
  maybe: number;
  persisted: number;
  cancelled?: boolean;
  error?: string | null;
}

export interface ScanRunRow {
  id: number;
  source: string;
  scanned: number;
  strong: number;
  maybe: number;
  persisted: number;
  cancelled: number;
  error: string | null;
  notifications_sent: number;
  reported_at: number;
}

export async function recordScanReport(db: DB, userId: number, report: ScanReport, now = Date.now()): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO scan_runs (user_id, source, scanned, strong, maybe, persisted, cancelled, error, reported_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          userId,
          report.source,
          report.scanned,
          report.strong,
          report.maybe,
          report.persisted,
          report.cancelled ? 1 : 0,
          report.error ?? null,
          now
        )
    ).lastInsertRowid
  );
}

export async function lastScanRun(db: DB, userId: number): Promise<ScanRunRow | undefined> {
  return (await db
    .prepare("SELECT * FROM scan_runs WHERE user_id = ? ORDER BY reported_at DESC LIMIT 1")
    .get(userId)) as ScanRunRow | undefined;
}

// High-intent pivot 2026-08: the per-report "LinkedIn watch: N new match(es)" digest
// (score > 0) is gone. The /scan/report route now calls notifyHighScoreJobs directly,
// so only FTE jobs ≥ NOTIFY_THRESHOLD ping and sub-threshold rows keep notified_at NULL.

export async function setScanRunNotifications(db: DB, runId: number, count: number): Promise<void> {
  await db.prepare("UPDATE scan_runs SET notifications_sent = ? WHERE id = ?").run(count, runId);
}

function hourInTz(now: number, tz: string): number {
  try {
    return Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now)
    ) % 24;
  } catch {
    return new Date(now).getHours();
  }
}

/** 0 = Sunday … 6 = Saturday, in `tz`. */
function weekdayInTz(now: number, tz: string): number {
  try {
    const name = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(now);
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
  } catch {
    return new Date(now).getDay();
  }
}

const WATCH_EXPECTED_WINDOW_MS = 7 * 24 * 3600 * 1000; // a report in the last 7 days = watch is expected
/** The extension scans every ~90 min on weekdays 07:00–17:00 (see
 *  extension/background.js). Silence for 2× that inside the window means Chrome
 *  is closed, the PC slept, LinkedIn logged us out, or auto-scan got disabled. */
const DEFAULT_STALE_AFTER_MS = Number(process.env.SCAN_STALE_HOURS ?? 3) * 3600 * 1000;
const WATCH_START_HOUR = Number(process.env.SCAN_WINDOW_START_HOUR ?? 7);
const WATCH_END_HOUR = Number(process.env.SCAN_WINDOW_END_HOUR ?? 17);
const WATCH_DAYS = (process.env.SCAN_WINDOW_DAYS ?? "1,2,3,4,5")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);

export interface StaleCheckResult {
  sent: boolean;
  reason: string;
}

/**
 * One Slack warning per stall when the auto-scan watch appears stopped: a report
 * exists in the last 7 days, the newest one is older than `staleAfterMs`, and it is
 * waking hours. The single-row scan_watch_nudge table dedupes the warning — a new
 * nudge fires only after a newer report arrives and goes stale again.
 */
export async function checkScanWatchStale(
  db: DB,
  userId: number,
  opts: { now?: number; staleAfterMs?: number; tz?: string } = {}
): Promise<StaleCheckResult> {
  const now = opts.now ?? Date.now();
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const tz = opts.tz ?? config.scheduler.tz;

  const last = await lastScanRun(db, userId);
  if (!last || now - last.reported_at > WATCH_EXPECTED_WINDOW_MS) {
    return { sent: false, reason: "no recent watch activity" };
  }
  if (now - last.reported_at <= staleAfterMs) {
    return { sent: false, reason: "watch is fresh" };
  }

  // Only nag inside the scan window itself (a quiet evening or weekend is expected),
  // and only once the window has been open long enough for a run to be overdue.
  const hour = hourInTz(now, tz);
  const inWindow =
    WATCH_DAYS.includes(weekdayInTz(now, tz)) && hour >= WATCH_START_HOUR && hour < WATCH_END_HOUR;
  if (!inWindow) return { sent: false, reason: "quiet hours" };
  if ((hour - WATCH_START_HOUR) * 3600 * 1000 < staleAfterMs) {
    return { sent: false, reason: "window just opened" };
  }

  const nudge = (await db
    .prepare("SELECT nudged_at FROM scan_watch_nudge WHERE user_id = ?")
    .get(userId)) as { nudged_at: number } | undefined;
  if (nudge && nudge.nudged_at >= last.reported_at) {
    return { sent: false, reason: "already nudged for this stall" };
  }

  const hours = Math.round((now - last.reported_at) / 3600 / 1000);
  await sendSlackMessage(
    `:warning: *LinkedIn watch looks stopped* — last auto-scan report was ${hours}h ago.\n` +
      `Check that Chrome is open, the PC isn't asleep, and auto-scan is enabled in the extension popup.`,
    await userWebhook(db, userId)
  );
  await db.prepare(
    `INSERT INTO scan_watch_nudge (user_id, nudged_at) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET nudged_at = excluded.nudged_at`
  ).run(userId, now);
  return { sent: true, reason: "stale" };
}
