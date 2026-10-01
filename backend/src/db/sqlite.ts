import Database from "better-sqlite3";
import type { Db, DbStatement } from "./index.js";

/**
 * SQLite engine: wraps synchronous better-sqlite3 behind the async Db interface.
 * Statements execute synchronously inside and resolve immediately — behavior is
 * identical to the pre-async code, just Promise-shaped.
 */
export class SqliteDb implements Db {
  readonly engine = "sqlite" as const;
  /** Serializes async transactions (better-sqlite3 can't wrap async fns itself). */
  private txLock: Promise<void> = Promise.resolve();

  constructor(public readonly raw: Database.Database) {}

  prepare(sql: string): DbStatement {
    // Lazily prepared so building a statement for a not-yet-migrated table
    // doesn't throw before exec()/migration runs.
    const stmt = () => this.raw.prepare(sql);
    return {
      get: async <T>(...params: unknown[]) => stmt().get(...(params as [])) as T | undefined,
      all: async <T>(...params: unknown[]) => stmt().all(...(params as [])) as T[],
      run: async (...params: unknown[]) => {
        const info = stmt().run(...(params as []));
        return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
      },
    };
  }

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Mutex: only one async transaction at a time (single writer).
    const prev = this.txLock;
    let release!: () => void;
    this.txLock = new Promise((r) => (release = r));
    await prev;
    try {
      this.raw.exec("BEGIN IMMEDIATE");
      try {
        const out = await fn();
        this.raw.exec("COMMIT");
        return out;
      } catch (err) {
        try {
          this.raw.exec("ROLLBACK");
        } catch {
          /* already rolled back */
        }
        throw err;
      }
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    this.raw.close();
  }
}
