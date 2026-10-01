import { describe, it, expect, beforeEach } from "vitest";
import type { DB } from "../src/db/client.js";
import { createTestDb } from "./helpers.js";
import { ingestJob, setJobState, getProfile } from "../src/store.js";
import {
  requestPrefill,
  cancelPrefill,
  getPrefill,
  answerPrefill,
  listPrefills,
  nextPrefillWork,
  markPrefillStarted,
  markPrefillReady,
  markPrefillFailed,
  markPrefillClosed,
  prefillStatusForJobs,
  PREFILL_TTL_MS,
  MAX_PARKED,
} from "../src/applyPrefill.js";
import type { RawJob } from "../src/types.js";

const H = 3600 * 1000;
const T0 = Date.UTC(2026, 8, 9, 14, 0, 0); // 10:00 EDT

function job(externalId: string, overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: "greenhouse",
    sourceKind: "ats",
    company: "Acme",
    title: `Backend Engineer ${externalId}`,
    url: `https://job-boards.greenhouse.io/acme/jobs/${externalId}`,
    externalId,
    description: "java backend",
    ...overrides,
  };
}

async function makeReady(db: DB, jobId: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO resume_artifacts (job_id, user_id, format, path, bytes, generated_at) VALUES (?,?,?,?,?,?)"
    )
    .run(jobId, 1, "pdf", `/tmp/${jobId}.pdf`, 1000, Date.now());
}

async function seedReady(db: DB, externalId: string, overrides: Partial<RawJob> = {}): Promise<string> {
  const { id } = await ingestJob(db, 1, job(externalId, overrides));
  await makeReady(db, id);
  return id;
}

describe("prefill-ahead: queueing", () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it("queues an engine-host job with a ready résumé; refuses without one", async () => {
    const ready = await seedReady(db, "a");
    const { id: noResume } = await ingestJob(db, 1, job("b"));
    expect(await requestPrefill(db, 1, ready, T0)).toEqual({ ok: true, status: "queued" });
    expect(await requestPrefill(db, 1, noResume, T0)).toEqual({ ok: false, reason: "no_resume" });
    expect((await requestPrefill(db, 1, "nope", T0)).reason).toBe("not_found");
  });

  it("non-engine hosts get a needs_desktop row so the phone sees why", async () => {
    const li = await seedReady(db, "c", { source: "linkedin", url: "https://www.linkedin.com/jobs/view/c" });
    const res = await requestPrefill(db, 1, li, T0);
    expect(res).toMatchObject({ ok: false, status: "needs_desktop", reason: "unsupported_host" });
    expect((await getPrefill(db, 1, li))?.status).toBe("needs_desktop");
  });

  it("is idempotent while active, and re-queues after a terminal state", async () => {
    const id = await seedReady(db, "d");
    await requestPrefill(db, 1, id, T0);
    expect((await requestPrefill(db, 1, id, T0 + 1000)).reason).toBe("already_active");
    await cancelPrefill(db, 1, id, T0 + 2000);
    expect((await getPrefill(db, 1, id))?.status).toBe("cancelled");
    expect(await requestPrefill(db, 1, id, T0 + 3000)).toEqual({ ok: true, status: "queued" });
  });

  it("applied / skipped jobs cannot be queued", async () => {
    const id = await seedReady(db, "e");
    await setJobState(db, 1, id, "skipped");
    expect((await requestPrefill(db, 1, id, T0)).reason).toBe("not_actionable");
  });
});

describe("prefill-ahead: extension work loop", () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it("hands out one queued job at a time with the prefill hand-off hash, then waits for its report", async () => {
    const a = await seedReady(db, "a");
    const b = await seedReady(db, "b");
    await requestPrefill(db, 1, a, T0);
    await requestPrefill(db, 1, b, T0 + 1);

    const w1 = await nextPrefillWork(db, 1, T0 + 2);
    expect(w1.next?.jobId).toBe(a);
    expect(w1.next?.url).toBe(`https://job-boards.greenhouse.io/acme/jobs/a#jh-apply=${a}&jh-prefill=1`);
    expect((await getPrefill(db, 1, a))?.status).toBe("running");

    // Still running → nothing new is opened.
    await markPrefillStarted(db, 1, a, 101, T0 + 3);
    const w2 = await nextPrefillWork(db, 1, T0 + 4);
    expect(w2.next).toBeNull();

    await markPrefillReady(db, 1, a, {
      fields: [{ label: "First name", value: "Han", source: "engine" }],
      unanswered: ["Years of Java experience"],
      resumeState: "injected",
      drafted: 1,
    }, T0 + 5);
    const w3 = await nextPrefillWork(db, 1, T0 + 6);
    expect(w3.next?.jobId).toBe(b);
    expect(w3.active).toBe(1); // a is parked and ready

    const detail = (await getPrefill(db, 1, a))!;
    expect(detail.status).toBe("ready");
    expect(detail.fields).toHaveLength(1);
    expect(detail.unanswered).toEqual(["Years of Java experience"]);
    expect(detail.tabOpen).toBe(true);
  });

  it("respects the parked-tab cap", async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_PARKED + 1; i++) {
      const id = await seedReady(db, `j${i}`);
      ids.push(id);
      await requestPrefill(db, 1, id, T0 + i);
    }
    for (let i = 0; i < MAX_PARKED; i++) {
      const w = await nextPrefillWork(db, 1, T0 + 100 + i * 10);
      expect(w.next?.jobId).toBe(ids[i]);
      await markPrefillStarted(db, 1, ids[i]!, 200 + i, T0 + 101 + i * 10);
      await markPrefillReady(db, 1, ids[i]!, { fields: [], unanswered: [] }, T0 + 102 + i * 10);
    }
    const full = await nextPrefillWork(db, 1, T0 + 500);
    expect(full.next).toBeNull();
    expect(full.active).toBe(MAX_PARKED);
    expect((await getPrefill(db, 1, ids[MAX_PARKED]!))?.status).toBe("queued");
  });

  it("closes parked tabs when the job is applied or skipped, and marks the row", async () => {
    const a = await seedReady(db, "a");
    const b = await seedReady(db, "b");
    for (const [id, tab] of [[a, 11], [b, 12]] as const) {
      await requestPrefill(db, 1, id, T0);
      await nextPrefillWork(db, 1, T0 + 1);
      await markPrefillStarted(db, 1, id, tab, T0 + 2);
      await markPrefillReady(db, 1, id, { fields: [], unanswered: [] }, T0 + 3);
    }
    await setJobState(db, 1, a, "applied");
    await setJobState(db, 1, b, "skipped");
    const w = await nextPrefillWork(db, 1, T0 + 10);
    expect(w.close.map((c) => [c.jobId, c.tabId, c.reason])).toEqual([
      [a, 11, "applied"],
      [b, 12, "skipped"],
    ]);
    expect((await getPrefill(db, 1, a))?.status).toBe("submitted");
    expect((await getPrefill(db, 1, b))?.status).toBe("cancelled");
    // Ack → slot released, not listed again.
    await markPrefillClosed(db, 1, a);
    await markPrefillClosed(db, 1, b);
    expect((await nextPrefillWork(db, 1, T0 + 11)).close).toEqual([]);
  });

  it("expires parked tabs after the TTL", async () => {
    const a = await seedReady(db, "a");
    await requestPrefill(db, 1, a, T0);
    await nextPrefillWork(db, 1, T0 + 1);
    await markPrefillStarted(db, 1, a, 5, T0 + 2);
    await markPrefillReady(db, 1, a, { fields: [], unanswered: [] }, T0 + 3);
    const w = await nextPrefillWork(db, 1, T0 + PREFILL_TTL_MS + 1000);
    expect(w.close).toEqual([{ jobId: a, tabId: 5, reason: "ttl" }]);
    expect((await getPrefill(db, 1, a))?.status).toBe("expired");
  });

  it("retries a run that never reported once, then gives up", async () => {
    const a = await seedReady(db, "a");
    await requestPrefill(db, 1, a, T0);
    await nextPrefillWork(db, 1, T0 + 1);
    await markPrefillStarted(db, 1, a, 7, T0 + 2);
    // 7 minutes of silence → back to the queue, tab closed
    const w1 = await nextPrefillWork(db, 1, T0 + 7 * 60 * 1000);
    expect(w1.close).toEqual([{ jobId: a, tabId: 7, reason: "retry" }]);
    await markPrefillClosed(db, 1, a);
    const w2 = await nextPrefillWork(db, 1, T0 + 7 * 60 * 1000 + 1);
    expect(w2.next?.jobId).toBe(a); // attempt 2
    await markPrefillStarted(db, 1, a, 8, T0 + 7 * 60 * 1000 + 2);
    const w3 = await nextPrefillWork(db, 1, T0 + 15 * 60 * 1000);
    expect(w3.close).toEqual([{ jobId: a, tabId: 8, reason: "stuck" }]);
    expect((await getPrefill(db, 1, a))?.status).toBe("error");
  });

  it("failed fills become needs_desktop with the reason", async () => {
    const a = await seedReady(db, "a");
    await requestPrefill(db, 1, a, T0);
    await nextPrefillWork(db, 1, T0 + 1);
    await markPrefillFailed(db, 1, a, "no application form found", T0 + 2);
    const d = (await getPrefill(db, 1, a))!;
    expect(d.status).toBe("needs_desktop");
    expect(d.error).toMatch(/no application form/);
  });
});

describe("prefill-ahead: phone answers", () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it("banks the human's answers and asks the parked tab to re-fill", async () => {
    const a = await seedReady(db, "a");
    await requestPrefill(db, 1, a, T0);
    await nextPrefillWork(db, 1, T0 + 1);
    await markPrefillStarted(db, 1, a, 3, T0 + 2);
    await markPrefillReady(db, 1, a, {
      fields: [],
      unanswered: ["Years of Java experience", "Are you legally authorized to work in Canada? (yours to answer)", "Phone"],
    }, T0 + 3);

    const res = await answerPrefill(db, 1, a, {
      "Years of Java experience": "6",
      "Are you legally authorized to work in Canada? (yours to answer)": "Yes",
      Phone: "555-0100", // contact-ish → profile field, never banked
    }, T0 + 4);
    expect(res).toEqual({ banked: 2, refill: true, propagated: 0 });
    const prof = await getProfile(db, 1);
    expect(prof.screeningAnswers["Years of Java experience"]).toBe("6");
    expect(prof.screeningAnswers["Are you legally authorized to work in Canada?"]).toBe("Yes");
    expect(prof.screeningAnswers["Phone"]).toBeUndefined();

    const w = await nextPrefillWork(db, 1, T0 + 5);
    expect(w.refills).toEqual([{ jobId: a, tabId: 3 }]);
    // The re-fill report clears the flag.
    await markPrefillReady(db, 1, a, { fields: [], unanswered: [] }, T0 + 6);
    expect((await nextPrefillWork(db, 1, T0 + 7)).refills).toEqual([]);
  });

  it("re-opens the form when the parked tab is gone", async () => {
    const a = await seedReady(db, "a");
    await requestPrefill(db, 1, a, T0);
    await nextPrefillWork(db, 1, T0 + 1);
    await markPrefillStarted(db, 1, a, 3, T0 + 2);
    await markPrefillReady(db, 1, a, { fields: [], unanswered: ["Q"] }, T0 + 3);
    await markPrefillClosed(db, 1, a, T0 + 4); // Chrome restarted
    await answerPrefill(db, 1, a, { Q: "A" }, T0 + 5);
    const w = await nextPrefillWork(db, 1, T0 + 6);
    expect(w.refills).toEqual([]);
    expect(w.next?.jobId).toBe(a);
  });

  it("lists prefills with job context and exposes per-job badges", async () => {
    const a = await seedReady(db, "a");
    await requestPrefill(db, 1, a, T0);
    await nextPrefillWork(db, 1, T0 + 1);
    await markPrefillStarted(db, 1, a, 3, T0 + 2);
    await markPrefillReady(db, 1, a, { fields: [], unanswered: ["Q1", "Q2"] }, T0 + 3);
    const list = await listPrefills(db, 1);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ jobId: a, status: "ready", title: "Backend Engineer a", company: "Acme" });
    const badges = await prefillStatusForJobs(db, [a, "missing"]);
    expect(badges.get(a)).toMatchObject({ status: "ready", unanswered: 2 });
    expect(badges.get("missing")).toBeUndefined();
  });
});

describe("prefill-ahead: one phone answer clears the question on every parked form", () => {
  it("flags other ready forms that still ask a banked question", async () => {
    const db = createTestDb();
    const ids: string[] = [];
    for (const [ext, open] of [["a", ["Country", "Q-a"]], ["b", ["Country"]], ["c", ["Something else"]]] as const) {
      const id = await seedReady(db, ext);
      ids.push(id);
      await requestPrefill(db, 1, id, T0);
      await nextPrefillWork(db, 1, T0 + 1);
      await markPrefillStarted(db, 1, id, 100 + ids.length, T0 + 2);
      await markPrefillReady(db, 1, id, { fields: [], unanswered: [...open] }, T0 + 3);
    }
    const res = await answerPrefill(db, 1, ids[0]!, { Country: "Canada" }, T0 + 10);
    expect(res).toEqual({ banked: 1, refill: true, propagated: 1 });
    const w = await nextPrefillWork(db, 1, T0 + 11);
    expect(w.refills.map((r) => r.jobId).sort()).toEqual([ids[0], ids[1]].sort());
    expect((await getPrefill(db, 1, ids[2]!))?.refillRequested).toBe(false);
  });
});
