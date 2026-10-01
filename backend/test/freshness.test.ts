import { describe, it, expect } from "vitest";
import { isFreshJob, jobReferenceTime, freshnessAgeLabel } from "../src/freshness.js";

describe("freshness (24h focus)", () => {
  const now = 1_700_000_000_000;
  const day = 24 * 60 * 60 * 1000;

  it("uses posted_at when present", () => {
    expect(jobReferenceTime({ posted_at: now - 1000, first_seen_at: now - day * 5 })).toBe(now - 1000);
  });

  it("falls back to first_seen_at when posted_at missing", () => {
    expect(jobReferenceTime({ posted_at: null, first_seen_at: now - 3600_000 })).toBe(now - 3600_000);
  });

  it("fresh within 24h", () => {
    expect(isFreshJob({ posted_at: now - 12 * 3600_000, first_seen_at: now }, { now, maxAgeMs: day })).toBe(true);
  });

  it("stale after 24h", () => {
    expect(isFreshJob({ posted_at: now - 25 * 3600_000, first_seen_at: now }, { now, maxAgeMs: day })).toBe(false);
  });

  it("labels age for UI", () => {
    expect(freshnessAgeLabel({ posted_at: now - 2 * 3600_000, first_seen_at: now }, now)).toBe("posted 2h ago");
  });
});
