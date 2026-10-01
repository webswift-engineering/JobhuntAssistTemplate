import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers.js";
import { collectAlerts, scoringMethodStats } from "../src/monitoring/alerts.js";
import type { LlmHealth } from "../src/llm/client.js";
import { ingestJob, setRelevance, addCompany } from "../src/store.js";
import { autoDisableBrokenCompanies } from "../src/companyHealth.js";
import type { RawJob } from "../src/types.js";

const healthyLlm: LlmHealth = {
  enabled: true,
  status: "ok",
  lastOkAt: Date.now(),
  lastErrorAt: null,
  lastError: null,
  totalCalls: 10,
  totalFailures: 0,
  consecutiveFailures: 0,
};

const job = (n: string): RawJob => ({
  source: "greenhouse",
  sourceKind: "ats",
  company: "Acme",
  title: `Engineer ${n}`,
  location: "Toronto, ON",
  url: `https://x/${n}`,
  externalId: n,
});

describe("collectAlerts", () => {
  it("is empty on a healthy system", async () => {
    const db = createTestDb();
    expect(await collectAlerts(db, 1, { llm: healthyLlm })).toEqual([]);
  });

  it("raises llm_down after 3 consecutive failures", async () => {
    const db = createTestDb();
    const down: LlmHealth = {
      ...healthyLlm,
      status: "error",
      consecutiveFailures: 4,
      lastErrorAt: 123,
      lastError: "LLM HTTP 500: boom",
    };
    const alerts = await collectAlerts(db, 1, { llm: down });
    const alert = alerts.find((a) => a.id === "llm_down");
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("error");
    expect(alert!.detail).toContain("boom");
    expect(alert!.since).toBe(123);
  });

  it("raises llm_fallback when jobs were heuristic-scored in the last 24h", async () => {
    const db = createTestDb();
    const a = (await ingestJob(db, 1, job("h1"))).id;
    const b = (await ingestJob(db, 1, job("h2"))).id;
    const c = (await ingestJob(db, 1, job("l1"))).id;
    await setRelevance(db, 1, a, 0.4, "kw", { method: "heuristic" });
    await setRelevance(db, 1, b, 0.5, "kw", { method: "heuristic" });
    await setRelevance(db, 1, c, 0.8, "good", { method: "llm" });

    const alerts = await collectAlerts(db, 1, { llm: healthyLlm });
    const alert = alerts.find((a2) => a2.id === "llm_fallback");
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("warn");
    expect(alert!.count).toBe(2);

    const stats = await scoringMethodStats(db, 1, Date.now() - 3600 * 1000);
    expect(stats).toEqual({ llm: 1, heuristic: 2, region: 0, triage: 0 });
  });

  it("raises poll_partial with board error details from the last completed run", async () => {
    const db = createTestDb();
    await db.prepare(
      `INSERT INTO poll_runs (started_at, trigger, status, errors_json)
       VALUES (?, 'schedule', 'partial', ?)`
    ).run(Date.now(), JSON.stringify({ "BadCo (lever)": "HTTP 404" }));
    const alerts = await collectAlerts(db, 1, { llm: healthyLlm });
    const alert = alerts.find((a) => a.id === "poll_partial");
    expect(alert).toBeDefined();
    expect(alert!.detail).toContain("BadCo (lever): HTTP 404");
    expect(alert!.count).toBe(1);
  });

  it("ignores a 'running' poll row when deciding poll health", async () => {
    const db = createTestDb();
    await db.prepare(
      "INSERT INTO poll_runs (started_at, trigger, status) VALUES (?, 'schedule', 'success')"
    ).run(Date.now() - 1000);
    await db.prepare(
      "INSERT INTO poll_runs (started_at, trigger, status) VALUES (?, 'manual', 'running')"
    ).run(Date.now());
    expect(await collectAlerts(db, 1, { llm: healthyLlm })).toEqual([]);
  });

  it("raises resume_failures for errored tasks in the last 24h", async () => {
    const db = createTestDb();
    const id = (await ingestJob(db, 1, job("r1"))).id;
    await db.prepare(
      `INSERT INTO resume_tasks (job_id, status, error, queued_at, finished_at)
       VALUES (?, 'error', 'PDF render exploded', ?, ?)`
    ).run(id, Date.now() - 5000, Date.now() - 1000);
    const alerts = await collectAlerts(db, 1, { llm: healthyLlm });
    const alert = alerts.find((a) => a.id === "resume_failures");
    expect(alert).toBeDefined();
    expect(alert!.detail).toBe("PDF render exploded");
  });

  it("raises boards_disabled after auto-disable, and clears when re-enabled", async () => {
    const db = createTestDb();
    const co = await addCompany(db, 1, { name: "BadCo", ats: "lever", boardToken: "badco" });
    await autoDisableBrokenCompanies(db, [co], {
      "BadCo (lever)": "HTTP 404 for https://api.lever.co/v0/postings/badco?mode=json",
    });
    const alerts = await collectAlerts(db, 1, { llm: healthyLlm });
    const alert = alerts.find((a) => a.id === "boards_disabled");
    expect(alert).toBeDefined();
    expect(alert!.detail).toContain("BadCo");

    const { setCompanyEnabled } = await import("../src/store.js");
    await setCompanyEnabled(db, 1, co.id, true);
    expect(await collectAlerts(db, 1, { llm: healthyLlm })).toEqual([]);
  });

  it("raises scan_watch_stalled when the last report is 8h+ old but within 7 days", async () => {
    const db = createTestDb();
    const now = Date.now();
    await db.prepare(
      "INSERT INTO scan_runs (source, scanned, reported_at) VALUES ('linkedin-auto', 20, ?)"
    ).run(now - 10 * 3600 * 1000);
    const alerts = await collectAlerts(db, 1, { llm: healthyLlm, now });
    expect(alerts.find((a) => a.id === "scan_watch_stalled")).toBeDefined();

    // Ancient report (watch not expected any more) → no alert.
    await db.prepare("UPDATE scan_runs SET reported_at = ?").run(now - 8 * 24 * 3600 * 1000);
    expect(await collectAlerts(db, 1, { llm: healthyLlm, now })).toEqual([]);
  });
});
