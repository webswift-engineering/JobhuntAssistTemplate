import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";
import type { Db } from "./index.js";
import { SqliteDb } from "./sqlite.js";
import { PgDb } from "./postgres.js";

/** Engine-agnostic handle used across the app (see db/index.ts). */
export type DB = Db;

let _db: DB | null = null;

/**
 * Open the database. DATABASE_URL set → PostgreSQL (call ensurePgSchema() at
 * startup); else → SQLite at config.dbPath (schema applied synchronously here).
 * Unsetting DATABASE_URL is the rollback path back to the SQLite file.
 */
export function getDb(): DB {
  if (_db) return _db;
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    _db = openPgDb(url);
  } else {
    _db = openDb(config.dbPath);
  }
  return _db;
}

function openPgDb(url: string): DB {
  return new PgDb(new pg.Pool({ connectionString: url, max: 5 }));
}

/** Apply the Postgres schema (idempotent). Call once at startup when on pg. */
export async function ensurePgSchema(db: DB): Promise<void> {
  if (db.engine !== "postgres") return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schema = fs.readFileSync(path.join(here, "schema.pg.sql"), "utf8");
  await db.exec(schema);
}

export function openDb(dbPath: string): DB {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  const schema = fs.readFileSync(config.schemaPath, "utf8");
  raw.exec(schema);
  migrate(raw);
  return new SqliteDb(raw);
}

/** Add columns introduced after first deploy (SQLite has no IF NOT EXISTS for columns). */
function migrate(db: Database.Database): void {
  const alters: string[] = [
    "ALTER TABLE jobs ADD COLUMN salary_text TEXT",
    "ALTER TABLE page_captures ADD COLUMN title TEXT",
    "ALTER TABLE page_captures ADD COLUMN company TEXT",
    "ALTER TABLE page_captures ADD COLUMN location TEXT",
    "ALTER TABLE page_captures ADD COLUMN salary_text TEXT",
    "ALTER TABLE page_captures ADD COLUMN capture_kind TEXT DEFAULT 'right_click'",
    "ALTER TABLE page_captures ADD COLUMN meta_json TEXT",
    "ALTER TABLE companies ADD COLUMN last_job_count INTEGER",
    "ALTER TABLE companies ADD COLUMN last_poll_status TEXT",
    "ALTER TABLE companies ADD COLUMN last_polled_at INTEGER",
    "ALTER TABLE jobs ADD COLUMN region_status TEXT",
    "ALTER TABLE jobs ADD COLUMN scored_by TEXT",
    "ALTER TABLE jobs ADD COLUMN scored_at INTEGER",
    "ALTER TABLE jobs ADD COLUMN auto_skipped_at INTEGER",
    "ALTER TABLE companies ADD COLUMN auto_disabled_at INTEGER",
    "ALTER TABLE companies ADD COLUMN auto_disabled_reason TEXT",
    "ALTER TABLE companies ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE companies ADD COLUMN last_error TEXT",
    // Multi-user: user_id everywhere user-owned (existing rows = owner, user 1).
    // Legacy singleton tables keep their CHECK(...=1) after the rename — acceptable
    // for the SQLite rollback path (owner-only); Postgres is the multi-user engine.
    "ALTER TABLE jobs ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE companies ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE applications ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE keyword_suggestions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE poll_runs ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE discovery_runs ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE career_watches ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE referrals ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE capture_events ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE page_captures ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE resume_artifacts ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE resume_tasks ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE scan_runs ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE triage_cache ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE profile RENAME COLUMN id TO user_id",
    "ALTER TABLE scan_watch_nudge RENAME COLUMN id TO user_id",
    "ALTER TABLE jobs ADD COLUMN employment_type TEXT",
    // Salary floor + workplace (stamped at ingest; NULL = unknown/pre-migration).
    "ALTER TABLE jobs ADD COLUMN salary_min_cad INTEGER",
    "ALTER TABLE jobs ADD COLUMN salary_max_cad INTEGER",
    "ALTER TABLE jobs ADD COLUMN workplace TEXT",
  ];
  for (const sql of alters) {
    try {
      db.exec(sql);
    } catch {
      /* column exists */
    }
  }
}

/** For tests: a fresh in-memory DB with schema applied. */
export function createTestDb(): DB {
  return openDb(":memory:");
}
