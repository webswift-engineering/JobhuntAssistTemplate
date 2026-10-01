/**
 * LLM spend meter. The client reports token usage per call (setLlmUsageSink);
 * we persist one row per call and summarise by local day for GET /admin/spend and
 * the dashboard header. Cost is derived at read time from LLM_PRICE_IN_PER_M /
 * LLM_PRICE_OUT_PER_M (USD per 1M tokens) so a price change never rewrites history;
 * with no prices configured the meter reports tokens only.
 */

import type { DB } from "./db/client.js";
import { config } from "./config.js";
import { setLlmUsageSink, type LlmUsageEvent } from "./llm/client.js";
import { startOfLocalDay } from "./resumePipeline.js";

export function wireLlmUsageSink(db: DB): void {
  setLlmUsageSink((e: LlmUsageEvent) => {
    void db
      .prepare(
        "INSERT INTO llm_usage (at, model, prompt_tokens, completion_tokens, ok) VALUES (?, ?, ?, ?, ?)"
      )
      .run(e.at, e.model, e.promptTokens, e.completionTokens, e.ok ? 1 : 0)
      .catch((err: unknown) => console.warn("[llm-usage] insert failed:", (err as Error).message));
  });
}

export interface SpendBucket {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** USD, null when no prices are configured. */
  usd: number | null;
}

export interface SpendSummary {
  pricesConfigured: boolean;
  today: SpendBucket;
  last7d: SpendBucket;
  last30d: SpendBucket;
  /** Per local day, newest first (≤ 30 rows). */
  days: ({ day: string } & SpendBucket)[];
}

function cost(promptTokens: number, completionTokens: number): number | null {
  const { priceInPerM, priceOutPerM } = config.llm;
  if (!(priceInPerM > 0 || priceOutPerM > 0)) return null;
  return (promptTokens * priceInPerM + completionTokens * priceOutPerM) / 1_000_000;
}

async function bucketSince(db: DB, since: number): Promise<SpendBucket> {
  const row = (await db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS p,
              COALESCE(SUM(completion_tokens), 0) AS c
       FROM llm_usage WHERE at >= ?`
    )
    .get(since)) as { calls: number; p: number; c: number } | undefined;
  const promptTokens = Number(row?.p ?? 0);
  const completionTokens = Number(row?.c ?? 0);
  return { calls: Number(row?.calls ?? 0), promptTokens, completionTokens, usd: cost(promptTokens, completionTokens) };
}

function dayKey(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export async function spendSummary(db: DB, now = Date.now()): Promise<SpendSummary> {
  const tz = config.scheduler.tz;
  const dayStart = startOfLocalDay(now, tz);
  const DAY = 24 * 3600 * 1000;
  const [today, last7d, last30d] = await Promise.all([
    bucketSince(db, dayStart),
    bucketSince(db, dayStart - 6 * DAY),
    bucketSince(db, dayStart - 29 * DAY),
  ]);

  const rows = (await db
    .prepare("SELECT at, prompt_tokens, completion_tokens FROM llm_usage WHERE at >= ? ORDER BY at DESC")
    .all(dayStart - 29 * DAY)) as { at: number; prompt_tokens: number; completion_tokens: number }[];
  const byDay = new Map<string, { calls: number; p: number; c: number }>();
  for (const r of rows) {
    const k = dayKey(Number(r.at), tz);
    const b = byDay.get(k) ?? { calls: 0, p: 0, c: 0 };
    b.calls++;
    b.p += Number(r.prompt_tokens);
    b.c += Number(r.completion_tokens);
    byDay.set(k, b);
  }
  const days = [...byDay.entries()].map(([day, b]) => ({
    day,
    calls: b.calls,
    promptTokens: b.p,
    completionTokens: b.c,
    usd: cost(b.p, b.c),
  }));

  return {
    pricesConfigured: config.llm.priceInPerM > 0 || config.llm.priceOutPerM > 0,
    today,
    last7d,
    last30d,
    days,
  };
}
