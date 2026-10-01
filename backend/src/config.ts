import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

/** Loopback addresses never need an access token (the current localhost-only mode). */
export function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host.startsWith("127.")
  );
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  /** Interface to bind. Default loopback (localhost-only). Set HOST=0.0.0.0 to reach
   *  it from your other devices (Tailscale / LAN). Requires ACCESS_TOKEN when non-loopback. */
  host: process.env.HOST ?? "127.0.0.1",
  /** Shared secret required to use the app when bound to a non-loopback host. Empty = auth off. */
  accessToken: process.env.ACCESS_TOKEN ?? "",
  /** Public URL the app is reached at from other devices (used for Slack deep-links + cookie). */
  publicUrl: process.env.PUBLIC_URL ?? "",
  /** Send the auth cookie only over HTTPS. Default off so it works over http:// (Tailscale). */
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  /** Built dashboard (dashboard/dist) served by the backend so there is one URL for every device. */
  dashboardDist:
    process.env.DASHBOARD_DIST ??
    path.join(__dirname, "..", "..", "dashboard", "dist"),
  corsOrigins: (process.env.CORS_ORIGINS ?? "*").split(",").map((s) => s.trim()),
  /** Extension source dir. The apply-fill logic lives there and is also served
   *  to the phone by GET /apply/fill-script (docs/phone-apply-design.md). */
  extensionDir: process.env.EXTENSION_DIR ?? path.join(__dirname, "..", "..", "extension"),

  llm: {
    apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    // DeepSeek retired the "deepseek-chat" alias (July 2026); current API names are
    // deepseek-v4-flash (fast/cheap) and deepseek-v4-pro (higher quality).
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
    /** USD per 1M tokens, for the spend meter (GET /admin/spend). Unset = the meter
     *  reports tokens only. Set from the provider's current price list. */
    priceInPerM: Number(process.env.LLM_PRICE_IN_PER_M ?? 0),
    priceOutPerM: Number(process.env.LLM_PRICE_OUT_PER_M ?? 0),
  },

  scheduler: {
    cron: process.env.POLL_CRON ?? "0 * * * 1-6",
    tz: process.env.TZ ?? "America/New_York",
    enabled: bool(process.env.SCHEDULER_ENABLED, true),
  },

  notify: {
    /** The one job-ping bar. */
    threshold: Number(process.env.NOTIFY_THRESHOLD ?? 0.78),
    /** Lower bar for companies in prefs.targetCompanies. */
    targetCompanyThreshold: Number(process.env.NOTIFY_TARGET_COMPANY_THRESHOLD ?? 0.65),
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? "",
    dashboardUrl:
      process.env.DASHBOARD_URL ??
      process.env.PUBLIC_URL ??
      `http://localhost:${Number(process.env.PORT ?? 8787)}`,
  },

  /** Only surface / notify jobs posted (or first captured) within this many hours. */
  freshness: {
    hours: Number(process.env.FRESHNESS_HOURS ?? 24),
  },

  /** Résumé auto-generation. Decoupled from notify.threshold so raising the
   *  notification bar doesn't silently change LLM tailoring spend. */
  resume: {
    autoThreshold: Number(process.env.RESUME_AUTO_THRESHOLD ?? 0.7),
    /** Max auto-tailored résumés per local day (TAILOR_DAILY_CAP). The one
     *  meaningful LLM cost line while the watch runs unattended; 0 = unlimited.
     *  Manual "Generate résumé" is never capped. */
    dailyCap: Number(process.env.TAILOR_DAILY_CAP ?? 12),
  },

  /** Automated screening: the app skips obvious non-matches so the human doesn't. */
  screening: {
    /** LLM-scored jobs below this are auto-skipped (heuristic scores never are). */
    autoSkipBelow: Number(process.env.AUTO_SKIP_BELOW ?? 0.3),
    /** GET /shortlist size — the daily click-through list. */
    shortlistSize: Number(process.env.SHORTLIST_SIZE ?? 10),
    /** Minimum score to make the shortlist. */
    shortlistMin: Number(process.env.SHORTLIST_MIN ?? 0.6),
  },

  /** Morning + evening Slack reminders to browse LinkedIn / Indeed / company career sites. */
  routine: {
    enabled: bool(process.env.ROUTINE_ENABLED, true),
    morningCron: process.env.ROUTINE_CRON ?? "0 9 * * 1-6",
    eveningCron: process.env.ROUTINE_EVENING_CRON ?? "0 18 * * 1-6",
  },

  /** Daily JSearch + Adzuna sweep (broader market than ATS slug list). */
  discovery: {
    enabled: bool(process.env.DISCOVERY_ENABLED, true),
    cron: process.env.DISCOVERY_CRON ?? "0 8 * * *",
    query: process.env.DISCOVERY_QUERY ?? "software engineer",
    datePosted: process.env.JSEARCH_DATE_POSTED ?? "today",
    maxDaysOld: Number(process.env.DISCOVERY_MAX_DAYS_OLD ?? 1),
    countries: (process.env.JSEARCH_COUNTRIES ?? "us,ca")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    adzunaCountries: (process.env.ADZUNA_COUNTRIES ?? "us,ca")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    jsearchApiKey: process.env.JSEARCH_API_KEY ?? process.env.RAPIDAPI_KEY ?? "",
    jsearchNumPages: Number(process.env.JSEARCH_NUM_PAGES ?? 2),
    adzunaAppId: process.env.ADZUNA_APP_ID ?? "",
    adzunaAppKey: process.env.ADZUNA_APP_KEY ?? "",
    adzunaMaxPages: Number(process.env.ADZUNA_MAX_PAGES ?? 2),
    adzunaResultsPerPage: Number(process.env.ADZUNA_RESULTS_PER_PAGE ?? 50),
  },

  /** Workday boards are huge and unfiltered; restrict the server-side search to
   *  engineering roles so we don't ingest/score warehouse/finance/sales postings.
   *  Set WORKDAY_SEARCH_TEXT="" to pull everything. */
  workday: {
    searchText: process.env.WORKDAY_SEARCH_TEXT ?? "engineer",
    /** Max fresh jobs to return per Workday company per poll (after date filter). */
    maxJobs: Number(process.env.WORKDAY_MAX_JOBS ?? 50),
    /** Max API pages to scan before stopping (20 jobs/page). */
    maxPages: Number(process.env.WORKDAY_MAX_PAGES ?? 10),
  },

  // DB path: backend/data/jobs.db. Override with JOBS_DB (used by tests → :memory:).
  dbPath: process.env.JOBS_DB ?? path.join(__dirname, "..", "data", "jobs.db"),
  schemaPath: path.join(__dirname, "db", "schema.sql"),

  /** Per-job tailored résumé artifacts (gitignored under backend/data/). */
  resumeDir:
    process.env.RESUME_DIR ?? path.join(__dirname, "..", "data", "resumes"),

  /** Fixed single-file staging folder for manual uploads: "stage to outbox"
   *  clears it and writes exactly one PDF, so the OS file picker always finds
   *  the right résumé in the same place. */
  outboxDir: process.env.OUTBOX_DIR ?? path.join(__dirname, "..", "data", "outbox"),

  /** Optional salary floor, CAD-anchored, OFF by default (0). Set
   *  SALARY_FLOOR_HYBRID_CAD / SALARY_FLOOR_REMOTE_CAD to drop jobs whose KNOWN
   *  salary is below your bar; USD converts at a fixed rate. Unknown salary
   *  always passes (tagged, never hard-filtered). */
  salary: {
    floorHybridCad: Number(process.env.SALARY_FLOOR_HYBRID_CAD ?? 0),
    floorRemoteCad: Number(process.env.SALARY_FLOOR_REMOTE_CAD ?? 0),
    usdToCad: Number(process.env.USD_TO_CAD ?? 1.37),
  },

  /** Chrome executable for PDF rendering via puppeteer-core. */
  chromePath:
    process.env.CHROME_PATH ??
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",

  /** Structured master profile compiled from work-experience/ corpus. */
  masterProfilePath:
    process.env.MASTER_PROFILE_PATH ??
    path.join(__dirname, "..", "data", "master-profile.json"),

  /** Root of work-experience markdown corpus (Phase 4 compile). */
  workExperienceDir:
    process.env.WORK_EXPERIENCE_DIR ??
    path.join(__dirname, "..", "..", "work-experience"),
};

export type Config = typeof config;

/**
 * Per-user filesystem locations. The owner (user 1) keeps the original paths so
 * the existing deployment continues untouched; other accounts get subfolders.
 */
export function masterProfilePathFor(userId: number): string {
  if (userId === 1) return config.masterProfilePath;
  return path.join(path.dirname(config.masterProfilePath), "users", String(userId), "master-profile.json");
}
