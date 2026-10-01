import { describe, it, expect, beforeEach } from "vitest";
import type { DB } from "../src/db/client.js";
import { createTestDb, MockLlm, DisabledLlm } from "./helpers.js";
import { scoreUnscoredJobs } from "../src/scheduler.js";
import { getJob, ingestJob, setProfile, setRelevance, bulkAutoScreen } from "../src/store.js";
import type { RawJob } from "../src/types.js";

const job = (n: string): RawJob => ({
  source: "greenhouse",
  sourceKind: "ats",
  company: "Acme",
  title: `Warehouse Associate ${n}`,
  location: "Toronto, ON",
  url: `https://x/${n}`,
  externalId: n,
  description: "forklift and inventory",
});

describe("auto-screening (machine skips, LLM-scored only)", () => {
  let db: DB;
  beforeEach(async () => {
    db = createTestDb();
    await setProfile(db, 1, { preferences: { titles: ["Backend Engineer"], keywords: ["java"] } });
  });

  it("auto-skips a discovered job when the LLM scores it below the threshold", async () => {
    const { id } = await ingestJob(db, 1, job("low"));
    const llm = new MockLlm().push({ score: 0.1, reason: "wrong discipline" });
    await scoreUnscoredJobs(db, 1, [id], { llm });
    const j = (await getJob(db, 1, id))!;
    expect(j.state).toBe("skipped");
    expect(j.auto_skipped_at).toBeTypeOf("number");
    expect(j.scored_by).toBe("llm");
  });

  it("NEVER auto-skips on a heuristic score (LLM down)", async () => {
    const { id } = await ingestJob(db, 1, job("heur"));
    await scoreUnscoredJobs(db, 1, [id], { llm: new DisabledLlm() });
    const j = (await getJob(db, 1, id))!;
    expect(j.scored_by).toBe("heuristic");
    expect(j.state).toBe("discovered"); // stays visible despite a low score
    expect(j.auto_skipped_at ?? null).toBeNull();
  });

  it("does not auto-skip jobs at or above the threshold", async () => {
    const { id } = await ingestJob(db, 1, job("ok"));
    const llm = new MockLlm().push({ score: 0.55, reason: "plausible stretch" });
    await scoreUnscoredJobs(db, 1, [id], { llm });
    expect((await getJob(db, 1, id))!.state).toBe("discovered");
  });

  it("bulkAutoScreen backfills over already-scored discovered jobs (llm only)", async () => {
    const low = (await ingestJob(db, 1, job("b1"))).id;
    const lowHeur = (await ingestJob(db, 1, job("b2"))).id;
    const high = (await ingestJob(db, 1, job("b3"))).id;
    await setRelevance(db, 1, low, 0.1, "bad", { method: "llm" });
    await setRelevance(db, 1, lowHeur, 0.1, "bad", { method: "heuristic" });
    await setRelevance(db, 1, high, 0.9, "great", { method: "llm" });

    const { skipped } = await bulkAutoScreen(db, 1, 0.3);
    expect(skipped).toBe(1);
    expect((await getJob(db, 1, low))!.state).toBe("skipped");
    expect((await getJob(db, 1, lowHeur))!.state).toBe("discovered");
    expect((await getJob(db, 1, high))!.state).toBe("discovered");
  });
});
