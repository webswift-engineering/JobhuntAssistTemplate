import { freshnessMs } from "../freshness.js";
import type { RawJob } from "../types.js";

/** Sort by ATS post date (newest first). Jobs without a date sink to the bottom. */
export function sortRawJobsByRecency(jobs: RawJob[]): RawJob[] {
  return [...jobs].sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));
}

/**
 * Keep only jobs with a known post date inside the freshness window (default 24h).
 * Jobs with no post date are dropped — they can't be trusted as "recent".
 */
export function filterFreshRawJobs(
  jobs: RawJob[],
  opts: { maxAgeMs?: number; now?: number } = {}
): RawJob[] {
  const maxAge = opts.maxAgeMs ?? freshnessMs();
  const now = opts.now ?? Date.now();
  return jobs.filter((j) => {
    if (j.postedAt == null) return false;
    return now - j.postedAt <= maxAge;
  });
}

/** After fetch: sort newest-first, then keep only jobs inside the freshness window. */
export function freshRawJobsForPoll(
  jobs: RawJob[],
  opts: { maxAgeMs?: number; now?: number; limit?: number } = {}
): RawJob[] {
  const sorted = sortRawJobsByRecency(jobs);
  const fresh = filterFreshRawJobs(sorted, opts);
  const limit = opts.limit;
  return limit != null ? fresh.slice(0, limit) : fresh;
}
