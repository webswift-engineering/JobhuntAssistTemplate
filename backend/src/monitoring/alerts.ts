import type { DB } from "../db/client.js";
import { getLlmHealth, type LlmHealth } from "../llm/client.js";

/**
 * Structured alert conditions for the dashboard banner system. Everything is
 * derived on demand from existing state (LLM health counters, poll_runs,
 * resume_tasks, companies, scan_runs) — no background tracking loops.
 */
export interface Alert {
  /** Stable key (e.g. 'llm_down', 'poll_partial') — the dashboard diffs on it. */
  id: string;
  severity: "error" | "warn";
  title: string;
  detail?: string;
  /** Epoch ms when the condition started, when known. */
  since?: number;
  /** Count of affected items, when meaningful. */
  count?: number;
}

const DAY_MS = 24 * 3600 * 1000;
const LLM_DOWN_AFTER_CONSECUTIVE = 3;
const SCAN_WATCH_EXPECTED_WINDOW_MS = 7 * DAY_MS;
const SCAN_WATCH_STALE_AFTER_MS = 8 * 3600 * 1000;

export async function scoringMethodStats(
  db: DB,
  userId: number,
  sinceMs: number
): Promise<{ llm: number; heuristic: number; region: number; triage: number }> {
  const rows = (await db
    .prepare(
      `SELECT scored_by, count(*) AS c FROM jobs
       WHERE user_id = ? AND scored_at >= ? AND scored_by IS NOT NULL GROUP BY scored_by`
    )
    .all(userId, sinceMs)) as { scored_by: string; c: number }[];
  const out = { llm: 0, heuristic: 0, region: 0, triage: 0 };
  for (const r of rows) {
    if (r.scored_by in out) out[r.scored_by as keyof typeof out] = r.c;
  }
  return out;
}

function parseErrorsJson(errorsJson: string | null): Record<string, string> {
  if (!errorsJson) return {};
  try {
    const parsed = JSON.parse(errorsJson);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export async function collectAlerts(
  db: DB,
  userId: number,
  opts: { now?: number; llm?: LlmHealth } = {}
): Promise<Alert[]> {
  const now = opts.now ?? Date.now();
  const alerts: Alert[] = [];
  const dayAgo = now - DAY_MS;

  // --- LLM down / degraded scoring -----------------------------------------
  const llm = opts.llm ?? getLlmHealth();
  if (llm.enabled && llm.consecutiveFailures >= LLM_DOWN_AFTER_CONSECUTIVE) {
    alerts.push({
      id: "llm_down",
      severity: "error",
      title: `LLM is down — ${llm.consecutiveFailures} consecutive failures; scoring falls back to keyword heuristics`,
      detail: llm.lastError ?? undefined,
      since: llm.lastErrorAt ?? undefined,
    });
  }
  const methods = await scoringMethodStats(db, userId, dayAgo);
  if (llm.enabled && methods.heuristic > 0) {
    alerts.push({
      id: "llm_fallback",
      severity: "warn",
      title: `${methods.heuristic} job(s) scored by fallback heuristics in the last 24h (LLM was unavailable)`,
      detail: "Re-score them from the queue once the LLM is healthy (Score pending / rescore-fresh).",
      count: methods.heuristic,
    });
  }

  // --- Last poll run --------------------------------------------------------
  const lastPoll = (await db
    .prepare(
      `SELECT id, started_at, status, errors_json FROM poll_runs
       WHERE user_id = ? AND status != 'running' ORDER BY started_at DESC LIMIT 1`
    )
    .get(userId)) as { id: number; started_at: number; status: string; errors_json: string | null } | undefined;
  if (lastPoll && (lastPoll.status === "error" || lastPoll.status === "partial")) {
    const errors = parseErrorsJson(lastPoll.errors_json);
    const boards = Object.keys(errors);
    alerts.push({
      id: lastPoll.status === "error" ? "poll_failed" : "poll_partial",
      severity: lastPoll.status === "error" ? "error" : "warn",
      title:
        lastPoll.status === "error"
          ? "Last ATS poll failed"
          : `Last ATS poll was partial — ${boards.length} board(s) errored`,
      detail: boards
        .slice(0, 5)
        .map((b) => `${b}: ${errors[b]}`)
        .join("; "),
      since: lastPoll.started_at,
      count: boards.length,
    });
  }

  // --- Resume generation failures ------------------------------------------
  const resumeFailures = (await db
    .prepare(
      `SELECT count(*) AS c, min(finished_at) AS since, max(error) AS sample FROM resume_tasks
       WHERE user_id = ? AND status = 'error' AND finished_at >= ?`
    )
    .get(userId, dayAgo)) as { c: number; since: number | null; sample: string | null };
  if (resumeFailures.c > 0) {
    alerts.push({
      id: "resume_failures",
      severity: "warn",
      title: `${resumeFailures.c} résumé generation(s) failed in the last 24h`,
      detail: resumeFailures.sample ?? undefined,
      since: resumeFailures.since ?? undefined,
      count: resumeFailures.c,
    });
  }

  // --- Auto-disabled ATS boards --------------------------------------------
  const disabled = (await db
    .prepare(
      `SELECT name, auto_disabled_at, auto_disabled_reason FROM companies
       WHERE user_id = ? AND enabled = 0 AND auto_disabled_at IS NOT NULL
       ORDER BY auto_disabled_at DESC`
    )
    .all(userId)) as { name: string; auto_disabled_at: number; auto_disabled_reason: string | null }[];
  if (disabled.length > 0) {
    alerts.push({
      id: "boards_disabled",
      severity: "warn",
      title: `${disabled.length} ATS board(s) auto-disabled after permanent errors`,
      detail: disabled
        .slice(0, 5)
        .map((d) => `${d.name}${d.auto_disabled_reason ? ` (${d.auto_disabled_reason})` : ""}`)
        .join(", "),
      since: disabled[disabled.length - 1]!.auto_disabled_at,
      count: disabled.length,
    });
  }

  // --- LinkedIn auto-scan watch stalled ------------------------------------
  const lastScan = (await db
    .prepare("SELECT reported_at FROM scan_runs WHERE user_id = ? ORDER BY reported_at DESC LIMIT 1")
    .get(userId)) as { reported_at: number } | undefined;
  if (
    lastScan &&
    now - lastScan.reported_at <= SCAN_WATCH_EXPECTED_WINDOW_MS &&
    now - lastScan.reported_at > SCAN_WATCH_STALE_AFTER_MS
  ) {
    const hours = Math.round((now - lastScan.reported_at) / 3600 / 1000);
    alerts.push({
      id: "scan_watch_stalled",
      severity: "warn",
      title: `LinkedIn auto-scan watch looks stopped — last report ${hours}h ago`,
      detail: "Check Chrome is open, the PC isn't asleep, and auto-scan is enabled in the extension popup.",
      since: lastScan.reported_at,
    });
  }

  return alerts;
}
