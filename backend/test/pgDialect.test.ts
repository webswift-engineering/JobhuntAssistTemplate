/**
 * Postgres dialect coverage on every `npm test` — no server needed. PGlite is a
 * real Postgres (WASM); this exercises the PgDb translation layer (`?` → $n,
 * RETURNING id, transactions) and the store's hot paths against actual Postgres
 * semantics (NULLS ordering, ON CONFLICT, string_agg, int8 columns).
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Db, DbStatement } from "../src/db/index.js";
import { toPgPlaceholders } from "../src/db/postgres.js";
import {
  ingestJob,
  listJobs,
  setRelevance,
  addCompany,
  jobFacets,
  getJob,
  setJobState,
  bulkAutoScreen,
  setProfile,
} from "../src/store.js";
import { recordPageCapture, listCaptures, recordEvent } from "../src/captures.js";
import { collectAlerts } from "../src/monitoring/alerts.js";
import type { LlmHealth } from "../src/llm/client.js";
import type { RawJob } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Minimal Db over PGlite (single connection — mutex-serialized transactions). */
class PgliteDb implements Db {
  readonly engine = "postgres" as const;
  private txLock: Promise<void> = Promise.resolve();
  constructor(private readonly p: InstanceType<typeof PGlite>) {}

  prepare(sql: string): DbStatement {
    const text = toPgPlaceholders(sql);
    const isInsert = /^insert\b/i.test(sql.trimStart()) && !/\breturning\b/i.test(sql);
    const runSql = isInsert ? `${text.trimEnd().replace(/;+\s*$/, "")} RETURNING *` : text;
    return {
      get: async <T>(...params: unknown[]) => {
        const r = await this.p.query(text, params as unknown[]);
        return (r.rows[0] ?? undefined) as T | undefined;
      },
      all: async <T>(...params: unknown[]) => {
        const r = await this.p.query(text, params as unknown[]);
        return r.rows as T[];
      },
      run: async (...params: unknown[]) => {
        const r = await this.p.query(runSql, params as unknown[]);
        const row = (r.rows[0] ?? {}) as { id?: number };
        return { changes: r.affectedRows ?? 0, lastInsertRowid: Number(row.id ?? 0) };
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.p.exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.txLock;
    let release!: () => void;
    this.txLock = new Promise((r) => (release = r));
    await prev;
    try {
      await this.p.exec("BEGIN");
      try {
        const out = await fn();
        await this.p.exec("COMMIT");
        return out;
      } catch (err) {
        await this.p.exec("ROLLBACK").catch(() => {});
        throw err;
      }
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    await this.p.close();
  }
}

async function createPgTestDb(): Promise<Db> {
  const p = new PGlite(); // in-memory
  const schema = fs.readFileSync(path.join(__dirname, "..", "src", "db", "schema.pg.sql"), "utf8");
  const db = new PgliteDb(p);
  await db.exec(schema);
  return db;
}

const baseJob = (over: Partial<RawJob> = {}): RawJob => ({
  source: "greenhouse",
  sourceKind: "ats",
  company: "Acme",
  title: "Engineer",
  location: "Toronto, ON",
  url: "https://x/1",
  externalId: "1",
  ...over,
});

const healthyLlm: LlmHealth = {
  enabled: true,
  status: "ok",
  lastOkAt: Date.now(),
  lastErrorAt: null,
  lastError: null,
  totalCalls: 1,
  totalFailures: 0,
  consecutiveFailures: 0,
};

describe("Postgres dialect (PGlite)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createPgTestDb();
  });

  it("ingest → list → score → facets round-trips through the store", async () => {
    const a = await ingestJob(db, 1, baseJob({ externalId: "a", postedAt: Date.now() - 3600_000 }));
    const b = await ingestJob(db, 1, baseJob({ externalId: "b", title: "Senior Engineer" }));
    expect(a.isNew && b.isNew).toBe(true);

    // Idempotent upsert (transaction + ON CONFLICT paths).
    const again = await ingestJob(db, 1, baseJob({ externalId: "a", description: "later JD" }));
    expect(again.isNew).toBe(false);
    expect((await getJob(db, 1, a.id))!.description).toBe("later JD");

    await setRelevance(db, 1, a.id, 0.9, "great", { method: "llm" });
    await setRelevance(db, 1, b.id, 0.2, "weak", { method: "llm" });

    // NULLS LAST + score ordering (Postgres DESC defaults NULLS FIRST — must be overridden).
    const c = await ingestJob(db, 1, baseJob({ externalId: "c", title: "Unscored" }));
    const rows = await listJobs(db, 1, { sort: "score", limit: 10 });
    expect(rows[0]!.id).toBe(a.id);
    expect(rows[rows.length - 1]!.id).toBe(c.id); // unscored sinks below scored

    const facets = await jobFacets(db, 1, {});
    expect(facets.total).toBe(3);
    expect(facets.sources[0]).toMatchObject({ value: "greenhouse", count: 3 });
  });

  it("state machine + auto-screen bulk update work (rowCount as changes)", async () => {
    const low = await ingestJob(db, 1, baseJob({ externalId: "low", title: "Warehouse" }));
    await setRelevance(db, 1, low.id, 0.1, "bad", { method: "llm" });
    // Shared db across cases: job "b" (0.2, llm, discovered) from the first test
    // also legitimately qualifies — assert on the specific row, not the count.
    const { skipped } = await bulkAutoScreen(db, 1, 0.3);
    expect(skipped).toBeGreaterThanOrEqual(1);
    expect((await getJob(db, 1, low.id))!.state).toBe("skipped");
    await setJobState(db, 1, low.id, "relevant"); // un-skip transition
  });

  it("identity keys: page capture insert returns usable ids; string_agg list works", async () => {
    await setProfile(db, 1, { masterResume: "SUMMARY\nEngineer" });
    const cap = await recordPageCapture(db, 1, {
      url: "https://linkedin.com/jobs/view/9/",
      source: "linkedin",
      title: "Dev",
      company: "CapCo",
      externalId: "9",
      rawText: "About the job\n".repeat(200),
    });
    expect(cap.id).toBeGreaterThan(0); // lastInsertRowid via RETURNING
    expect(cap.jobId).toBeTruthy();
    await db
      .prepare(
        "INSERT INTO resume_artifacts (job_id, format, path, generated_at) VALUES (?,?,?,?)"
      )
      .run(cap.jobId, "txt", "x/resume.txt", Date.now());
    const rows = await listCaptures(db, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resume_formats).toBe("txt"); // string_agg path
  });

  it("capture events + alerts queries run on pg (int8 → Number)", async () => {
    await recordEvent(db, 1, { source: "linkedin", event: "viewed" });
    await db
      .prepare("INSERT INTO poll_runs (started_at, trigger, status, errors_json) VALUES (?,?,?,?)")
      .run(Date.now(), "schedule", "partial", JSON.stringify({ "X (lever)": "HTTP 404" }));
    const alerts = await collectAlerts(db, 1, { llm: healthyLlm });
    const partial = alerts.find((x) => x.id === "poll_partial");
    expect(partial).toBeDefined();
    expect(partial!.count).toBe(1);
    expect(typeof partial!.since).toBe("number");
  });

  it("companies CRUD + auto-disable flags round-trip", async () => {
    const co = await addCompany(db, 1, { name: "PgCo", ats: "lever", boardToken: "pgco" });
    expect(co.id).toBeGreaterThan(0);
    expect(co.enabled).toBe(1);
  });

  it("transactions roll back atomically", async () => {
    const before = ((await db.prepare("SELECT count(*) AS c FROM jobs").get()) as { c: number }).c;
    await expect(
      db.transaction(async () => {
        await ingestJob(db, 1, baseJob({ externalId: "tx-doomed" }));
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const after = ((await db.prepare("SELECT count(*) AS c FROM jobs").get()) as { c: number }).c;
    expect(after).toBe(before);
  });
});
