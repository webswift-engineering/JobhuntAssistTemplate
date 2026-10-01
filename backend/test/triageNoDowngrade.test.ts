import { describe, it, expect, beforeEach } from "vitest";
import type { DB } from "../src/db/client.js";
import { createTestDb } from "./helpers.js";
import { ingestJob, setRelevance, getJob, seenStates } from "../src/store.js";
import { dedupKey } from "../src/dedup.js";
import { storedTriageOverride } from "../src/triageStore.js";
import type { RawJob } from "../src/types.js";

// Long enough to clear THIN_JD_CHARS (200) — a "real" JD-based score.
const FULL_JD =
  "We are hiring a backend engineer to build billing APIs in Java and Spring Boot on AWS. " +
  "You will design event-driven microservices with Kafka and Postgres, own reliability, " +
  "and partner with product on payment integrations. 5+ years of experience required.";

const baseJob = (over: Partial<RawJob> = {}): RawJob => ({
  source: "linkedin",
  sourceKind: "discovery",
  company: "Stripe",
  title: "Backend / API Engineer, Billing",
  location: "Remote, Canada",
  url: "https://linkedin.example/jobs/view/4428304478",
  externalId: "4428304478",
  description: FULL_JD,
  ...over,
});

// A title-only re-triage of the same card, as the extension sends it when the
// tiered JD fetcher came up empty (this is what painted "Maybe 30%").
const thinRequest = {
  title: "Backend / API Engineer, Billing",
  company: "Stripe",
  location: "Remote, Canada",
  description: null,
  externalId: "4428304478",
};

describe("stored-score override (no-downgrade on thin re-triage)", () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it("returns the stored JD-based score/verdict/reason with fromStore", async () => {
    const { id } = await ingestJob(db, 1, baseJob());
    await setRelevance(db, 1, id, 0.85, "[strong] Solid backend fit with Java and billing.", {
      method: "triage",
    });

    const r = await storedTriageOverride(db, 1, "linkedin", thinRequest);
    expect(r).not.toBeNull();
    expect(r!.fromStore).toBe(true);
    expect(r!.score).toBe(0.85);
    expect(r!.verdict).toBe("strong");
    expect(r!.reason).toBe("Solid backend fit with Java and billing.");
    expect(r!.disqualifiers).toEqual([]);
  });

  it("derives the verdict from the score when the stored reason has no [verdict] prefix", async () => {
    const { id } = await ingestJob(db, 1, baseJob());
    await setRelevance(db, 1, id, 0.9, "Legacy LLM reason without prefix", { method: "llm" });
    const r = await storedTriageOverride(db, 1, "linkedin", thinRequest);
    expect(r!.verdict).toBe("strong");

    await setRelevance(db, 1, id, 0.4, "Legacy LLM reason without prefix");
    expect((await storedTriageOverride(db, 1, "linkedin", thinRequest))!.verdict).toBe("maybe");

    await setRelevance(db, 1, id, 0.1, "Legacy LLM reason without prefix");
    expect((await storedTriageOverride(db, 1, "linkedin", thinRequest))!.verdict).toBe("weak");
  });

  it("carries a stored disqualified verdict through (score 0 knockouts)", async () => {
    const { id } = await ingestJob(db, 1, baseJob());
    await setRelevance(db, 1, id, 0, "[disqualified] Outside allowed regions", { method: "triage" });
    const r = await storedTriageOverride(db, 1, "linkedin", thinRequest);
    expect(r!.verdict).toBe("disqualified");
    expect(r!.disqualifiers).toEqual(["Outside allowed regions"]);
  });

  it("returns null when the job is not stored", async () => {
    expect(await storedTriageOverride(db, 1, "linkedin", thinRequest)).toBeNull();
  });

  it("returns null when the stored job itself has no real JD (thin score is not authoritative)", async () => {
    const { id } = await ingestJob(db, 1, baseJob({ description: null }));
    await setRelevance(db, 1, id, 0.3, "[maybe] No strong signal; no JD — unverified", {
      method: "triage",
    });
    expect(await storedTriageOverride(db, 1, "linkedin", thinRequest)).toBeNull();
  });

  it("returns null when the stored job was never scored", async () => {
    await ingestJob(db, 1, baseJob());
    expect(await storedTriageOverride(db, 1, "linkedin", thinRequest)).toBeNull();
  });

  it("returns null when the request carries a real JD (fresh JD-based rescore is allowed)", async () => {
    const { id } = await ingestJob(db, 1, baseJob());
    await setRelevance(db, 1, id, 0.85, "[strong] JD-based score", { method: "triage" });
    const r = await storedTriageOverride(db, 1, "linkedin", { ...thinRequest, description: FULL_JD });
    expect(r).toBeNull();
  });

  it("matches by the same key ingest uses, per user", async () => {
    const { id } = await ingestJob(db, 1, baseJob());
    await setRelevance(db, 1, id, 0.85, "[strong] JD-based score", { method: "triage" });

    // Different externalId → different job → no override.
    expect(
      await storedTriageOverride(db, 1, "linkedin", { ...thinRequest, externalId: "999" })
    ).toBeNull();
    // Same card scanned by another user → their queue, not ours → no override.
    expect(await storedTriageOverride(db, 2, "linkedin", thinRequest)).toBeNull();
  });

  it("simulated rescan: the stored 0.85 survives instead of regressing to the 0.3 floor", async () => {
    // Day 1: scan persisted a title-only card at the thin floor…
    const { id } = await ingestJob(db, 1, baseJob({ description: null }));
    await setRelevance(db, 1, id, 0.3, "[maybe] No strong signal from title/company.; no JD — unverified", {
      method: "triage",
    });
    // …then the JD backfill fetched the description and rescored.
    await db.prepare("UPDATE jobs SET description = ? WHERE id = ?").run(FULL_JD, id);
    await setRelevance(db, 1, id, 0.85, "[strong] Solid backend fit.", { method: "triage" });

    // Day 2 rescan (title-only again): the route must take this override path and
    // skip setRelevance, so the stored score stays put and the overlay paints 85%.
    const r = await storedTriageOverride(db, 1, "linkedin", thinRequest);
    expect(r!.score).toBe(0.85);
    expect(r!.fromStore).toBe(true);
    expect((await getJob(db, 1, id))!.relevance_score).toBe(0.85);
  });

  it("seenStates exposes score/reason for the overlay's late repaint", async () => {
    const job = baseJob();
    const { id } = await ingestJob(db, 1, job);
    await setRelevance(db, 1, id, 0.85, "[strong] Solid backend fit.", { method: "triage" });
    const key = dedupKey(job);
    const seen = await seenStates(db, 1, [key]);
    expect(seen[key]).toMatchObject({ id, score: 0.85, reason: "[strong] Solid backend fit." });
  });
});
