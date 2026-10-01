import type { DB } from "./db/client.js";
import { config } from "./config.js";
import { getLlm } from "./llm/client.js";
import { ingestMany, listCompanies } from "./store.js";
import { notifyHighScoreJobs } from "./highScoreNotify.js";
import { OWNER_USER_ID } from "./users.js";
import { scoreUnscoredJobs } from "./scheduler.js";
import { fetchJSearch } from "./sources/jsearch.js";
import { fetchAdzuna } from "./sources/adzuna.js";
import { atsBoardFromUrl } from "./sources/atsSlugFromUrl.js";
import type { RawJob } from "./types.js";
import { sleep } from "./sources/AtsAdapter.js";

export interface DiscoveryRunSummary {
  id: number;
  status: "success" | "partial" | "error";
  jobsSeen: number;
  jobsNew: number;
  jobsScored: number;
  notificationsSent: number;
  errors: Record<string, string>;
  durationMs: number;
}

// JSearch/Adzuna discovery is configured by env (DISCOVERY_QUERY) — it remains an
// owner-only feature; other accounts get their jobs from their own LinkedIn scans.
const DISCOVERY_USER = OWNER_USER_ID;

async function companyNames(db: DB): Promise<Set<string>> {
  const rows = await listCompanies(db, DISCOVERY_USER, false);
  return new Set(rows.map((c) => c.name.toLowerCase()));
}

// High-intent pivot 2026-08: the per-run "new discovery job(s) (match > 0%)" digest
// is gone — notifyHighScoreJobs (FTE-only, ≥ NOTIFY_THRESHOLD) is the only job ping,
// and sub-threshold rows no longer get notified_at stamped.

export async function runDiscovery(
  db: DB,
  trigger: "schedule" | "manual"
): Promise<DiscoveryRunSummary> {
  const started = Date.now();
  const runId = Number(
    (
      await db
        .prepare(
          "INSERT INTO discovery_runs (user_id, started_at, trigger, status) VALUES (?,?,?, 'running')"
        )
        .run(DISCOVERY_USER, started, trigger)
    ).lastInsertRowid
  );

  const errors: Record<string, string> = {};
  const rawJobs: RawJob[] = [];
  const query = config.discovery.query;
  const watched = await companyNames(db);

  if (config.discovery.jsearchApiKey) {
    for (const country of config.discovery.countries) {
      const label = `jsearch/${country}`;
      try {
        const batch = await fetchJSearch(config.discovery.jsearchApiKey, {
          query,
          country,
          datePosted: config.discovery.datePosted,
          numPages: config.discovery.jsearchNumPages,
        });
        rawJobs.push(...batch);
      } catch (err) {
        errors[label] = (err as Error).message;
      }
      await sleep(500);
    }
  } else {
    errors["jsearch"] = "JSEARCH_API_KEY not set — skipped";
  }

  if (config.discovery.adzunaAppId && config.discovery.adzunaAppKey) {
    for (const country of config.discovery.adzunaCountries) {
      const label = `adzuna/${country}`;
      try {
        const batch = await fetchAdzuna(
          config.discovery.adzunaAppId,
          config.discovery.adzunaAppKey,
          {
            country,
            what: query,
            maxDaysOld: config.discovery.maxDaysOld,
            maxPages: config.discovery.adzunaMaxPages,
            resultsPerPage: config.discovery.adzunaResultsPerPage,
          }
        );
        rawJobs.push(...batch);
      } catch (err) {
        errors[label] = (err as Error).message;
      }
      await sleep(500);
    }
  } else {
    errors["adzuna"] = "ADZUNA_APP_ID / ADZUNA_APP_KEY not set — skipped";
  }

  const results = await ingestMany(db, DISCOVERY_USER, rawJobs);
  const newResults = results.filter((r) => r.isNew);
  const { scored } = await scoreUnscoredJobs(db, DISCOVERY_USER, results.map((r) => r.id), { llm: getLlm() });
  if (newResults.length) {
    console.log(
      `[discovery] ${newResults.length} new discovery job(s) ingested (notifications: high-score push only)`
    );
  }
  const highPush = await notifyHighScoreJobs(db, DISCOVERY_USER, { scoredSince: started });
  const notificationsSent = highPush.sent ? 1 : 0;

  // Log ATS slugs seen on apply links not already in companies (console hint).
  const slugHints = new Set<string>();
  for (const j of rawJobs) {
    const slug = atsBoardFromUrl(j.url);
    if (!slug) continue;
    const key = `${slug.ats}:${slug.boardToken}`;
    if (slugHints.has(key)) continue;
    slugHints.add(key);
    const known = [...watched].some((n) => n === (j.company ?? "").toLowerCase());
    if (!known) {
      console.log(
        `[discovery] ATS board hint: ${j.company ?? slug.boardToken} → ${slug.ats}/${slug.boardToken}`
      );
    }
  }

  const durationMs = Date.now() - started;
  const hasErrors = Object.keys(errors).length > 0;
  const anyFetched = rawJobs.length > 0;
  const status: DiscoveryRunSummary["status"] = !anyFetched && hasErrors
    ? "error"
    : hasErrors
      ? "partial"
      : "success";

  await db.prepare(
    `UPDATE discovery_runs SET
       finished_at=?, status=?, jobs_seen=?, jobs_new=?, jobs_scored=?,
       notifications_sent=?, errors_json=?, duration_ms=?
     WHERE id=?`
  ).run(
    Date.now(),
    status,
    rawJobs.length,
    newResults.length,
    scored,
    notificationsSent,
    hasErrors ? JSON.stringify(errors) : null,
    durationMs,
    runId
  );

  return {
    id: runId,
    status,
    jobsSeen: rawJobs.length,
    jobsNew: newResults.length,
    jobsScored: scored,
    notificationsSent,
    errors,
    durationMs,
  };
}

export async function listDiscoveryRuns(db: DB, limit = 20): Promise<unknown[]> {
  return await db
    .prepare("SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT ?")
    .all(Math.min(limit, 100));
}

export async function lastDiscoveryRun(db: DB): Promise<unknown | null> {
  return (await db.prepare("SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT 1").get()) ?? null;
}
