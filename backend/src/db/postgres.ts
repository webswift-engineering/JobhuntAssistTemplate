import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import type { Db, DbStatement } from "./index.js";

// node-postgres returns int8 (bigint) as string; our epoch-ms timestamps and
// count(*) results are int8 — parse to Number (safe: values ≪ 2^53).
pg.types.setTypeParser(20, Number);

/** Translate `?` placeholders (canonical) to Postgres `$1..$n`, respecting quotes. */
export function toPgPlaceholders(sql: string): string {
  let n = 0;
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'") {
      inString = !inString;
      out += c;
      continue;
    }
    if (!inString && c === "?") {
      out += `$${++n}`;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * better-sqlite3's `run()` exposes lastInsertRowid; Postgres needs RETURNING.
 * Every AUTOINCREMENT table in this schema names its key `id`, so appending
 * `RETURNING id` to plain INSERTs recovers the same behavior. INSERTs that
 * already RETURN, or hit DO NOTHING, degrade to lastInsertRowid = 0.
 */
function withReturningId(sql: string): { sql: string; wantsId: boolean } {
  const trimmed = sql.trimStart();
  if (!/^insert\b/i.test(trimmed) || /\breturning\b/i.test(sql)) {
    return { sql, wantsId: false };
  }
  return { sql: `${sql.trimEnd().replace(/;+\s*$/, "")} RETURNING *`, wantsId: true };
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/**
 * Postgres engine over pg.Pool. Transactions run on a dedicated client routed
 * via AsyncLocalStorage, so `db.prepare(...)` calls inside `db.transaction(fn)`
 * transparently join the transaction while unrelated queries keep pooling.
 */
export class PgDb implements Db {
  readonly engine = "postgres" as const;
  private readonly als = new AsyncLocalStorage<Queryable>();

  constructor(private readonly pool: pg.Pool) {}

  private q(): Queryable {
    return this.als.getStore() ?? this.pool;
  }

  prepare(sql: string): DbStatement {
    const text = toPgPlaceholders(sql);
    const ret = withReturningId(text);
    return {
      get: async <T>(...params: unknown[]) =>
        ((await this.q().query(text, params)).rows[0] ?? undefined) as T | undefined,
      all: async <T>(...params: unknown[]) => (await this.q().query(text, params)).rows as T[],
      run: async (...params: unknown[]) => {
        const res = await this.q().query(ret.sql, params);
        return {
          changes: res.rowCount ?? 0,
          lastInsertRowid: ret.wantsId ? Number(res.rows[0]?.id ?? 0) : 0,
        };
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.q().query(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) return fn(); // nested → join the outer transaction
    const client = await this.pool.connect();
    try {
      return await this.als.run(client, async () => {
        await client.query("BEGIN");
        try {
          const out = await fn();
          await client.query("COMMIT");
          return out;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        }
      });
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
