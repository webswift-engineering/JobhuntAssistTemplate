import { describe, it, expect, beforeEach } from "vitest";
import type { DB } from "../src/db/client.js";
import { createTestDb } from "./helpers.js";
import {
  recordScanReport,
  lastScanRun,
  checkScanWatchStale,
} from "../src/scanWatch.js";

// High-intent pivot 2026-08: the per-report scan digest (notifyNewScanJobs) is gone —
// the /scan/report route calls notifyHighScoreJobs directly (covered in
// highScoreNotify.test.ts). This suite keeps the run-report + stale-nudge coverage.

const H = 3600 * 1000;
// Fixed instants in America/New_York (the default scheduler TZ used by the nudge).
const NOON_EST = Date.UTC(2026, 0, 5, 17, 0, 0); // 12:00 EST — waking hours
const NIGHT_EST = Date.UTC(2026, 0, 5, 7, 0, 0); // 02:00 EST — quiet hours

describe("scan run reports", () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it("records a report and exposes it as the last run", async () => {
    const id = await recordScanReport(
      db,
      1,
      { source: "linkedin-auto", scanned: 18, strong: 2, maybe: 3, persisted: 5 },
      NOON_EST
    );
    const last = (await lastScanRun(db, 1))!;
    expect(last.id).toBe(id);
    expect(last.source).toBe("linkedin-auto");
    expect(last.scanned).toBe(18);
    expect(last.persisted).toBe(5);
    expect(last.reported_at).toBe(NOON_EST);
  });
});

describe("stale watch nudge", () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  const report = (at: number) =>
    recordScanReport(db, 1, { source: "linkedin-auto", scanned: 10, strong: 0, maybe: 0, persisted: 0 }, at);

  it("does nothing when the watch has never reported", async () => {
    const res = await checkScanWatchStale(db, 1, { now: NOON_EST });
    expect(res).toEqual({ sent: false, reason: "no recent watch activity" });
  });

  it("does nothing while reports are fresh", async () => {
    await report(NOON_EST - 1 * H);
    const res = await checkScanWatchStale(db, 1, { now: NOON_EST });
    expect(res).toEqual({ sent: false, reason: "watch is fresh" });
  });

  it("nudges once per stall, not on every hourly check", async () => {
    await report(NOON_EST - 9 * H);
    const first = await checkScanWatchStale(db, 1, { now: NOON_EST });
    expect(first.sent).toBe(true);

    const second = await checkScanWatchStale(db, 1, { now: NOON_EST + 1 * H });
    expect(second).toEqual({ sent: false, reason: "already nudged for this stall" });
  });

  it("nudges again when the watch recovers and then stalls again", async () => {
    await report(NOON_EST - 9 * H);
    await checkScanWatchStale(db, 1, { now: NOON_EST }); // first stall nudged

    await report(NOON_EST + 1 * H); // watch came back (13:00)
    const res = await checkScanWatchStale(db, 1, { now: NOON_EST + 4.5 * H }); // 16:30 EST, 3.5h silent
    expect(res.sent).toBe(true);
  });

  it("stays silent during quiet hours", async () => {
    await report(NIGHT_EST - 9 * H);
    const res = await checkScanWatchStale(db, 1, { now: NIGHT_EST });
    expect(res).toEqual({ sent: false, reason: "quiet hours" });
  });

  it("stays silent outside the weekday 07–17 scan window (evening, weekend)", async () => {
    await report(NOON_EST - 9 * H);
    const evening = await checkScanWatchStale(db, 1, { now: NOON_EST + 10 * H }); // 22:00 Mon
    expect(evening).toEqual({ sent: false, reason: "quiet hours" });
    const saturday = await checkScanWatchStale(db, 1, { now: NOON_EST + 5 * 24 * H }); // 12:00 Sat
    expect(saturday).toEqual({ sent: false, reason: "quiet hours" });
  });

  it("gives the window time to open before calling a morning stall", async () => {
    // Last report yesterday 16:30; at 08:00 the window has been open 1h — a 90-min
    // cadence can't be overdue yet, so no nudge until ~10:00.
    const EIGHT_AM = NOON_EST - 4 * H;
    await report(EIGHT_AM - 15.5 * H);
    const early = await checkScanWatchStale(db, 1, { now: EIGHT_AM });
    expect(early).toEqual({ sent: false, reason: "window just opened" });
    const later = await checkScanWatchStale(db, 1, { now: EIGHT_AM + 2.5 * H }); // 10:30
    expect(later.sent).toBe(true);
  });

  it("treats a watch silent for over a week as intentionally stopped", async () => {
    await report(NOON_EST - 8 * 24 * H);
    const res = await checkScanWatchStale(db, 1, { now: NOON_EST });
    expect(res).toEqual({ sent: false, reason: "no recent watch activity" });
  });
});
