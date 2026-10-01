import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../src/config.js";
import {
  parseSalary,
  classifyWorkplace,
  defaultCurrencyFor,
  belowSalaryFloor,
  floorFor,
} from "../src/salary.js";
import { createTestDb } from "./helpers.js";
import { ingestJob, listJobs } from "../src/store.js";
import type { DB } from "../src/db/client.js";
import type { RawJob } from "../src/types.js";

const CAD = { defaultCurrency: "CAD" as const };
const USD = { defaultCurrency: "USD" as const };

describe("parseSalary", () => {
  it("parses $-ranges with commas", () => {
    const p = parseSalary("Base salary: $130,000 - $160,000 per year", CAD);
    expect(p).toEqual({ minCad: 130000, maxCad: 160000, currency: "CAD" });
  });

  it("parses k-suffix ranges and swaps inverted bounds", () => {
    const p = parseSalary("compensation 160k–120k", CAD);
    expect(p?.minCad).toBe(120000);
    expect(p?.maxCad).toBe(160000);
  });

  it("annualizes hourly rates (2080h)", () => {
    const p = parseSalary("Pay: $60 - $75 per hour", CAD);
    expect(p?.minCad).toBe(60 * 2080);
    expect(p?.maxCad).toBe(75 * 2080);
  });

  it("converts USD to CAD at the fixed rate (default 1.37)", () => {
    const p = parseSalary("salary range USD $100,000 - $120,000", CAD);
    expect(p?.currency).toBe("USD");
    expect(p?.minCad).toBe(137000);
    expect(p?.maxCad).toBe(164400);
  });

  it("bare $ figures use the posting's default currency", () => {
    const cad = parseSalary("salary $140,000", CAD);
    expect(cad?.maxCad).toBe(140000);
    const usd = parseSalary("salary $140,000", USD);
    expect(usd?.maxCad).toBe(Math.round(140000 * 1.37));
  });

  it("ignores numbers with no salary context (JD prose can't become a salary)", () => {
    expect(parseSalary("We process 500,000 transactions daily across 130,000 stores", CAD)).toBeNull();
    expect(parseSalary("Founded in 2015, 250 employees", CAD)).toBeNull();
  });

  it("explicit CA$ marker wins over a USD default", () => {
    const p = parseSalary("total compensation CA$135,000", USD);
    expect(p?.currency).toBe("CAD");
    expect(p?.maxCad).toBe(135000);
  });

  it("returns null for no text / no figures", () => {
    expect(parseSalary(null, CAD)).toBeNull();
    expect(parseSalary("Competitive salary and benefits", CAD)).toBeNull();
  });
});

describe("classifyWorkplace + currency default", () => {
  it("location wins; hybrid beats remote in descriptions", () => {
    expect(classifyWorkplace("Toronto, ON (Hybrid)", "fully remote")).toBe("hybrid");
    expect(classifyWorkplace("Remote - Canada", null)).toBe("remote");
    expect(classifyWorkplace("Toronto, ON (On-site)", null)).toBe("onsite");
    expect(classifyWorkplace("Toronto", "This role is hybrid: 2 days remote")).toBe("hybrid");
    expect(classifyWorkplace("Toronto", "100% remote, work from anywhere")).toBe("remote");
  });

  it("city-anchored postings with no remote signals are office-bound (full bar)", () => {
    expect(classifyWorkplace("Mississauga, ON", "java microservices")).toBe("onsite");
    expect(classifyWorkplace("San Francisco, CA", null)).toBe("onsite");
    // Bare city / country-only = genuinely placeless-ish → unknown (lenient).
    expect(classifyWorkplace("Toronto", "great snacks")).toBe("unknown");
    expect(classifyWorkplace("Canada", null)).toBe("unknown");
    expect(classifyWorkplace(null, "great snacks")).toBe("unknown");
  });

  it("defaultCurrencyFor: Canadian locations → CAD, else USD", () => {
    expect(defaultCurrencyFor("Toronto, ON")).toBe("CAD");
    expect(defaultCurrencyFor("Remote - Canada")).toBe("CAD");
    expect(defaultCurrencyFor("San Francisco, CA")).toBe("USD");
    expect(defaultCurrencyFor(null)).toBe("USD");
  });
});

// Test floors (the shipped defaults are 0 = off).
const FLOOR_HYBRID = 150000;
const FLOOR_REMOTE = 120000;
let savedFloors = { h: 0, r: 0 };
beforeAll(() => {
  savedFloors = { h: config.salary.floorHybridCad, r: config.salary.floorRemoteCad };
  config.salary.floorHybridCad = FLOOR_HYBRID;
  config.salary.floorRemoteCad = FLOOR_REMOTE;
});
afterAll(() => {
  config.salary.floorHybridCad = savedFloors.h;
  config.salary.floorRemoteCad = savedFloors.r;
});

describe("salary floor (configured hybrid/onsite and remote bars, unknowns pass)", () => {
  it("floorFor: strict for office-tied, lenient for remote/unknown", () => {
    expect(floorFor("hybrid")).toBe(FLOOR_HYBRID);
    expect(floorFor("onsite")).toBe(FLOOR_HYBRID);
    expect(floorFor("remote")).toBe(FLOOR_REMOTE);
    expect(floorFor("unknown")).toBe(FLOOR_REMOTE);
  });

  it("belowSalaryFloor: unknown salary always passes", () => {
    expect(belowSalaryFloor({ salary_max_cad: null, workplace: "hybrid" })).toBe(false);
    expect(belowSalaryFloor({ salary_max_cad: 120000, workplace: "hybrid" })).toBe(true);
    expect(belowSalaryFloor({ salary_max_cad: 120000, workplace: "remote" })).toBe(false);
    expect(belowSalaryFloor({ salary_max_cad: 95000, workplace: "remote" })).toBe(true);
    expect(belowSalaryFloor({ salary_max_cad: 155000, workplace: "hybrid" })).toBe(false);
  });
});

describe("ingest stamping + listJobs salaryFloor filter", () => {
  const job = (over: Partial<RawJob> = {}): RawJob => ({
    source: "greenhouse",
    sourceKind: "ats",
    company: "Acme",
    title: "Backend Engineer",
    url: "https://job-boards.greenhouse.io/acme/jobs/1",
    externalId: "1",
    description: "java backend",
    ...over,
  });

  it("stamps salary + workplace at ingest and filters known-below-floor rows", async () => {
    const db: DB = createTestDb();
    const lowHybrid = await ingestJob(db, 1, job({
      externalId: "low",
      url: "https://x/low",
      location: "Toronto, ON (Hybrid)",
      description: "salary $110,000 - $120,000 CAD",
    }));
    const okHybrid = await ingestJob(db, 1, job({
      externalId: "ok",
      url: "https://x/ok",
      location: "Toronto, ON (Hybrid)",
      description: "salary $130,000 - $150,000",
    }));
    const lowRemoteOk = await ingestJob(db, 1, job({
      externalId: "rem",
      url: "https://x/rem",
      location: "Remote - Canada",
      description: "salary $125,000",
    }));
    const unknown = await ingestJob(db, 1, job({
      externalId: "unk",
      url: "https://x/unk",
      location: "Toronto, ON",
      description: "competitive compensation",
    }));

    const all = await listJobs(db, 1, { limit: 50 });
    expect(all).toHaveLength(4);
    const floored = await listJobs(db, 1, { salaryFloor: true, limit: 50 });
    const ids = floored.map((j) => j.id);
    expect(ids).not.toContain(lowHybrid.id); // 120K < hybrid bar
    expect(ids).toContain(okHybrid.id); // 150K max ≥ hybrid bar
    expect(ids).toContain(lowRemoteOk.id); // 125K remote ≥ remote bar
    expect(ids).toContain(unknown.id); // unknown salary passes

    const row = floored.find((j) => j.id === okHybrid.id)!;
    expect(row.workplace).toBe("hybrid");
    expect(row.salary_min_cad).toBe(130000);
    expect(row.salary_max_cad).toBe(150000);
  });
});
