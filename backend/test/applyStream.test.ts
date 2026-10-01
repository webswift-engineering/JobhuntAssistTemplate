import { describe, it, expect, beforeEach } from "vitest";
import type { DB } from "../src/db/client.js";
import { createTestDb } from "./helpers.js";
import { ingestJob, setJobState } from "../src/store.js";
import {
  startApplyStream,
  advanceApplyStream,
  endApplyStream,
  currentApplyStream,
  _clearStreams,
} from "../src/applyStream.js";
import type { RawJob } from "../src/types.js";

const H = 3600 * 1000;

function job(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: "greenhouse",
    sourceKind: "ats",
    company: "Acme",
    title: "Backend Engineer",
    url: "https://job-boards.greenhouse.io/acme/jobs/1",
    externalId: "1",
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

describe("apply stream (chained batch apply, ALL jobs)", () => {
  let db: DB;
  beforeEach(async () => {
    db = createTestDb();
    _clearStreams();
  });

  it("includes non-ATS jobs as manual mode; filters fresh + résumé-ready; keeps order", async () => {
    const gh = await ingestJob(db, 1, job({ externalId: "a", url: "https://job-boards.greenhouse.io/acme/jobs/a" }));
    const linkedin = await ingestJob(
      db, 1, job({ source: "linkedin", externalId: "c", url: "https://www.linkedin.com/jobs/view/c" })
    );
    const ashby = await ingestJob(db, 1, job({ externalId: "b", url: "https://jobs.ashbyhq.com/acme/b" }));
    const noResume = await ingestJob(
      db, 1, job({ externalId: "d", url: "https://jobs.lever.co/acme/d" })
    );
    const stale = await ingestJob(
      db, 1, job({ externalId: "e", url: "https://job-boards.greenhouse.io/acme/jobs/e" })
    );
    await db.prepare("UPDATE jobs SET first_seen_at = ?, posted_at = NULL WHERE id = ?")
      .run(Date.now() - 30 * H, stale.id);
    for (const j of [gh, linkedin, ashby, stale]) await makeReady(db, j.id);

    const res = await startApplyStream(db, 1, [gh.id, linkedin.id, ashby.id, noResume.id, stale.id]);
    expect(res.total).toBe(3);
    expect(res.counts).toEqual({ auto: 2, manual: 1 });
    expect(res.first?.id).toBe(gh.id);
    expect(res.first?.mode).toBe("auto");
    expect(res.first?.url).toContain(`#jh-apply=${gh.id}&jh-stream=${res.streamId}&jh-pos=1-3`);
    expect(res.skipped).toEqual([
      { id: noResume.id, reason: "no_resume" },
      { id: stale.id, reason: "stale" },
    ]);

    // Manual-mode job: PLAIN url — no handoff hash (would wake parked easyApply.js).
    const adv = await advanceApplyStream(db, 1, res.streamId!, gh.id);
    expect(adv?.next?.id).toBe(linkedin.id);
    expect(adv?.next?.mode).toBe("manual");
    expect(adv?.next?.url).toBe("https://www.linkedin.com/jobs/view/c");
    expect(adv?.next?.title).toBe("Backend Engineer");
  });

  it("advance is idempotent per position (double-fire cannot skip a job)", async () => {
    const a = await ingestJob(db, 1, job({ externalId: "a", url: "https://job-boards.greenhouse.io/x/jobs/a" }));
    const b = await ingestJob(db, 1, job({ externalId: "b", url: "https://job-boards.greenhouse.io/x/jobs/b" }));
    const c = await ingestJob(db, 1, job({ externalId: "c", url: "https://job-boards.greenhouse.io/x/jobs/c" }));
    for (const j of [a, b, c]) await makeReady(db, j.id);
    const { streamId } = await startApplyStream(db, 1, [a.id, b.id, c.id]);

    const first = await advanceApplyStream(db, 1, streamId!, a.id);
    expect(first?.next?.id).toBe(b.id);
    expect(first?.next?.index).toBe(1);
    const dup = await advanceApplyStream(db, 1, streamId!, a.id);
    expect(dup?.next?.id).toBe(b.id); // did NOT jump to c
    expect(dup?.remaining).toBe(2);
  });

  it("skips jobs applied mid-stream and finishes with done", async () => {
    const a = await ingestJob(db, 1, job({ externalId: "a", url: "https://job-boards.greenhouse.io/x/jobs/a" }));
    const b = await ingestJob(db, 1, job({ externalId: "b", url: "https://job-boards.greenhouse.io/x/jobs/b" }));
    const c = await ingestJob(db, 1, job({ externalId: "c", url: "https://job-boards.greenhouse.io/x/jobs/c" }));
    for (const j of [a, b, c]) await makeReady(db, j.id);
    const { streamId } = await startApplyStream(db, 1, [a.id, b.id, c.id]);

    await setJobState(db, 1, b.id, "applied"); // applied from the dashboard mid-stream
    const adv = await advanceApplyStream(db, 1, streamId!, a.id);
    expect(adv?.next?.id).toBe(c.id);

    const end = await advanceApplyStream(db, 1, streamId!, c.id);
    expect(end).toEqual({ done: true, next: null, total: 3, remaining: 0 });
    expect(await advanceApplyStream(db, 1, streamId!, c.id)).toBeNull();
  });

  it("currentApplyStream attaches the panel to the live stream without moving the cursor", async () => {
    const a = await ingestJob(db, 1, job({ externalId: "a", url: "https://job-boards.greenhouse.io/x/jobs/a" }));
    const li = await ingestJob(
      db, 1, job({ source: "linkedin", externalId: "b", url: "https://www.linkedin.com/jobs/view/b" })
    );
    for (const j of [a, li]) await makeReady(db, j.id);
    const { streamId } = await startApplyStream(db, 1, [a.id, li.id]);

    const cur1 = await currentApplyStream(db, 1);
    expect(cur1?.streamId).toBe(streamId);
    expect(cur1?.current.id).toBe(a.id);
    const cur1again = await currentApplyStream(db, 1);
    expect(cur1again?.current.id).toBe(a.id); // reading twice doesn't advance

    await advanceApplyStream(db, 1, streamId!, a.id);
    const cur2 = await currentApplyStream(db, 1);
    expect(cur2?.current.id).toBe(li.id);
    expect(cur2?.current.mode).toBe("manual");

    expect(await currentApplyStream(db, 2)).toBeNull(); // not this user's stream
    endApplyStream(1, streamId!);
    expect(await currentApplyStream(db, 1)).toBeNull();
  });

  it("end + unknown stream + wrong user all return null/false", async () => {
    const a = await ingestJob(db, 1, job({ externalId: "a", url: "https://job-boards.greenhouse.io/x/jobs/a" }));
    await makeReady(db, a.id);
    const { streamId } = await startApplyStream(db, 1, [a.id]);
    expect(await advanceApplyStream(db, 2, streamId!, a.id)).toBeNull();
    expect(endApplyStream(2, streamId!)).toBe(false);
    expect(endApplyStream(1, streamId!)).toBe(true);
    expect(await advanceApplyStream(db, 1, streamId!, a.id)).toBeNull();
    expect(endApplyStream(1, "nope")).toBe(false);
  });

  it("returns streamId null when nothing is streamable", async () => {
    const noUrl = await ingestJob(db, 1, job({ url: "" as string }));
    const res = await startApplyStream(db, 1, [noUrl.id]);
    expect(res.streamId).toBeNull();
    expect(res.first).toBeNull();
  });
});
