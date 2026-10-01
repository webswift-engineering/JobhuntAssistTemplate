import { describe, it, expect, beforeEach } from "vitest";
import type { DB } from "../src/db/client.js";
import { createTestDb } from "./helpers.js";
import { setProfile, ingestJob, setRelevance } from "../src/store.js";
import { backfillMissingJds, type JdBackfillDeps } from "../src/jdBackfill.js";
import type { MatchFacts } from "../src/profile/matchFacts.js";
import type { LlmClient } from "../src/llm/client.js";
import type { RawJob } from "../src/types.js";

const H = 3600 * 1000;

const facts: MatchFacts = {
  yearsExperience: 7,
  languages: ["java", "typescript"],
  skills: ["java", "spring boot", "aws", "typescript"],
  titles: ["backend engineer", "java developer"],
  dealbreakers: [],
  allowedRegions: ["US", "CA"],
};

const llmOff = { enabled: false, completeJson: async () => { throw new Error("off"); } } as unknown as LlmClient;

const pad = " Responsibilities include designing, building and operating production services.".repeat(3);

function job(externalId: string, overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: "linkedin",
    sourceKind: "discovery",
    company: "Acme",
    title: "Lead Java Developer",
    location: "Toronto, ON",
    url: `https://jobs.example/${externalId}`,
    externalId,
    description: null,
    ...overrides,
  };
}

async function seed(db: DB, externalId: string, overrides: Partial<RawJob> = {}): Promise<string> {
  const { id } = await ingestJob(db, 1, job(externalId, overrides));
  await setRelevance(db, 1, id, 0.55, "[maybe] Matches java; no JD — unverified");
  return id;
}

async function jobRow(db: DB, id: string): Promise<{ description: string | null; relevance_score: number; relevance_reason: string }> {
  return (await db
    .prepare("SELECT description, relevance_score, relevance_reason FROM jobs WHERE id = ?")
    .get(id)) as { description: string | null; relevance_score: number; relevance_reason: string };
}

describe("jd backfill", () => {
  let db: DB;

  beforeEach(async () => {
    db = createTestDb();
    await setProfile(db, 1, { preferences: { allowedRegions: ["US", "CA"] } });
  });

  it("fetches missing JDs, stores them and rescores with the real requirements", async () => {
    const inflated = await seed(db, "inflated");
    const jd = `Requires 7+ years of work experience with Angular, plus React and Vue, and some Java.${pad}`;
    const deps: JdBackfillDeps = {
      llm: llmOff,
      facts,
      fetchFn: async () => ({ extracted: { description: jd } }),
    };

    const res = await backfillMissingJds(db, 1, deps);
    expect(res).toEqual({ candidates: 1, fetched: 1, rescored: 1 });

    const row = await jobRow(db, inflated);
    expect(row.description).toBe(jd);
    expect(row.relevance_score).toBeLessThan(0.55);
    expect(row.relevance_reason).toContain("angular");
    expect(row.relevance_reason).not.toContain("unverified");
  });

  it("can raise a capped score when the real JD is a genuine match", async () => {
    const capped = await seed(db, "match");
    const deps: JdBackfillDeps = {
      llm: llmOff,
      facts,
      fetchFn: async () => ({
        extracted: { description: `We use Java, Spring Boot, AWS and TypeScript daily.${pad}` },
      }),
    };

    await backfillMissingJds(db, 1, deps);
    const row = await jobRow(db, capped);
    expect(row.relevance_score).toBeGreaterThanOrEqual(0.6);
    expect(row.relevance_reason).toContain("[strong]");
  });

  it("leaves jobs untouched when the fetch fails or returns nothing", async () => {
    const stuck = await seed(db, "stuck");
    const deps: JdBackfillDeps = {
      llm: llmOff,
      facts,
      fetchFn: async () => {
        throw new Error("HTTP 429");
      },
    };

    const res = await backfillMissingJds(db, 1, deps);
    expect(res).toEqual({ candidates: 1, fetched: 0, rescored: 0 });

    const row = await jobRow(db, stuck);
    expect(row.description).toBeNull();
    expect(row.relevance_score).toBe(0.55);
  });

  it("skips stale jobs and jobs that already have a description", async () => {
    const stale = await seed(db, "stale");
    const old = Date.now() - 5 * 24 * H;
    await db.prepare("UPDATE jobs SET first_seen_at = ?, posted_at = ? WHERE id = ?").run(old, old, stale);
    await seed(db, "hasjd", { description: `Already captured JD text.${pad}` });

    const calls: string[] = [];
    const deps: JdBackfillDeps = {
      llm: llmOff,
      facts,
      fetchFn: async (url) => {
        calls.push(url);
        return { extracted: { description: null } };
      },
    };

    const res = await backfillMissingJds(db, 1, deps);
    expect(res.candidates).toBe(0);
    expect(calls).toEqual([]);
  });
});
