import { describe, it, expect, beforeEach } from "vitest";
import type { DB } from "../src/db/client.js";
import { createTestDb } from "./helpers.js";
import { dedupKey } from "../src/dedup.js";
import {
  ingestJob,
  ingestMany,
  listJobs,
  seenStates,
  setJobState,
  getJob,
  setRelevance,
  markExtensionCaptureJobsApplied,
  listUnscoredJobs,
  setProfile,
  backfillRegionStatus,
  backfillEmploymentType,
  jobFacets,
} from "../src/store.js";
import type { RawJob } from "../src/types.js";
import { InvalidTransitionError } from "../src/state.js";

const baseJob = (over: Partial<RawJob> = {}): RawJob => ({
  source: "greenhouse",
  sourceKind: "ats",
  company: "Acme",
  title: "Engineer",
  location: "NY",
  url: "https://x/1",
  externalId: "1",
  ...over,
});

describe("ingest + dedup (store)", () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it("first ingest is new; second is not (idempotent upsert)", async () => {
    const a = await ingestJob(db, 1, baseJob());
    expect(a.isNew).toBe(true);
    const b = await ingestJob(db, 1, baseJob({ description: "now with description" }));
    expect(b.isNew).toBe(false);
    expect(b.id).toBe(a.id);
    expect((await getJob(db, 1, a.id))!.description).toBe("now with description"); // backfilled
  });

  it("collapses two sources via fuzzy key", async () => {
    const r1 = await ingestJob(db, 1, baseJob({ source: "indeed", externalId: null, company: "Acme, Inc." }));
    const r2 = await ingestJob(db, 1, baseJob({ source: "linkedin", externalId: null, company: "acme inc" }));
    expect(r1.id).toBe(r2.id);
  });

  it("ingestMany returns IngestResult[]", async () => {
    const res = await ingestMany(db, 1, [baseJob({ externalId: "1" }), baseJob({ externalId: "2" })]);
    expect(res).toHaveLength(2);
    expect(res.every((r) => r.isNew)).toBe(true);
  });
});

describe("seen-state / mask (§6.3, §15 cardKey↔dedup_key)", () => {
  it("GET /jobs/seen returns the stored state per key; aligns with parser cardKey", async () => {
    const db = createTestDb();
    const job = baseJob({ externalId: "999" });
    const { id } = await ingestJob(db, 1, job);
    await setJobState(db, 1, id, "applied");

    // The extension computes the SAME dedup key for the same listing.
    const key = dedupKey(job);
    const seen = await seenStates(db, 1, [key, "fuzzy:doesnotexist"]);
    expect(seen[key]).toEqual({ state: "applied", id, score: null, reason: null });
    expect(seen["fuzzy:doesnotexist"]).toBeNull();
  });
});

describe("state transitions via store", () => {
  it("invalid transition throws (→ 409 in API)", async () => {
    const db = createTestDb();
    const { id } = await ingestJob(db, 1, baseJob());
    await setJobState(db, 1, id, "applied");
    await expect(setJobState(db, 1, id, "relevant")).rejects.toThrow(InvalidTransitionError);
  });

  it("applied job leaves the active queue", async () => {
    const db = createTestDb();
    const { id } = await ingestJob(db, 1, baseJob());
    await setJobState(db, 1, id, "applied");
    const active = await listJobs(db, 1, { state: "relevant" });
    expect(active.find((j) => j.id === id)).toBeUndefined();
  });
});

describe("listJobs filters", () => {
  it("excludeZeroScore drops 0-scored jobs but keeps unscored", async () => {
    const db = createTestDb();
    const zero = (await ingestJob(db, 1, baseJob({ externalId: "z" }))).id;
    const low = (await ingestJob(db, 1, baseJob({ externalId: "l", title: "Other" }))).id;
    const unscored = (await ingestJob(db, 1, baseJob({ externalId: "u", title: "Unscored" }))).id;
    await setRelevance(db, 1, zero, 0, "no match");
    await setRelevance(db, 1, low, 0.2, "weak match");

    const all = await listJobs(db, 1, { limit: 50 });
    expect(all.map((j) => j.id)).toEqual(expect.arrayContaining([zero, low, unscored]));

    const filtered = await listJobs(db, 1, { limit: 50, excludeZeroScore: true });
    expect(filtered.map((j) => j.id)).toContain(low);
    expect(filtered.map((j) => j.id)).toContain(unscored);
    expect(filtered.map((j) => j.id)).not.toContain(zero);
  });

  it("freshSince filters at SQL level so a stale high-scored job can't crowd out a fresh one", async () => {
    const db = createTestDb();
    const now = Date.now();
    const freshLow = (await ingestJob(db, 1, baseJob({ externalId: "fresh", postedAt: now - 3600 * 1000 }))).id;
    const staleHigh = (
      await ingestJob(
        db,
        1,
        baseJob({ externalId: "stale", title: "Old High", postedAt: now - 72 * 3600 * 1000 })
      )
    ).id;
    await setRelevance(db, 1, freshLow, 0.5, "fresh");
    await setRelevance(db, 1, staleHigh, 1.0, "stale but high");

    // Sort by score with limit 1: without SQL-level freshness the stale 1.0 would win.
    // With freshSince, the stale row is excluded before sort+limit, so the fresh row survives.
    const rows = await listJobs(db, 1, { sort: "score", freshSince: now - 24 * 3600 * 1000, limit: 1 });
    expect(rows.map((j) => j.id)).toEqual([freshLow]);
  });

  it("markExtensionCaptureJobsApplied marks extension rows applied (bulk admin override)", async () => {
    const db = createTestDb();
    const ext = (await ingestJob(db, 1, baseJob({ externalId: "ext", source: "indeed", sourceKind: "extension" }))).id;
    const ats = (await ingestJob(db, 1, baseJob({ externalId: "ats" }))).id;
    await setJobState(db, 1, ext, "skipped");

    const updated = await markExtensionCaptureJobsApplied(db, 1);
    expect(updated).toBe(1);
    expect((await getJob(db, 1, ext))!.state).toBe("applied");
    expect((await getJob(db, 1, ats))!.state).toBe("discovered");
  });

  it("listUnscoredJobs filters fresh in-region unscored rows", async () => {
    const db = createTestDb();
    const recent = Date.now() - 60 * 60 * 1000;
    const us = (
      await ingestJob(
        db,
        1,
        baseJob({
          externalId: "us-new",
          location: "San Francisco, CA",
          postedAt: recent,
        })
      )
    ).id;
    await ingestJob(
      db,
      1,
      baseJob({
        externalId: "uk-new",
        location: "London, UK",
        postedAt: recent,
      })
    );
    await ingestJob(
      db,
      1,
      baseJob({
        externalId: "us-old",
        location: "Austin, TX",
        postedAt: Date.now() - 48 * 60 * 60 * 1000,
      })
    );
    await setProfile(db, 1, { preferences: { allowedRegions: ["US", "CA"] } });

    const pending = await listUnscoredJobs(db, 1, { freshOnly: true, inRegionOnly: true });
    expect(pending.map((j) => j.id)).toEqual([us]);
  });
});

describe("region_status (stamped at write time, filtered in SQL)", () => {
  it("ingest stamps region_status; listJobs inRegionOnly drops 'out' but keeps unknown", async () => {
    const db = createTestDb();
    const us = (await ingestJob(db, 1, baseJob({ externalId: "us", location: "Toronto, ON" }))).id;
    const uk = (await ingestJob(db, 1, baseJob({ externalId: "uk", location: "London, UK" }))).id;
    expect((await getJob(db, 1, us))!.region_status).toBe("in");
    expect((await getJob(db, 1, uk))!.region_status).toBe("out");

    // Simulate a legacy row that predates the column (never stamped).
    const legacy = (await ingestJob(db, 1, baseJob({ externalId: "legacy", location: "Berlin, Germany" }))).id;
    await db.prepare("UPDATE jobs SET region_status = NULL WHERE id = ?").run(legacy);

    const ids = (await listJobs(db, 1, { inRegionOnly: true, limit: 50 })).map((j) => j.id);
    expect(ids).toContain(us);
    expect(ids).not.toContain(uk);
    expect(ids).toContain(legacy); // unknown stays visible until stamped

    expect(await backfillRegionStatus(db, 1)).toEqual({ updated: 1 });
    const after = (await listJobs(db, 1, { inRegionOnly: true, limit: 50 })).map((j) => j.id);
    expect(after).not.toContain(legacy);
  });

  it("a later capture with a location re-stamps the region verdict", async () => {
    const db = createTestDb();
    const { id } = await ingestJob(db, 1, baseJob({ externalId: "r", location: null }));
    expect((await getJob(db, 1, id))!.region_status).toBe("in"); // unknown location → allowed
    await ingestJob(db, 1, baseJob({ externalId: "r", location: "Bangalore, India" }));
    expect((await getJob(db, 1, id))!.region_status).toBe("out");
  });

  it("setRelevance can stamp region_status alongside the score", async () => {
    const db = createTestDb();
    const { id } = await ingestJob(db, 1, baseJob({ externalId: "s" }));
    await setRelevance(db, 1, id, 0.8, "good", { regionStatus: "out" });
    const job = (await getJob(db, 1, id))!;
    expect(job.relevance_score).toBe(0.8);
    expect(job.region_status).toBe("out");
  });
});

describe("posting-URL canonicalization at ingest (no read-path repair)", () => {
  it("greenhouse boards.greenhouse.io URLs are rewritten before insert", async () => {
    const db = createTestDb();
    const { id } = await ingestJob(
      db,
      1,
      baseJob({ externalId: "gh", url: "https://boards.greenhouse.io/acme/jobs/123" })
    );
    expect((await getJob(db, 1, id))!.url).toBe("https://job-boards.greenhouse.io/acme/jobs/123");
  });
});

describe("employment_type (classified at ingest, filtered/faceted in SQL)", () => {
  it("ingest classifies from text; structured field wins on later captures", async () => {
    const db = createTestDb();
    const plain = (await ingestJob(db, 1, baseJob({ externalId: "e1" }))).id;
    expect((await getJob(db, 1, plain))!.employment_type).toBe("unknown");

    const contract = (
      await ingestJob(db, 1, baseJob({ externalId: "e2", title: "Java Developer (6 Month Contract)" }))
    ).id;
    expect((await getJob(db, 1, contract))!.employment_type).toBe("contract");

    // A later capture with a structured field upgrades 'unknown'…
    await ingestJob(db, 1, baseJob({ externalId: "e1", employmentType: "FULLTIME" }));
    expect((await getJob(db, 1, plain))!.employment_type).toBe("full_time");
    // …and a later text-only capture never downgrades a structured verdict.
    await ingestJob(db, 1, baseJob({ externalId: "e1", description: "no signal here" }));
    expect((await getJob(db, 1, plain))!.employment_type).toBe("full_time");
  });

  it("listJobs employmentType filter: 'unknown' matches NULL legacy rows too", async () => {
    const db = createTestDb();
    const ft = (await ingestJob(db, 1, baseJob({ externalId: "f", employmentType: "FULLTIME" }))).id;
    const un = (await ingestJob(db, 1, baseJob({ externalId: "u" }))).id;
    const legacy = (await ingestJob(db, 1, baseJob({ externalId: "l" }))).id;
    await db.prepare("UPDATE jobs SET employment_type = NULL WHERE id = ?").run(legacy);

    const fts = (await listJobs(db, 1, { employmentType: "full_time", limit: 50 })).map((j) => j.id);
    expect(fts).toEqual([ft]);
    const unknowns = (await listJobs(db, 1, { employmentType: "unknown", limit: 50 })).map((j) => j.id);
    expect(unknowns).toContain(un);
    expect(unknowns).toContain(legacy);
  });

  it("jobFacets exposes employmentTypes with NULL folded into 'unknown'", async () => {
    const db = createTestDb();
    await ingestJob(db, 1, baseJob({ externalId: "f", employmentType: "FULLTIME" }));
    const legacy = (await ingestJob(db, 1, baseJob({ externalId: "l" }))).id;
    await db.prepare("UPDATE jobs SET employment_type = NULL WHERE id = ?").run(legacy);

    const facets = await jobFacets(db, 1);
    const byValue = Object.fromEntries(facets.employmentTypes.map((f) => [f.value, f.count]));
    expect(byValue["full_time"]).toBe(1);
    expect(byValue["unknown"]).toBe(1);
  });

  it("backfillEmploymentType classifies NULL rows and reports counts", async () => {
    const db = createTestDb();
    const a = (await ingestJob(db, 1, baseJob({ externalId: "a", title: "Java Contractor" }))).id;
    const b = (await ingestJob(db, 1, baseJob({ externalId: "b" }))).id;
    await db.prepare("UPDATE jobs SET employment_type = NULL WHERE id IN (?, ?)").run(a, b);

    const res = await backfillEmploymentType(db, 1);
    expect(res.updated).toBe(2);
    expect(res.counts).toMatchObject({ contract: 1, unknown: 1 });
    expect((await getJob(db, 1, a))!.employment_type).toBe("contract");
  });
});
