import { describe, it, expect, beforeEach } from "vitest";
import cron from "node-cron";
import type { DB } from "../src/db/client.js";
import { createTestDb, DisabledLlm } from "./helpers.js";
import { runPoll, reconcileStalePollRuns, getPollStatus } from "../src/scheduler.js";
import { setProfile, getJob, ingestJob } from "../src/store.js";
import { recordEvent, recordPageCapture, upsertReferral } from "../src/captures.js";
import type { OrchestratorResult } from "../src/sources/orchestrator.js";
import type { RawJob } from "../src/types.js";

const matchJob: RawJob = {
  source: "greenhouse",
  sourceKind: "ats",
  company: "Acme",
  title: "Frontend Engineer",
  url: "https://x/1",
  externalId: "1",
  description: "react typescript",
};

function deps(jobs: RawJob[], errors: Record<string, string> = {}, polled = 1) {
  const pollFn = async (): Promise<OrchestratorResult> => ({
    jobs,
    companiesPolled: polled,
    errors,
  });
  // Fake Slack send: notificationsSent now reflects the actual high-score push,
  // which only counts as sent when the webhook delivery succeeds.
  const sent: string[] = [];
  const sendFn = async (text: string) => {
    sent.push(text);
    return true;
  };
  return { llm: new DisabledLlm(), dashboardUrl: "http://d", pollFn, sendFn, sent };
}

describe("scheduler poll runs (§7, hard flag #3)", () => {
  let db: DB;
  beforeEach(async () => {
    db = createTestDb();
    await setProfile(db, 1, { preferences: { titles: ["Frontend Engineer"], keywords: ["react"] } });
  });

  it("a successful run writes a poll_runs row with correct counts + one high-score push", async () => {
    const d = deps([matchJob]);
    const summary = await runPoll(db, 1, "manual", d);
    expect(summary.status).toBe("success");
    expect(summary.jobsSeen).toBe(1);
    expect(summary.jobsNew).toBe(1);
    expect(summary.jobsScored).toBe(1);
    expect(summary.notificationsSent).toBe(1);
    // The one message is the high-match FTE push, not a per-source "new jobs" digest.
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]).toContain("high-match FTE");
    expect(d.sent[0]).not.toContain("new ATS job");

    const row = (await db.prepare("SELECT * FROM poll_runs WHERE id = ?").get(summary.id)) as any;
    expect(row.status).toBe("success");
    expect(row.jobs_new).toBe(1);
    expect(row.trigger).toBe("manual");
  });

  it("sub-threshold jobs are silent AND stay unnotified (no notified_at stamp)", async () => {
    // Heuristic score for this job: only 1/2 terms hit, no title match → 0.5 < 0.78.
    const d = deps([{ ...matchJob, title: "Platform Engineer", description: "react only" }]);
    const summary = await runPoll(db, 1, "manual", d);
    expect(summary.notificationsSent).toBe(0);
    expect(d.sent).toHaveLength(0);
    const row = (await db.prepare("SELECT notified_at, state FROM jobs LIMIT 1").get()) as any;
    expect(row.notified_at).toBeNull();
    expect(row.state).not.toBe("notified");
  });

  it("does not notify out-of-region jobs and marks them region-blocked (-1)", async () => {
    const summary = await runPoll(db, 1, "manual", deps([
      {
        ...matchJob,
        externalId: "uk",
        location: "London, UK",
        description: "react typescript",
      },
    ]));
    expect(summary.jobsNew).toBe(1);
    expect(summary.jobsScored).toBe(1);
    expect(summary.notificationsSent).toBe(0);
    const job = await listJobsFromPoll(db, summary);
    // Out-of-region → sentinel -1 (distinct from an in-region irrelevant 0), still hidden/no-notify.
    expect(job.relevance_score).toBe(-1);
  });

  it("scores extension-ingested jobs that poll upserts (not only brand-new rows)", async () => {
    const { id } = await ingestJob(db, 1, matchJob);
    expect((await getJob(db, 1, id))!.relevance_score).toBeNull();

    const summary = await runPoll(db, 1, "manual", deps([matchJob]));
    expect(summary.jobsNew).toBe(0);
    expect(summary.jobsScored).toBe(1);
    expect((await getJob(db, 1, id))!.relevance_score).not.toBeNull();
  });

  it("does not re-notify on the next tick (notified idempotency)", async () => {
    await runPoll(db, 1, "schedule", deps([matchJob]));
    const second = await runPoll(db, 1, "schedule", deps([matchJob]));
    expect(second.notificationsSent).toBe(0);
  });

  it("records status=error + errors_json when an adapter throws and nothing polled", async () => {
    const summary = await runPoll(db, 1, "schedule", deps([], { "Acme (greenhouse)": "boom" }, 0));
    expect(summary.status).toBe("error");
    const row = (await db.prepare("SELECT * FROM poll_runs WHERE id = ?").get(summary.id)) as any;
    expect(JSON.parse(row.errors_json)).toMatchObject({ "Acme (greenhouse)": "boom" });
  });

  it("records status=partial when some companies polled despite errors", async () => {
    const summary = await runPoll(
      db,
      1,
      "schedule",
      deps([matchJob], { "Bad (lever)": "x" }, 1)
    );
    expect(summary.status).toBe("partial");
  });

  it("reconciles all running rows on server startup", async () => {
    const recent = Date.now() - 5 * 60 * 1000;
    const id = Number(
      (
        await db
          .prepare("INSERT INTO poll_runs (started_at, trigger, status) VALUES (?, 'schedule', 'running')")
          .run(recent)
      ).lastInsertRowid
    );
    await reconcileStalePollRuns(db, Date.now(), { startup: true });
    const row = (await db.prepare("SELECT status, errors_json FROM poll_runs WHERE id = ?").get(id)) as {
      status: string;
      errors_json: string;
    };
    expect(row.status).toBe("error");
    expect(JSON.parse(row.errors_json)).toHaveProperty("aborted");
  });

  it("does not reconcile a recent running row during normal ops", async () => {
    const recent = Date.now() - 15 * 60 * 1000;
    const id = Number(
      (
        await db
          .prepare("INSERT INTO poll_runs (started_at, trigger, status) VALUES (?, 'schedule', 'running')")
          .run(recent)
      ).lastInsertRowid
    );
    await reconcileStalePollRuns(db);
    const row = (await db.prepare("SELECT status FROM poll_runs WHERE id = ?").get(id)) as { status: string };
    expect(row.status).toBe("running");
  });

  it("skips a second poll while the first is in flight", async () => {
    const slowPollFn = async (): Promise<OrchestratorResult> => {
      await new Promise((r) => setTimeout(r, 80));
      return { jobs: [matchJob], companiesPolled: 1, errors: {} };
    };
    const slowDeps = { llm: new DisabledLlm(), dashboardUrl: "http://d", pollFn: slowPollFn };
    const first = runPoll(db, 1, "schedule", slowDeps);
    const second = await runPoll(db, 1, "schedule", slowDeps);
    expect(second.skipped).toBe(true);
    expect(second.status).toBe("skipped");
    const count = (await db.prepare("SELECT count(*) as c FROM poll_runs").get()) as { c: number };
    expect(count.c).toBe(1);
    await first;
  });

  it("Path B (events / page-captures / referrals) NEVER creates poll_runs rows", async () => {
    await recordEvent(db, 1, { source: "linkedin", event: "viewed", jobId: (await ingestJob(db, 1, matchJob)).id });
    await recordPageCapture(db, 1, { url: "https://x/apply", rawText: "jd" });
    await upsertReferral(db, 1, { threadUrl: "https://forum.example/t", rawText: "post" });
    const n = ((await db.prepare("SELECT COUNT(*) n FROM poll_runs").get()) as { n: number }).n;
    expect(n).toBe(0);
  });

  it("hourly Mon-Sat poll cron is valid", () => {
    expect(cron.validate("0 * * * 1-6")).toBe(true);
  });
});

async function listJobsFromPoll(db: DB, summary: { jobsNew: number }) {
  const rows = (await db.prepare("SELECT * FROM jobs ORDER BY first_seen_at DESC").all()) as {
    relevance_score: number | null;
  }[];
  expect(rows.length).toBeGreaterThan(0);
  return rows[0]!;
}
