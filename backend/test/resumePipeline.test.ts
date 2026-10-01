import { describe, it, expect, beforeEach } from "vitest";
import type { DB } from "../src/db/client.js";
import { createTestDb } from "./helpers.js";
import { setProfile, ingestJob, setRelevance } from "../src/store.js";
import {
  enqueueEligibleResumes,
  startResumeWorker,
  requeueInterruptedResumeTasks,
  resumePipelineStatus,
  resumeStatusForJobs,
  resumeStatusForJob,
  type ResumePipelineDeps,
} from "../src/resumePipeline.js";
import type { RawJob } from "../src/types.js";

const H = 3600 * 1000;

function job(externalId: string, overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: "linkedin",
    sourceKind: "discovery",
    company: "Acme",
    title: `Backend Engineer ${externalId}`,
    url: `https://x/${externalId}`,
    externalId,
    description: "java backend",
    ...overrides,
  };
}

async function seed(db: DB, externalId: string, score: number): Promise<string> {
  const { id } = await ingestJob(db, 1, job(externalId));
  await setRelevance(db, 1, id, score, "test");
  return id;
}

describe("resume pipeline", () => {
  let db: DB;
  let generated: string[];
  let deps: ResumePipelineDeps;

  beforeEach(async () => {
    db = createTestDb();
    await setProfile(db, 1, { preferences: { titles: ["Backend Engineer"], keywords: ["java"] } });
    generated = [];
    deps = {
      requireMasterResume: false,
      threshold: 0.7,
      generateFn: async (_db, _userId, jobId) => {
        generated.push(jobId);
      },
    };
  });

  it("queues only fresh, actionable jobs at or above the threshold and processes them to done", async () => {
    const high = await seed(db, "high", 0.8);
    await seed(db, "low", 0.5); // below threshold
    const stale = await seed(db, "stale", 0.9);
    const old = Date.now() - 3 * 24 * H;
    await db.prepare("UPDATE jobs SET first_seen_at = ?, posted_at = ? WHERE id = ?").run(old, old, stale);
    const applied = await seed(db, "applied", 0.9);
    await db.prepare("UPDATE jobs SET state = 'applied' WHERE id = ?").run(applied);
    const hasArtifact = await seed(db, "artifact", 0.9);
    await db.prepare(
      "INSERT INTO resume_artifacts (job_id, format, path, bytes, generated_at) VALUES (?, 'pdf', 'x.pdf', 1, ?)"
    ).run(hasArtifact, Date.now());

    const res = await enqueueEligibleResumes(db, 1, deps);
    expect(res.enqueued).toBe(1);
    await startResumeWorker(db, deps);

    expect(generated).toEqual([high]);
    const status = await resumePipelineStatus(db, 1);
    expect(status.counts).toMatchObject({ queued: 0, running: 0, done: 1, error: 0 });
  });

  it("does not re-queue jobs that already have a task (idempotent across scans)", async () => {
    await seed(db, "once", 0.8);
    await enqueueEligibleResumes(db, 1, deps);
    await startResumeWorker(db, deps);
    const again = await enqueueEligibleResumes(db, 1, deps);
    expect(again.enqueued).toBe(0);
    expect(generated).toHaveLength(1);
  });

  it("marks failed generations as error with the message, and keeps draining the queue", async () => {
    const bad = await seed(db, "bad", 0.9);
    const good = await seed(db, "good", 0.8);
    deps.generateFn = async (_db, _userId, jobId) => {
      if (jobId === bad) throw new Error("PDF render exploded");
      generated.push(jobId);
    };

    await enqueueEligibleResumes(db, 1, deps);
    await startResumeWorker(db, deps);

    expect(generated).toEqual([good]);
    const status = await resumePipelineStatus(db, 1);
    expect(status.counts).toMatchObject({ done: 1, error: 1 });
    const task = status.tasks.find((t) => t.job_id === bad)!;
    expect(task.status).toBe("error");
    expect(task.error).toContain("PDF render exploded");
  });

  it("requeues tasks interrupted by a restart", async () => {
    const id = await seed(db, "interrupted", 0.8);
    await db.prepare(
      "INSERT INTO resume_tasks (job_id, status, queued_at, started_at) VALUES (?, 'running', ?, ?)"
    ).run(id, Date.now(), Date.now());

    expect(await requeueInterruptedResumeTasks(db)).toBe(1);
    await startResumeWorker(db, deps);
    expect(generated).toEqual([id]);
  });

  it("reports per-job status for the dashboard (ready > generating > queued > error > none)", async () => {
    const ready = await seed(db, "ready", 0.8);
    await db.prepare(
      "INSERT INTO resume_artifacts (job_id, format, path, bytes, generated_at) VALUES (?, 'pdf', 'x.pdf', 1, ?)"
    ).run(ready, Date.now());
    await db.prepare(
      "INSERT INTO resume_artifacts (job_id, format, path, bytes, generated_at) VALUES (?, 'docx', 'x.docx', 1, ?)"
    ).run(ready, Date.now());
    const queued = await seed(db, "queued", 0.8);
    await db.prepare("INSERT INTO resume_tasks (job_id, status, queued_at) VALUES (?, 'queued', ?)").run(
      queued,
      Date.now()
    );
    const errored = await seed(db, "errored", 0.8);
    await db.prepare(
      "INSERT INTO resume_tasks (job_id, status, error, queued_at) VALUES (?, 'error', 'boom', ?)"
    ).run(errored, Date.now());
    const untouched = await seed(db, "untouched", 0.2);

    const m = await resumeStatusForJobs(db, [ready, queued, errored, untouched]);
    expect(m.get(ready)!.status).toBe("ready");
    expect(m.get(ready)!.formats.sort()).toEqual(["docx", "pdf"]);
    expect(m.get(queued)).toMatchObject({ status: "queued" });
    expect(m.get(errored)).toMatchObject({ status: "error", error: "boom" });
    expect(m.get(untouched)).toMatchObject({ status: "none" });
  });

  it("reports detailed single-job status for the modal poller (resumeStatusForJob)", async () => {
    const idle = await seed(db, "st-idle", 0.2);
    expect(await resumeStatusForJob(db, idle)).toMatchObject({ status: "idle", generatedAt: null, artifacts: [] });

    const queued = await seed(db, "st-queued", 0.8);
    await db.prepare("INSERT INTO resume_tasks (job_id, status, queued_at) VALUES (?, 'queued', ?)").run(queued, 111);
    expect(await resumeStatusForJob(db, queued)).toMatchObject({ status: "queued", queuedAt: 111 });

    // A running task beats mid-run artifact rows — the worker writes artifacts
    // incrementally, so partial files must not read as "done".
    const running = await seed(db, "st-running", 0.8);
    await db.prepare(
      "INSERT INTO resume_tasks (job_id, status, queued_at, started_at) VALUES (?, 'running', ?, ?)"
    ).run(running, 111, 222);
    await db.prepare(
      "INSERT INTO resume_artifacts (job_id, format, path, bytes, generated_at) VALUES (?, 'txt', 'r.txt', 1, ?)"
    ).run(running, 333);
    expect(await resumeStatusForJob(db, running)).toMatchObject({ status: "running", startedAt: 222 });

    const done = await seed(db, "st-done", 0.8);
    await db.prepare(
      "INSERT INTO resume_artifacts (job_id, format, path, bytes, generated_at) VALUES (?, 'pdf', 'x.pdf', 1, ?)"
    ).run(done, 444);
    await db.prepare(
      "INSERT INTO resume_artifacts (job_id, format, path, bytes, generated_at) VALUES (?, 'manifest', 'job.json', 1, ?)"
    ).run(done, 555);
    const d = await resumeStatusForJob(db, done);
    expect(d.status).toBe("done");
    expect(d.generatedAt).toBe(555);
    expect(d.artifacts.map((a) => a.format).sort()).toEqual(["manifest", "pdf"]);
    expect(d.artifacts.find((a) => a.format === "manifest")!.generatedAt).toBe(555);

    const failed = await seed(db, "st-failed", 0.8);
    await db.prepare(
      "INSERT INTO resume_tasks (job_id, status, error, queued_at) VALUES (?, 'error', 'LLM timeout', ?)"
    ).run(failed, 111);
    expect(await resumeStatusForJob(db, failed)).toMatchObject({ status: "failed", error: "LLM timeout" });

    // A stale error from an old attempt is superseded by artifacts from a later
    // successful (e.g. manual) generation.
    const recovered = await seed(db, "st-recovered", 0.8);
    await db.prepare(
      "INSERT INTO resume_tasks (job_id, status, error, queued_at) VALUES (?, 'error', 'old boom', ?)"
    ).run(recovered, 111);
    await db.prepare(
      "INSERT INTO resume_artifacts (job_id, format, path, bytes, generated_at) VALUES (?, 'pdf', 'y.pdf', 1, ?)"
    ).run(recovered, 666);
    const r = await resumeStatusForJob(db, recovered);
    expect(r.status).toBe("done");
    expect(r.error).toBeUndefined();
  });
});

describe("threshold decoupling (RESUME_AUTO_THRESHOLD, not the notify bar)", () => {
  it("defaults to config.resume.autoThreshold (0.7) even though NOTIFY_THRESHOLD is higher", async () => {
    const db = createTestDb();
    await setProfile(db, 1, { preferences: { titles: ["Backend Engineer"], keywords: ["java"] } });
    const { id } = await ingestJob(db, 1, {
      source: "linkedin",
      sourceKind: "discovery",
      company: "Acme",
      title: "Backend Engineer",
      url: "https://x/decouple",
      externalId: "decouple",
      description: "java backend",
    });
    // 0.72: below the 0.78 notify bar, above the 0.7 resume bar.
    await setRelevance(db, 1, id, 0.72, "test");

    const res = await enqueueEligibleResumes(db, 1, {
      requireMasterResume: false,
      generateFn: async () => {},
      // NOTE: no threshold override — exercises the config default.
    });
    expect(res.enqueued).toBe(1);
  });
});

describe("daily auto-tailor cap (TAILOR_DAILY_CAP)", () => {
  let db: DB;
  const deps = (): ResumePipelineDeps => ({
    requireMasterResume: false,
    threshold: 0.7,
    generateFn: async () => {},
  });

  beforeEach(async () => {
    db = createTestDb();
    await setProfile(db, 1, { preferences: { titles: ["Backend Engineer"], keywords: ["java"] } });
  });

  it("queues at most `dailyCap` tasks per local day, highest scores first", async () => {
    await seed(db, "a", 0.95);
    await seed(db, "b", 0.9);
    await seed(db, "c", 0.85);
    const res = await enqueueEligibleResumes(db, 1, { ...deps(), dailyCap: 2 });
    expect(res.enqueued).toBe(2);
    expect(res.capped).toBe(1);
    expect(res.skippedReason).toMatch(/daily cap/);
    const queued = (await db
      .prepare("SELECT t.job_id, j.relevance_score AS s FROM resume_tasks t JOIN jobs j ON j.id = t.job_id ORDER BY s DESC")
      .all()) as { s: number }[];
    expect(queued.map((q) => q.s)).toEqual([0.95, 0.9]);
  });

  it("the cap counts what was queued earlier today, and resets on a new local day", async () => {
    await seed(db, "a", 0.95);
    await seed(db, "b", 0.9);
    const first = await enqueueEligibleResumes(db, 1, { ...deps(), dailyCap: 1 });
    expect(first.enqueued).toBe(1);
    const sameDay = await enqueueEligibleResumes(db, 1, { ...deps(), dailyCap: 1 });
    expect(sameDay.enqueued).toBe(0);
    expect(sameDay.capped).toBe(1);
    // Tomorrow the remaining (still fresh) job gets its turn.
    const tomorrow = await enqueueEligibleResumes(db, 1, { ...deps(), dailyCap: 1, now: Date.now() + 24 * H, hours: 48 });
    expect(tomorrow.enqueued).toBe(1);
  });

  it("dailyCap 0 = unlimited", async () => {
    for (let i = 0; i < 5; i++) await seed(db, `j${i}`, 0.8);
    const res = await enqueueEligibleResumes(db, 1, { ...deps(), dailyCap: 0 });
    expect(res.enqueued).toBe(5);
    expect(res.capped).toBeUndefined();
  });
});
