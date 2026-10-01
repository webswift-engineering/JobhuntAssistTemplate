import { describe, it, expect, beforeEach } from "vitest";
import type { DB } from "../src/db/client.js";
import { createTestDb } from "./helpers.js";
import { ingestJob, getJob } from "../src/store.js";
import {
  recordEvent,
  recordPageCapture,
  activityStats,
  latestPageCapture,
} from "../src/captures.js";
import type { RawJob } from "../src/types.js";

const job = (over: Partial<RawJob> = {}): RawJob => ({
  source: "linkedin",
  sourceKind: "extension",
  company: "Acme",
  title: "Engineer",
  url: "https://linkedin.com/jobs/1",
  externalId: "1",
  ...over,
});

describe("capture events (§6.2, §15)", () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it("'viewed' event sets jobs.viewed_at", async () => {
    const { id } = await ingestJob(db, 1, job());
    expect((await getJob(db, 1, id))!.viewed_at).toBeNull();
    await recordEvent(db, 1, { source: "linkedin", event: "viewed", jobId: id, url: "x" });
    expect((await getJob(db, 1, id))!.viewed_at).not.toBeNull();
  });

  it("apply_intent (tailored true/false) writes a capture_events row", async () => {
    await recordEvent(db, 1, { source: "linkedin", event: "apply_intent", meta: { tailored: true } });
    await recordEvent(db, 1, { source: "linkedin", event: "apply_intent", meta: { tailored: false } });
    const stats = await activityStats(db, 1, 0);
    expect(stats.byEvent["apply_intent"]).toBe(2);
  });

  it("activity stats derive from capture_events/jobs/referrals, NEVER poll_runs", async () => {
    await ingestJob(db, 1, job());
    await recordEvent(db, 1, { source: "linkedin", event: "viewed", jobId: (await getJob(db, 1, (await ingestJob(db, 1, job())).id))!.id });
    const stats = await activityStats(db, 1, 0);
    expect(stats.jobsCaptured).toBeGreaterThanOrEqual(1);
    // poll_runs is untouched by the Path B calls above.
    const pollRunCount = ((await db.prepare("SELECT COUNT(*) n FROM poll_runs").get()) as { n: number }).n;
    expect(pollRunCount).toBe(0);
  });
});

describe("page captures / off-pipeline apply (§6.3)", () => {
  it("creates a jobs row for an off-pipeline apply", async () => {
    const db = createTestDb();
    const before = ((await db.prepare("SELECT COUNT(*) n FROM jobs").get()) as { n: number }).n;
    const res = await recordPageCapture(db, 1, {
      url: "https://boards.greenhouse.io/x/jobs/55",
      source: "greenhouse",
      rawText: "Full JD text for an apply page",
      title: "Off-pipeline Role",
    });
    expect(res.jobId).toBeTruthy();
    const after = ((await db.prepare("SELECT COUNT(*) n FROM jobs").get()) as { n: number }).n;
    expect(after).toBe(before + 1);
    expect((await latestPageCapture(db, 1, res.jobId!))!.raw_text).toContain("Full JD");
  });

  it("page capture does not write poll_runs", async () => {
    const db = createTestDb();
    await recordPageCapture(db, 1, { url: "https://x/apply", rawText: "jd" });
    const n = ((await db.prepare("SELECT COUNT(*) n FROM poll_runs").get()) as { n: number }).n;
    expect(n).toBe(0);
  });
});
