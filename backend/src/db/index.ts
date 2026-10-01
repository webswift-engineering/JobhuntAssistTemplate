/**
 * Engine-agnostic async DB interface. Call shapes intentionally mirror
 * better-sqlite3 (`db.prepare(sql).get/all/run(...params)`) so the SQLite→async
 * migration was purely mechanical (add `await`), and a Postgres engine can slot
 * in behind the same interface (`?` placeholders are canonical; engines
 * translate as needed).
 */
export interface DbStatement {
  get<T = unknown>(...params: unknown[]): Promise<T | undefined>;
  all<T = unknown>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
}

export interface Db {
  readonly engine: "sqlite" | "postgres";
  prepare(sql: string): DbStatement;
  /** Execute raw SQL (DDL / multi-statement schema). */
  exec(sql: string): Promise<void>;
  /**
   * Run `fn` atomically. Unlike better-sqlite3's `db.transaction()`, `fn` may be
   * async. Single-writer app → a plain BEGIN…COMMIT with an in-process mutex is
   * correct for SQLite; Postgres uses a dedicated connection.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
