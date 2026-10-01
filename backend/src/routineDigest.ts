import type { DB } from "./db/client.js";
import { config } from "./config.js";
import { MANUAL_CAREER_SITES } from "./careerSites.js";
import { activityStats } from "./captures.js";
import { isFreshJob } from "./freshness.js";
import { isJobInAllowedRegions } from "./regionFilter.js";
import { listCareerWatches } from "./companyHealth.js";
import { getProfile, listJobs } from "./store.js";
import { sendSlackMessage } from "./notify/slack.js";
import { userWebhook } from "./users.js";
import type { Preferences, SearchLinks } from "./types.js";

/** Default links when profile.searchLinks is unset (built from titles/locations). */
function defaultSearchLinks(prefs: Preferences): Required<SearchLinks> {
  const q = prefs.titles?.[0] ?? prefs.keywords?.[0] ?? "backend software engineer";
  const loc = prefs.locations?.[0] ?? "";
  return {
    linkedin: `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(q)}&location=${encodeURIComponent(loc)}&f_TPR=r86400`,
    indeed: `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}&l=${encodeURIComponent(loc)}&fromage=1`,
  };
}

/** Profile searchLinks override defaults; env vars are a last-resort fallback. */
export function resolveSearchLinks(prefs: Preferences): Required<SearchLinks> {
  const d = defaultSearchLinks(prefs);
  const custom = prefs.searchLinks ?? {};
  return {
    linkedin: custom.linkedin?.trim() || process.env.ROUTINE_LINKEDIN_URL?.trim() || d.linkedin,
    indeed: custom.indeed?.trim() || process.env.ROUTINE_INDEED_URL?.trim() || d.indeed,
  };
}

export type RoutineDigestKind = "morning" | "evening";

/** Slack reminder to browse aggregators + non-ATS career sites (Path B). */
export async function sendRoutineDigest(
  db: DB,
  userId: number,
  kind: RoutineDigestKind = "morning"
): Promise<{ sent: boolean; text: string }> {
  const prefs = (await getProfile(db, userId)).preferences;
  const dash = config.notify.dashboardUrl;
  const links = resolveSearchLinks(prefs);
  const jobs = (await listJobs(db, userId, { limit: 500, sort: "score" })).filter(
    (j) =>
      isFreshJob(j) &&
      isJobInAllowedRegions(j.location, j.description, prefs) &&
      j.state !== "applied" &&
      j.state !== "skipped" &&
      j.source_kind === "ats"
  );
  const withScore = jobs.filter((j) => (j.relevance_score ?? 0) > 0);
  // High-intent queue counts (whole queue, not just ATS): FTE-probable rows at/above
  // the notify bar still awaiting a ping, and fresh contract roles that will never
  // ping (contract stays discoverable on the dashboard only).
  const pendingHighIntent = (
    (await db
      .prepare(
        `SELECT count(*) AS c FROM jobs
         WHERE user_id = ? AND notified_at IS NULL AND relevance_score >= ?
           AND state IN ('discovered','relevant')
           AND (region_status IS NULL OR region_status != 'out')
           AND (employment_type IS NULL OR employment_type IN ('full_time','unknown'))
           AND COALESCE(posted_at, first_seen_at) >= ?`
      )
      .get(userId, config.notify.threshold, Date.now() - config.freshness.hours * 3600_000)) as {
      c: number;
    }
  ).c;
  const freshContract = (
    (await db
      .prepare(
        `SELECT count(*) AS c FROM jobs
         WHERE user_id = ? AND employment_type = 'contract'
           AND state IN ('discovered','relevant')
           AND (region_status IS NULL OR region_status != 'out')
           AND COALESCE(posted_at, first_seen_at) >= ?`
      )
      .get(userId, Date.now() - config.freshness.hours * 3600_000)) as { c: number }
  ).c;
  // Ready-to-apply: high-match FTE-probable jobs whose tailored resume already
  // exists and that the human hasn't actioned — the /apply-next queue size.
  const readyToApply = (
    (await db
      .prepare(
        `SELECT count(*) AS c FROM jobs j
         WHERE j.user_id = ? AND j.state IN ('discovered','relevant','notified')
           AND j.relevance_score >= ?
           AND (j.region_status IS NULL OR j.region_status != 'out')
           AND (j.employment_type IS NULL OR j.employment_type IN ('full_time','unknown'))
           AND EXISTS (SELECT 1 FROM resume_artifacts ra WHERE ra.job_id = j.id)`
      )
      .get(userId, config.notify.threshold)) as { c: number }
  ).c;
  const activity = await activityStats(db, userId);
  const careerWatches = await listCareerWatches(db, userId, true);
  const careerActive = careerWatches.filter((w) => w.last_status === "active").length;
  const careerEmpty = careerWatches.filter(
    (w) => w.last_status === "empty" || w.last_status === "freeze_hint"
  ).length;

  const header =
    kind === "morning"
      ? `:sunrise: *Morning job hunt* (${config.scheduler.tz})`
      : `:city_sunset: *Evening job hunt* (${config.scheduler.tz})`;

  const careerLines = MANUAL_CAREER_SITES.map((s) => `• <${s.url}|${s.name}>`);

  const lines = [
    header,
    "",
    "*Aggregators (extension on):*",
    `• <${links.linkedin}|LinkedIn search>`,
    `• <${links.indeed}|Indeed search>`,
    "",
    "*Company career sites (not on ATS auto-poll):*",
    ...careerLines,
    "",
    `*ATS queue (last ${config.freshness.hours}h):*`,
    `• ${jobs.length} ATS jobs · ${withScore.length} with match > 0%`,
    `• ${pendingHighIntent} FTE high-match(es) (≥ ${Math.round(config.notify.threshold * 100)}%) awaiting review — <${dash}|open queue>`,
    ...(readyToApply > 0
      ? [`• ${readyToApply} ready to apply (résumé ✓, not applied) — run \`/apply next\` in Claude Code`]
      : []),
    ...(freshContract > 0
      ? [`• ${freshContract} fresh contract role(s) on the dashboard (never pinged)`]
      : []),
    `• Career pages (FAANG+): ${careerActive} active · ${careerEmpty} empty/freeze-hint · ${careerWatches.length} tracked`,
    `• ${activity.referralLeads} referral leads captured today`,
    jobs.length > 0
      ? `• <${dash}|Open dashboard queue>`
      : "• Queue empty — browse above or wait for next ATS poll",
  ];

  const text = lines.join("\n");
  const sent = await sendSlackMessage(text, await userWebhook(db, userId));
  return { sent, text };
}

/** @deprecated Use sendRoutineDigest */
export async function sendMorningDigest(db: DB, userId: number): Promise<{ sent: boolean; text: string }> {
  return sendRoutineDigest(db, userId, "morning");
}
