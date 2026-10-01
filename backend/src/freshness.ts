import type { JobRow } from "./types.js";
import { config } from "./config.js";

/** Prefer ATS `posted_at`; fall back to when we first captured the job. */
export function jobReferenceTime(job: Pick<JobRow, "posted_at" | "first_seen_at">): number {
  return job.posted_at ?? job.first_seen_at;
}

export function freshnessMs(hours?: number): number {
  const h = hours ?? config.freshness.hours;
  return h * 60 * 60 * 1000;
}

/** True if the job was posted (or first seen) within the freshness window. */
export function isFreshJob(
  job: Pick<JobRow, "posted_at" | "first_seen_at">,
  opts: { maxAgeMs?: number; now?: number } = {}
): boolean {
  const maxAge = opts.maxAgeMs ?? freshnessMs();
  const now = opts.now ?? Date.now();
  return now - jobReferenceTime(job) <= maxAge;
}

export function freshnessAgeLabel(job: Pick<JobRow, "posted_at" | "first_seen_at">, now = Date.now()): string {
  const ref = jobReferenceTime(job);
  const hrs = Math.floor((now - ref) / (60 * 60 * 1000));
  if (hrs < 1) return "posted <1h ago";
  if (hrs < 24) return `posted ${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `posted ${days}d ago`;
}
