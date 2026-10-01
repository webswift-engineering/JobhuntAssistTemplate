import { createHash } from "node:crypto";
import type { DB } from "./db/client.js";
import type { CompanyRow } from "./types.js";
import { ADAPTERS } from "./sources/orchestrator.js";
import { fetchText } from "./sources/AtsAdapter.js";
import { sleep } from "./sources/AtsAdapter.js";
import type { LlmClient } from "./llm/client.js";
import { updateCompany } from "./store.js";
import {
  heuristicBoardCandidates,
  suggestBoardTokens,
  type BoardCandidate,
} from "./llm/suggestBoardTokens.js";

export type CompanyPollStatus = "active" | "empty" | "error";

/** HTTP / config failures that won't heal on the next hourly poll. */
export function isPermanentBoardError(message: string): boolean {
  return (
    /HTTP 404\b/.test(message) ||
    /HTTP 401\b/.test(message) ||
    /HTTP 403\b/.test(message) ||
    /HTTP 410\b/.test(message) ||
    /No adapter for/.test(message) ||
    /boardToken must be/.test(message)
  );
}

/**
 * Disable boards that returned permanent errors so future polls finish `success`
 * instead of repeating the same partial run every hour.
 */
export async function autoDisableBrokenCompanies(
  db: DB,
  companies: CompanyRow[],
  errors: Record<string, string>
): Promise<string[]> {
  const disabled: string[] = [];
  for (const c of companies) {
    const label = `${c.name} (${c.ats})`;
    const err = errors[label];
    if (!err || !isPermanentBoardError(err) || !c.enabled) continue;
    await db.prepare(
      "UPDATE companies SET enabled = 0, auto_disabled_at = ?, auto_disabled_reason = ? WHERE id = ?"
    ).run(Date.now(), err.slice(0, 300), c.id);
    disabled.push(c.name);
    console.warn(`[poll] auto-disabled ${c.name} (${c.ats}): ${err}`);
  }
  return disabled;
}

export interface CompanyHealthRow {
  id: number;
  name: string;
  ats: string;
  board_token: string;
  enabled: number;
  last_job_count: number | null;
  last_poll_status: CompanyPollStatus | null;
  last_polled_at: number | null;
  consecutive_failures: number;
  last_error: string | null;
  auto_disabled_at: number | null;
  auto_disabled_reason: string | null;
}

export async function setCompanyPollHealth(
  db: DB,
  id: number,
  jobCount: number,
  status: CompanyPollStatus
): Promise<void> {
  await db.prepare(
    `UPDATE companies SET last_job_count = ?, last_poll_status = ?, last_polled_at = ? WHERE id = ?`
  ).run(jobCount, status, Date.now(), id);
}

/** Probe one ATS board (live job count). */
export async function probeCompanyBoard(company: CompanyRow): Promise<{
  jobCount: number;
  status: CompanyPollStatus;
  error?: string;
}> {
  const adapter = ADAPTERS[company.ats];
  if (!adapter) {
    return { jobCount: 0, status: "error", error: `No adapter for ${company.ats}` };
  }
  try {
    const jobs = await adapter.fetchJobs({ name: company.name, boardToken: company.board_token });
    const jobCount = jobs.length;
    return { jobCount, status: jobCount === 0 ? "empty" : "active" };
  } catch (err) {
    return { jobCount: 0, status: "error", error: (err as Error).message };
  }
}

export interface BoardRecoveryResult {
  name: string;
  outcome: "reenabled" | "switched" | "still_broken";
  /** Set on "switched": where the board lives now. */
  ats?: string;
  boardToken?: string;
  /** Set on "still_broken": how many candidates were probed. */
  tried?: number;
  error?: string;
}

async function reenableCompany(db: DB, id: number, jobCount: number): Promise<void> {
  await db
    .prepare(
      `UPDATE companies SET enabled = 1, auto_disabled_at = NULL, auto_disabled_reason = NULL,
         consecutive_failures = 0, last_error = NULL,
         last_job_count = ?, last_poll_status = 'active', last_polled_at = ? WHERE id = ?`
    )
    .run(jobCount, Date.now(), id);
}

/**
 * Recover auto-disabled boards (the alert-banner "🔧 Recover" action):
 * 1. Re-probe the stored board — transient outages heal with a re-enable.
 * 2. Still broken → probe CANDIDATE boards: DeepSeek proposes where the company
 *    may have migrated (Lever→Greenhouse etc.) plus deterministic slug variants.
 *    A candidate is accepted ONLY if its public API answers with live jobs —
 *    an LLM guess is never written to the DB unverified.
 */
export async function recoverDisabledBoards(
  db: DB,
  userId: number,
  llm: LlmClient,
  deps: { probe?: typeof probeCompanyBoard } = {}
): Promise<BoardRecoveryResult[]> {
  const probe = deps.probe ?? probeCompanyBoard;
  const disabled = (await db
    .prepare("SELECT * FROM companies WHERE user_id = ? AND auto_disabled_at IS NOT NULL")
    .all(userId)) as (CompanyRow & Pick<CompanyHealthRow, "auto_disabled_reason" | "last_error">)[];
  const results: BoardRecoveryResult[] = [];

  for (const c of disabled) {
    // 1. Same board healed?
    const same = await probe(c);
    if (same.status !== "error") {
      await reenableCompany(db, c.id, same.jobCount);
      results.push({ name: c.name, outcome: "reenabled", ats: c.ats, boardToken: c.board_token });
      continue;
    }

    // 2. Candidate boards: LLM suggestions first (they encode "who migrated
    // where"), then slug heuristics; dedupe, skip the known-broken pair, cap.
    const seen = new Set([`${c.ats}:${c.board_token}`]);
    const candidates: BoardCandidate[] = [];
    for (const cand of [
      ...(await suggestBoardTokens(llm, {
        company: c.name,
        oldAts: c.ats,
        oldToken: c.board_token,
        error: c.auto_disabled_reason ?? c.last_error ?? null,
      })),
      ...heuristicBoardCandidates(c.name),
    ]) {
      const key = `${cand.ats}:${cand.boardToken}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(cand);
      if (candidates.length >= 8) break;
    }

    let switched = false;
    for (const cand of candidates) {
      const r = await probe({ ...c, ats: cand.ats, board_token: cand.boardToken });
      // "active" only: a wrong token usually 404s, but an empty board can also
      // be someone ELSE's unused slug — never switch onto a board with no jobs.
      if (r.status === "active") {
        // Via updateCompany so store's URL-canonicalization company cache is
        // invalidated along with the ats/token change.
        await updateCompany(db, userId, c.id, {
          ats: cand.ats,
          boardToken: cand.boardToken,
          enabled: true,
        });
        await reenableCompany(db, c.id, r.jobCount);
        results.push({ name: c.name, outcome: "switched", ats: cand.ats, boardToken: cand.boardToken });
        switched = true;
        break;
      }
      await sleep(150); // be polite to the public APIs
    }
    if (!switched) {
      results.push({
        name: c.name,
        outcome: "still_broken",
        tried: candidates.length,
        error: same.error,
      });
    }
  }
  return results;
}

/** Update health from a completed orchestrator batch (no extra HTTP). */
export async function recordCompanyHealthFromPoll(
  db: DB,
  companies: CompanyRow[],
  jobsByCompany: Map<string, number>,
  errors: Record<string, string>
): Promise<void> {
  const ts = Date.now();
  for (const c of companies) {
    const label = `${c.name} (${c.ats})`;
    if (errors[label]) {
      await db.prepare(
        `UPDATE companies SET last_job_count = 0, last_poll_status = 'error', last_polled_at = ?,
           consecutive_failures = consecutive_failures + 1, last_error = ? WHERE id = ?`
      ).run(ts, errors[label]!.slice(0, 300), c.id);
      continue;
    }
    const count = jobsByCompany.get(c.name) ?? 0;
    const status: CompanyPollStatus = count === 0 ? "empty" : "active";
    await setCompanyPollHealth(db, c.id, count, status);
    await db.prepare("UPDATE companies SET consecutive_failures = 0, last_error = NULL WHERE id = ?").run(
      c.id
    );
  }
}

export async function listCompanyHealth(db: DB, userId: number): Promise<CompanyHealthRow[]> {
  return (await db
    .prepare(
      `SELECT id, name, ats, board_token, enabled, last_job_count, last_poll_status, last_polled_at,
              consecutive_failures, last_error, auto_disabled_at, auto_disabled_reason
       FROM companies WHERE user_id = ? ORDER BY name`
    )
    .all(userId)) as CompanyHealthRow[];
}

export type CareerWatchStatus = "active" | "empty" | "freeze_hint" | "error";

export interface CareerWatchRow {
  id: number;
  name: string;
  url: string;
  search_url: string | null;
  enabled: number;
  last_open_count: number | null;
  last_status: CareerWatchStatus | null;
  last_hint: string | null;
  last_polled_at: number | null;
  content_hash: string | null;
}

export async function listCareerWatches(db: DB, userId: number, onlyEnabled = false): Promise<CareerWatchRow[]> {
  const sql = onlyEnabled
    ? "SELECT * FROM career_watches WHERE user_id = ? AND enabled = 1 ORDER BY name"
    : "SELECT * FROM career_watches WHERE user_id = ? ORDER BY name";
  return (await db.prepare(sql).all(userId)) as CareerWatchRow[];
}

export async function upsertCareerWatch(
  db: DB,
  userId: number,
  w: { name: string; url: string; searchUrl?: string | null; enabled?: boolean }
): Promise<CareerWatchRow> {
  const existing = (await db
    .prepare("SELECT id FROM career_watches WHERE user_id = ? AND name = ?")
    .get(userId, w.name)) as { id: number } | undefined;
  const enabled = w.enabled === false ? 0 : 1;
  if (existing) {
    await db.prepare(
      `UPDATE career_watches SET url = ?, search_url = ?, enabled = ? WHERE id = ?`
    ).run(w.url, w.searchUrl ?? null, enabled, existing.id);
    return (await db.prepare("SELECT * FROM career_watches WHERE id = ?").get(existing.id)) as CareerWatchRow;
  }
  const info = await db
    .prepare(
      `INSERT INTO career_watches (user_id, name, url, search_url, enabled) VALUES (?,?,?,?,?)`
    )
    .run(userId, w.name, w.url, w.searchUrl ?? null, enabled);
  return (await db
    .prepare("SELECT * FROM career_watches WHERE id = ?")
    .get(info.lastInsertRowid)) as CareerWatchRow;
}

function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function estimateOpenRoles(html: string): number {
  const jobPostings = (html.match(/"@type"\s*:\s*"JobPosting"/gi) ?? []).length;
  if (jobPostings > 0) return jobPostings;

  const resultCards =
    (html.match(/class="[^"]*job[^"]*"/gi) ?? []).length +
    (html.match(/data-job-id/gi) ?? []).length +
    (html.match(/job-result/gi) ?? []).length;

  const jobPaths = new Set(
    (html.match(/\/jobs?\/[a-z0-9][a-z0-9/_-]{4,}/gi) ?? []).map((p) => p.toLowerCase())
  );

  const best = Math.max(jobPostings, resultCards, jobPaths.size);
  return Math.min(best, 500);
}

function detectFreezeHint(html: string): string | null {
  const lower = html.toLowerCase();
  const patterns = [
    "hiring freeze",
    "not currently hiring",
    "no open positions",
    "no open roles",
    "paused hiring",
    "hiring pause",
  ];
  for (const p of patterns) {
    if (lower.includes(p)) return p;
  }
  return null;
}

export async function probeCareerWatch(w: CareerWatchRow): Promise<{
  openCount: number;
  status: CareerWatchStatus;
  hint: string | null;
  contentHash: string;
}> {
  const target = w.search_url ?? w.url;
  try {
    const html = await fetchText(target);
    const contentHash = hashContent(html.slice(0, 50000));
    const freeze = detectFreezeHint(html);
    if (freeze) {
      return { openCount: 0, status: "freeze_hint", hint: freeze, contentHash };
    }
    const openCount = estimateOpenRoles(html);
    const status: CareerWatchStatus = openCount === 0 ? "empty" : "active";
    return { openCount, status, hint: null, contentHash };
  } catch (err) {
    return {
      openCount: 0,
      status: "error",
      hint: (err as Error).message,
      contentHash: "",
    };
  }
}

export async function saveCareerWatchProbe(
  db: DB,
  id: number,
  probe: {
    openCount: number;
    status: CareerWatchStatus;
    hint: string | null;
    contentHash: string;
  }
): Promise<void> {
  await db.prepare(
    `UPDATE career_watches SET
       last_open_count = ?, last_status = ?, last_hint = ?, last_polled_at = ?, content_hash = ?
     WHERE id = ?`
  ).run(
    probe.openCount,
    probe.status,
    probe.hint,
    Date.now(),
    probe.contentHash || null,
    id
  );
}

/** Poll all enabled career watches (FAANG + manual portals). */
export async function pollCareerWatches(db: DB, userId: number): Promise<{
  polled: number;
  results: Array<{ name: string; status: CareerWatchStatus; openCount: number; hint: string | null }>;
}> {
  const watches = await listCareerWatches(db, userId, true);
  const results: Array<{
    name: string;
    status: CareerWatchStatus;
    openCount: number;
    hint: string | null;
  }> = [];
  for (const w of watches) {
    const probe = await probeCareerWatch(w);
    await saveCareerWatchProbe(db, w.id, probe);
    results.push({
      name: w.name,
      status: probe.status,
      openCount: probe.openCount,
      hint: probe.hint,
    });
    await sleep(1200);
  }
  return { polled: watches.length, results };
}

/** Live probe every enabled ATS company (for admin validation). */
export async function validateAllCompanies(db: DB, userId: number): Promise<
  Array<{
    name: string;
    ats: string;
    enabled: number;
    jobCount: number;
    status: CompanyPollStatus;
    error?: string;
    hiringNote: string;
  }>
> {
  const companies = (await db
    .prepare("SELECT * FROM companies WHERE user_id = ? ORDER BY name")
    .all(userId)) as CompanyRow[];
  const out: Array<{
    name: string;
    ats: string;
    enabled: number;
    jobCount: number;
    status: CompanyPollStatus;
    error?: string;
    hiringNote: string;
  }> = [];
  for (const c of companies) {
    if (!c.enabled) {
      out.push({
        name: c.name,
        ats: c.ats,
        enabled: c.enabled,
        jobCount: 0,
        status: "empty",
        hiringNote: "disabled in dashboard",
      });
      continue;
    }
    const r = await probeCompanyBoard(c);
    await setCompanyPollHealth(db, c.id, r.jobCount, r.status);
    const hiringNote =
      r.status === "active"
        ? "board has open roles"
        : r.status === "empty"
          ? "0 jobs on public board — may be freeze, paused board, or no matching filter"
          : (r.error ?? "poll failed");
    out.push({
      name: c.name,
      ats: c.ats,
      enabled: c.enabled,
      jobCount: r.jobCount,
      status: r.status,
      error: r.error,
      hiringNote,
    });
    await sleep(800);
  }
  return out;
}
