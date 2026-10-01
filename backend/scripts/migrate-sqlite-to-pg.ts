/**
 * One-off data migration: SQLite → PostgreSQL.
 *
 *   npm run migrate:pg -- --source data/jobs.db
 *
 * Safety properties:
 *   • Source opened READ-ONLY — never modified. It remains the rollback artifact.
 *   • Refuses to run when target tables already contain data (idempotence guard);
 *     pass --force to wipe the target and re-copy.
 *   • FK-ordered copy, batched multi-row INSERTs.
 *   • Verifies per-table row counts + jobs checksums + 20 random jobs
 *     field-by-field; exits non-zero on any mismatch.
 *
 * Target from DATABASE_URL (e.g. postgres://jobhunt:pw@127.0.0.1:5432/jobhunt).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

pg.types.setTypeParser(20, Number);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// FK order: referenced tables first (jobs before everything referencing it).
const TABLES = [
  "jobs",
  "companies",
  "profile",
  "applications",
  "keyword_suggestions",
  "poll_runs",
  "discovery_runs",
  "career_watches",
  "referrals",
  "capture_events",
  "page_captures",
  "resume_artifacts",
  "triage_cache",
  "site_adapters",
  "scan_runs",
  "scan_watch_nudge",
  "jd_requirements",
  "resume_tasks",
];

// Identity (autoincrement) key tables need OVERRIDING SYSTEM VALUE to keep ids.
const IDENTITY_TABLES = new Set([
  "companies",
  "keyword_suggestions",
  "poll_runs",
  "discovery_runs",
  "career_watches",
  "capture_events",
  "page_captures",
  "resume_artifacts",
  "scan_runs",
]);

const BATCH = 500;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const sourcePath = arg("source") ?? path.join(__dirname, "..", "data", "jobs.db");
  const force = process.argv.includes("--force");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set — point it at the target Postgres database.");
    process.exit(1);
  }
  if (!fs.existsSync(sourcePath)) {
    console.error(`source not found: ${sourcePath}`);
    process.exit(1);
  }

  console.log(`source (read-only): ${sourcePath}`);
  console.log(`target: ${url.replace(/:[^:@/]+@/, ":***@")}`);

  const src = new Database(sourcePath, { readonly: true });
  const pool = new pg.Pool({ connectionString: url, max: 2 });

  // Apply schema.
  const schema = fs.readFileSync(path.join(__dirname, "..", "src", "db", "schema.pg.sql"), "utf8");
  await pool.query(schema);

  // Guard: refuse a non-empty target unless --force.
  for (const t of TABLES) {
    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM ${t}`);
    if (rows[0].c > 0) {
      if (!force) {
        console.error(`target table ${t} is non-empty (${rows[0].c} rows) — pass --force to wipe and re-copy.`);
        process.exit(1);
      }
    }
  }
  if (force) {
    console.log("--force: truncating target tables…");
    await pool.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  }

  // Copy.
  const missingInSource = new Set<string>();
  for (const t of TABLES) {
    const srcCols = (src.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    if (!srcCols.length) {
      missingInSource.add(t);
      console.log(`  ${t}: not present in source, skipped`);
      continue;
    }
    const { rows: pgColsRows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [t]
    );
    const pgCols = new Set(pgColsRows.map((r: { column_name: string }) => r.column_name));
    const cols = srcCols.filter((c) => pgCols.has(c));
    if (!cols.length) {
      console.log(`  ${t}: no shared columns, skipped`);
      continue;
    }
    const rows = src.prepare(`SELECT ${cols.join(", ")} FROM ${t}`).all() as Record<string, unknown>[];
    const overriding = IDENTITY_TABLES.has(t) ? " OVERRIDING SYSTEM VALUE" : "";
    let copied = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const values: unknown[] = [];
      const tuples = batch
        .map((row, r) => {
          const ph = cols.map((_, c) => `$${r * cols.length + c + 1}`);
          for (const c of cols) values.push(row[c] ?? null);
          return `(${ph.join(",")})`;
        })
        .join(",");
      await pool.query(
        `INSERT INTO ${t} (${cols.join(", ")})${overriding} VALUES ${tuples}`,
        values
      );
      copied += batch.length;
    }
    // Re-sync identity sequences so future inserts don't collide with copied ids.
    if (IDENTITY_TABLES.has(t) && rows.length) {
      await pool.query(
        `SELECT setval(pg_get_serial_sequence('${t}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${t}))`
      );
    }
    console.log(`  ${t}: copied ${copied} rows`);
  }

  // ---- Verification --------------------------------------------------------
  console.log("verifying…");
  let failed = false;

  for (const t of TABLES) {
    if (missingInSource.has(t)) continue;
    const srcCount = (src.prepare(`SELECT count(*) AS c FROM ${t}`).get() as { c: number }).c;
    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM ${t}`);
    const ok = rows[0].c === srcCount;
    if (!ok) failed = true;
    console.log(`  ${ok ? "✓" : "✗"} ${t}: source ${srcCount} → target ${rows[0].c}`);
  }

  const srcSum = src
    .prepare(
      `SELECT count(*) AS n, COALESCE(sum(relevance_score), 0) AS s,
              COALESCE(min(first_seen_at), 0) AS mn, COALESCE(max(first_seen_at), 0) AS mx
       FROM jobs`
    )
    .get() as { n: number; s: number; mn: number; mx: number };
  const { rows: pgSumRows } = await pool.query(
    `SELECT count(*)::int AS n, COALESCE(sum(relevance_score), 0)::float AS s,
            COALESCE(min(first_seen_at), 0) AS mn, COALESCE(max(first_seen_at), 0) AS mx
     FROM jobs`
  );
  const pgSum = pgSumRows[0];
  const sumOk =
    pgSum.n === srcSum.n &&
    Math.abs(pgSum.s - srcSum.s) < 0.001 &&
    pgSum.mn === srcSum.mn &&
    pgSum.mx === srcSum.mx;
  if (!sumOk) failed = true;
  console.log(`  ${sumOk ? "✓" : "✗"} jobs checksums (count/score-sum/min/max first_seen_at)`);

  const sample = src
    .prepare("SELECT * FROM jobs ORDER BY RANDOM() LIMIT 20")
    .all() as Record<string, unknown>[];
  for (const row of sample) {
    const { rows: got } = await pool.query("SELECT * FROM jobs WHERE id = $1", [row.id]);
    const g = got[0];
    if (!g) {
      failed = true;
      console.log(`  ✗ jobs sample ${row.id}: missing in target`);
      continue;
    }
    for (const [k, v] of Object.entries(row)) {
      if (!(k in g)) continue;
      const a = v ?? null;
      const b = g[k] ?? null;
      if (String(a) !== String(b)) {
        failed = true;
        console.log(`  ✗ jobs sample ${row.id}.${k}: '${a}' → '${b}'`);
      }
    }
  }
  if (!failed) console.log("  ✓ 20 random jobs match field-by-field");

  src.close();
  await pool.end();

  if (failed) {
    console.error("VERIFICATION FAILED — do not cut over. Source untouched.");
    process.exit(1);
  }
  console.log("migration verified OK. Set DATABASE_URL in backend/.env and restart the server.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
