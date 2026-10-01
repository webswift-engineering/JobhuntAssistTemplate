import { describe, it, expect } from "vitest";
import {
  filterFreshRawJobs,
  sortRawJobsByRecency,
  freshRawJobsForPoll,
} from "../src/sources/fetchFreshness.js";
import type { RawJob } from "../src/types.js";

const now = 1_700_000_000_000;
const day = 86_400_000;

function job(postedAt: number | null, title = "x"): RawJob {
  return {
    source: "greenhouse",
    sourceKind: "ats",
    company: "Acme",
    title,
    location: null,
    url: "http://x",
    externalId: title,
    description: null,
    postedAt,
    postedText: null,
  };
}

describe("fetchFreshness", () => {
  it("filterFreshRawJobs drops undated and stale jobs", () => {
    const jobs = [
      job(now - 1000, "fresh"),
      job(now - 2 * day, "stale"),
      job(null, "nodate"),
    ];
    const fresh = filterFreshRawJobs(jobs, { now, maxAgeMs: day });
    expect(fresh.map((j) => j.title)).toEqual(["fresh"]);
  });

  it("sortRawJobsByRecency orders newest first", () => {
    const jobs = [job(now - day, "old"), job(now - 1000, "new")];
    const sorted = sortRawJobsByRecency(jobs);
    expect(sorted.map((j) => j.title)).toEqual(["new", "old"]);
  });

  it("freshRawJobsForPoll sorts, filters, and caps", () => {
    const jobs = [
      job(now - 1000, "a"),
      job(now - 2000, "b"),
      job(now - 2 * day, "stale"),
    ];
    const out = freshRawJobsForPoll(jobs, { now, maxAgeMs: day, limit: 1 });
    expect(out.map((j) => j.title)).toEqual(["a"]);
  });
});
