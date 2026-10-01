// Apply stream — the chained batch-apply flow. The dashboard starts a stream
// from the apply queue; the extension's background worker advances it after
// each human Submit and navigates the SAME tab to the next job, so the user
// never round-trips through the dashboard between applications.
//
// Streams are in-memory on purpose: one lives for the minutes a batch takes,
// and a backend restart mid-stream just means restarting it from the dashboard.
import { randomUUID } from "node:crypto";
import type { DB } from "./db/client.js";
import { getJob } from "./store.js";
import { resumeStatusForJobs } from "./resumePipeline.js";
import { freshnessMs } from "./freshness.js";
import { belowSalaryFloor } from "./salary.js";
import type { JobRow } from "./types.js";

/** Hosts the extension apply engine can drive (adapters in extension/applyAdapters.js). */
export const ASSIST_HOST_RE =
  /^https:\/\/(job-boards\.greenhouse\.io|boards\.greenhouse\.io|jobs\.ashbyhq\.com|jobs\.lever\.co)\//i;

/** auto = the engine fills + auto-advances on submit; manual = any other http
 *  URL (LinkedIn, Indeed, Workday, company sites) — the Copilot panel assists
 *  and the human advances with "✓ Applied → next". */
export type StreamMode = "auto" | "manual";

interface Stream {
  id: string;
  userId: number;
  ids: string[];
  pos: number;
  startedAt: number;
  ended: boolean;
}

export interface StreamJobRef {
  id: string;
  url: string;
  index: number; // 0-based position in the stream
  total: number;
  mode: StreamMode;
  title?: string | null;
  company?: string | null;
}

const streams = new Map<string, Stream>();
const STREAM_TTL_MS = 12 * 3600 * 1000;

function purgeExpired(now = Date.now()): void {
  for (const [id, s] of streams) {
    if (s.ended || now - s.startedAt > STREAM_TTL_MS) streams.delete(id);
  }
}

function modeFor(job: JobRow): StreamMode {
  return ASSIST_HOST_RE.test(job.url ?? "") ? "auto" : "manual";
}

/** Posting URL for the stream. Auto-mode jobs carry the extension handoff hash
 *  (`jh-apply` triggers the engine; `jh-stream`/`jh-pos` = stream display).
 *  Manual-mode jobs get the PLAIN URL — the Copilot panel resolves them from
 *  the URL alone, and appending the hash would wake the parked easyApply.js
 *  on LinkedIn. */
function streamRef(job: JobRow, streamId: string, index: number, total: number): StreamJobRef {
  const base = (job.url ?? "").replace(
    "https://boards.greenhouse.io/",
    "https://job-boards.greenhouse.io/"
  );
  const mode = modeFor(job);
  const url =
    mode === "auto" ? `${base}#jh-apply=${job.id}&jh-stream=${streamId}&jh-pos=${index + 1}-${total}` : base;
  return { id: job.id, url, index, total, mode, title: job.title, company: job.company };
}

/** Is this job still worth presenting? (re-checked at advance time too, so jobs
 *  applied from another tab mid-stream are skipped, not re-shown). */
function actionable(job: JobRow | null | undefined): job is JobRow {
  return !!job && job.state !== "applied" && job.state !== "skipped" && /^https?:/.test(job.url ?? "");
}

export interface StartStreamResult {
  streamId: string | null;
  total: number;
  /** How many jobs the engine will auto-fill vs how many the panel assists. */
  counts: { auto: number; manual: number };
  first: StreamJobRef | null;
  /** Requested ids that didn't make the stream, with the reason — surfaced as a
   *  toast so "12 queued → 9 streamed" is never a silent mystery. */
  skipped: {
    id: string;
    reason: "not_found" | "no_url" | "not_actionable" | "stale" | "no_resume" | "below_salary_floor";
  }[];
}

export async function startApplyStream(
  db: DB,
  userId: number,
  requestedIds: string[]
): Promise<StartStreamResult> {
  purgeExpired();
  const ids = [...new Set(requestedIds)].slice(0, 100);
  const skipped: StartStreamResult["skipped"] = [];
  const resumeStatus = await resumeStatusForJobs(db, ids);
  const freshCutoff = Date.now() - freshnessMs();
  const eligible: JobRow[] = [];
  for (const id of ids) {
    const job = await getJob(db, userId, id);
    if (!job) skipped.push({ id, reason: "not_found" });
    else if (!/^https?:/.test(job.url ?? "")) skipped.push({ id, reason: "no_url" });
    else if (job.state === "applied" || job.state === "skipped") skipped.push({ id, reason: "not_actionable" });
    else if ((job.posted_at ?? job.first_seen_at) < freshCutoff) skipped.push({ id, reason: "stale" });
    else if (belowSalaryFloor(job)) skipped.push({ id, reason: "below_salary_floor" });
    else if (resumeStatus.get(id)?.status !== "ready") skipped.push({ id, reason: "no_resume" });
    else eligible.push(job);
  }
  const counts = {
    auto: eligible.filter((j) => modeFor(j) === "auto").length,
    manual: eligible.filter((j) => modeFor(j) === "manual").length,
  };
  if (!eligible.length) return { streamId: null, total: 0, counts, first: null, skipped };

  const stream: Stream = {
    id: randomUUID().replace(/-/g, "").slice(0, 16),
    userId,
    ids: eligible.map((j) => j.id),
    pos: 0,
    startedAt: Date.now(),
    ended: false,
  };
  streams.set(stream.id, stream);
  return {
    streamId: stream.id,
    total: stream.ids.length,
    counts,
    first: streamRef(eligible[0]!, stream.id, 0, stream.ids.length),
    skipped,
  };
}

export interface AdvanceResult {
  done: boolean;
  next: StreamJobRef | null;
  total: number;
  remaining: number;
}

/**
 * Advance past `afterId` and return the next presentable job.
 *
 * Idempotent by position: the extension can fire twice for one submission
 * (confirmation watcher + pagehide fallback) — only the call whose `afterId`
 * is the CURRENT position moves the cursor; a duplicate for an already-passed
 * id just re-reads the current position without moving it.
 */
export async function advanceApplyStream(
  db: DB,
  userId: number,
  streamId: string,
  afterId: string
): Promise<AdvanceResult | null> {
  const s = streams.get(streamId);
  if (!s || s.ended || s.userId !== userId) return null;
  if (s.ids[s.pos] === afterId) s.pos += 1;

  // Skip anything that stopped being actionable mid-stream (applied elsewhere,
  // state flipped on the dashboard). Freshness is NOT re-checked: it was fresh
  // at stream start, and a batch lasting past the 24h boundary shouldn't drop
  // its own tail mid-run.
  while (s.pos < s.ids.length) {
    const job = await getJob(db, userId, s.ids[s.pos]!);
    if (actionable(job)) {
      return {
        done: false,
        next: streamRef(job, s.id, s.pos, s.ids.length),
        total: s.ids.length,
        remaining: s.ids.length - s.pos,
      };
    }
    s.pos += 1;
  }
  s.ended = true;
  return { done: true, next: null, total: s.ids.length, remaining: 0 };
}

/** The user's most recent live stream + its CURRENT job — lets the Copilot
 *  panel attach to a stream it didn't start (it drives manual-mode jobs). */
export async function currentApplyStream(
  db: DB,
  userId: number
): Promise<{ streamId: string; current: StreamJobRef; remaining: number } | null> {
  purgeExpired();
  const live = [...streams.values()]
    .filter((s) => s.userId === userId && !s.ended)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!live) return null;
  // Present the job at the cursor, skipping anything no longer actionable —
  // WITHOUT moving the cursor (advance owns that).
  for (let i = live.pos; i < live.ids.length; i++) {
    const job = await getJob(db, userId, live.ids[i]!);
    if (actionable(job)) {
      return {
        streamId: live.id,
        current: streamRef(job, live.id, i, live.ids.length),
        remaining: live.ids.length - i,
      };
    }
  }
  return null;
}

export function endApplyStream(userId: number, streamId: string): boolean {
  const s = streams.get(streamId);
  if (!s || s.userId !== userId) return false;
  s.ended = true;
  streams.delete(streamId);
  return true;
}

/** Test hook. */
export function _clearStreams(): void {
  streams.clear();
}
