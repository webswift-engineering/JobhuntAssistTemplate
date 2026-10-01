import { describe, it, expect, beforeEach } from "vitest";
import type { DB } from "../src/db/client.js";
import { createTestDb } from "./helpers.js";
import { addCompany } from "../src/store.js";
import { recoverDisabledBoards, type CompanyHealthRow } from "../src/companyHealth.js";
import { heuristicBoardCandidates } from "../src/llm/suggestBoardTokens.js";
import type { LlmClient } from "../src/llm/client.js";
import type { CompanyRow } from "../src/types.js";

const llmOff = { enabled: false } as LlmClient;

async function disable(db: DB, id: number, reason: string): Promise<void> {
  await db
    .prepare("UPDATE companies SET enabled = 0, auto_disabled_at = ?, auto_disabled_reason = ? WHERE id = ?")
    .run(Date.now(), reason, id);
}

const company = async (db: DB, name: string, ats: string, token: string): Promise<number> => {
  const c = await addCompany(db, 1, { name, ats: ats as "lever", boardToken: token });
  return (c as { id: number }).id;
};

describe("recoverDisabledBoards (alert-banner recovery)", () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it("re-enables a board whose transient outage healed", async () => {
    const id = await company(db, "Acme", "lever", "acme");
    await disable(db, id, "HTTP 404");
    const probe = async (_c: CompanyRow) => ({ jobCount: 12, status: "active" as const });
    const res = await recoverDisabledBoards(db, 1, llmOff, { probe });
    expect(res).toEqual([{ name: "Acme", outcome: "reenabled", ats: "lever", boardToken: "acme" }]);
    const row = (await db.prepare("SELECT * FROM companies WHERE id = ?").get(id)) as CompanyHealthRow;
    expect(row.enabled).toBe(1);
    expect(row.auto_disabled_at).toBeNull();
    expect(row.consecutive_failures).toBe(0);
  });

  it("switches to a candidate board only when it answers with live jobs", async () => {
    const id = await company(db, "Netflix", "lever", "netflix");
    await disable(db, id, "HTTP 404 for lever");
    // Old board dead; the greenhouse candidate slug is alive.
    const probe = async (c: CompanyRow) =>
      c.ats === "greenhouse" && c.board_token === "netflix"
        ? { jobCount: 7, status: "active" as const }
        : { jobCount: 0, status: "error" as const, error: "HTTP 404" };
    const res = await recoverDisabledBoards(db, 1, llmOff, { probe });
    expect(res).toEqual([
      { name: "Netflix", outcome: "switched", ats: "greenhouse", boardToken: "netflix" },
    ]);
    const row = (await db.prepare("SELECT * FROM companies WHERE id = ?").get(id)) as CompanyHealthRow;
    expect(row.ats).toBe("greenhouse");
    expect(row.board_token).toBe("netflix");
    expect(row.enabled).toBe(1);
    expect(row.auto_disabled_at).toBeNull();
  });

  it("never switches onto an EMPTY candidate board (could be someone else's slug)", async () => {
    const id = await company(db, "Acme", "lever", "acme");
    await disable(db, id, "HTTP 404");
    const probe = async (c: CompanyRow) =>
      c.id === id && c.ats === "lever" && c.board_token === "acme"
        ? { jobCount: 0, status: "error" as const, error: "HTTP 404" }
        : { jobCount: 0, status: "empty" as const };
    const res = await recoverDisabledBoards(db, 1, llmOff, { probe });
    expect(res[0]!.outcome).toBe("still_broken");
    expect(res[0]!.tried).toBeGreaterThan(0);
    const row = (await db.prepare("SELECT * FROM companies WHERE id = ?").get(id)) as CompanyHealthRow;
    expect(row.enabled).toBe(0);
    expect(row.ats).toBe("lever"); // unchanged
  });

  it("heuristicBoardCandidates: slug variants across the three ATSes", () => {
    const c = heuristicBoardCandidates("Sun Life Financial");
    expect(c).toContainEqual({ ats: "greenhouse", boardToken: "sunlifefinancial" });
    expect(c).toContainEqual({ ats: "lever", boardToken: "sun-life-financial" });
    expect(c.length).toBe(6); // 2 slugs × 3 ATSes
  });

  it("no disabled boards → empty result", async () => {
    await company(db, "Fine Co", "lever", "fine");
    const probe = async () => ({ jobCount: 1, status: "active" as const });
    expect(await recoverDisabledBoards(db, 1, llmOff, { probe })).toEqual([]);
  });
});
