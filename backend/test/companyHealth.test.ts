import { describe, it, expect, beforeEach } from "vitest";
import type { DB } from "../src/db/client.js";
import { createTestDb } from "./helpers.js";
import {
  autoDisableBrokenCompanies,
  isPermanentBoardError,
} from "../src/companyHealth.js";

describe("companyHealth auto-disable", () => {
  let db: DB;

  beforeEach(async () => {
    db = createTestDb();
    await db.prepare(
      `INSERT INTO companies (name, ats, board_token, enabled) VALUES (?,?,?,1)`
    ).run("BadCo", "lever", "badco");
    await db.prepare(
      `INSERT INTO companies (name, ats, board_token, enabled) VALUES (?,?,?,1)`
    ).run("FlakyCo", "greenhouse", "flaky");
  });

  it("detects permanent HTTP board errors", () => {
    expect(isPermanentBoardError("HTTP 404 for https://x")).toBe(true);
    expect(isPermanentBoardError("HTTP 401 for https://x")).toBe(true);
    expect(isPermanentBoardError("This operation was aborted")).toBe(false);
  });

  it("auto-disables companies with permanent errors", async () => {
    const companies = (await db.prepare("SELECT * FROM companies").all()) as Array<{
      id: number;
      name: string;
      ats: string;
      board_token: string;
      enabled: number;
    }>;
    const disabled = await autoDisableBrokenCompanies(db, companies, {
      "BadCo (lever)": "HTTP 404 for https://api.lever.co/v0/postings/badco?mode=json",
      "FlakyCo (greenhouse)": "This operation was aborted",
    });
    expect(disabled).toEqual(["BadCo"]);
    const bad = (await db.prepare("SELECT enabled FROM companies WHERE name = 'BadCo'").get()) as {
      enabled: number;
    };
    const flaky = (await db.prepare("SELECT enabled FROM companies WHERE name = 'FlakyCo'").get()) as {
      enabled: number;
    };
    expect(bad.enabled).toBe(0);
    expect(flaky.enabled).toBe(1);
  });
});
