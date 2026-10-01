// Default to same-origin so the app works wherever the backend serves it from
// (localhost, Tailscale IP/MagicDNS, or a Cloudflare Tunnel domain). Override with
// VITE_API_BASE only when running the Vite dev server against a remote backend.
const BASE = (import.meta.env.VITE_API_BASE as string) || "";

/** Error from a non-2xx API response; `status` lets callers branch on 404 etc. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (res.status === 401) {
    // Session expired / not signed in — bounce to the login page.
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      msg = body.error ?? msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status);
  }
  return (await res.json()) as T;
}

export interface Job {
  id: string;
  source: string;
  source_kind: string;
  company: string | null;
  title: string;
  location: string | null;
  url: string;
  description: string | null;
  relevance_score: number | null;
  relevance_reason: string | null;
  state: string;
  posted_at: number | null;
  first_seen_at: number;
  viewed_at: number | null;
  applied_at?: number | null;
  notes: string | null;
  /** How the score was produced ('heuristic' = LLM was down — flagged in the UI). */
  scored_by?: "llm" | "heuristic" | "region" | "triage" | "dealbreaker" | null;
  scored_at?: number | null;
  /** 'full_time'|'contract'|'part_time'|'intern'|'unknown'; null = pre-migration (unknown). */
  employment_type?: string | null;
  /** Annualized, CAD-normalized salary bounds parsed at ingest; null = unknown. */
  salary_min_cad?: number | null;
  salary_max_cad?: number | null;
  workplace?: "remote" | "hybrid" | "onsite" | "unknown" | null;
  /** Auto résumé pipeline state for this job (attached by GET /jobs). */
  resume?: {
    status: "none" | "queued" | "generating" | "ready" | "error";
    formats: string[];
    error?: string;
  };
  /** Prefill-ahead badge (attached by GET /jobs); null = never queued. */
  prefill?: { status: PrefillStatus; unanswered: number; updatedAt: number } | null;
}

export type PrefillStatus =
  | "queued"
  | "running"
  | "ready"
  | "needs_desktop"
  | "error"
  | "submitted"
  | "cancelled"
  | "expired";

export interface PrefillField {
  label: string;
  value: string;
  source: "engine" | "human" | "human-edited" | "empty";
}

export interface PrefillDetail {
  jobId: string;
  status: PrefillStatus;
  requestedAt: number;
  startedAt: number | null;
  updatedAt: number;
  tabOpen: boolean;
  refillRequested: boolean;
  attempts: number;
  resumeState: string | null;
  drafted: number;
  fields: PrefillField[];
  unanswered: string[];
  error: string | null;
  hasScreenshot: boolean;
}

/** Structured alert from GET /health — rendered as persistent banners. */
export interface HealthAlert {
  id: string;
  severity: "error" | "warn";
  title: string;
  detail?: string;
  since?: number;
  count?: number;
}

export interface ResumePipelineStatus {
  running: boolean;
  currentJobId: string | null;
  counts: { queued: number; running: number; done: number; error: number };
  tasks: {
    job_id: string;
    status: "queued" | "running" | "done" | "error";
    error: string | null;
    title: string | null;
    company: string | null;
    score: number | null;
    queued_at: number;
    finished_at: number | null;
  }[];
}

export interface Referral {
  id: string;
  company: string | null;
  roles: string | null;
  referrer: string | null;
  contact: string | null;
  deadline: string | null;
  thread_url: string;
  state: string;
}

export interface Company {
  id: number;
  name: string;
  ats: string;
  board_token: string;
  enabled: number;
}

export interface CompanyHealthRow {
  id: number;
  name: string;
  ats: string;
  enabled: number;
  last_job_count: number | null;
  last_poll_status: string | null;
  last_polled_at: number | null;
  consecutive_failures: number;
  last_error: string | null;
  auto_disabled_at: number | null;
  auto_disabled_reason: string | null;
}

export interface PollRunRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  trigger: string;
  status: string;
  companies_polled: number;
  jobs_seen: number;
  jobs_new: number;
  jobs_scored: number;
  notifications_sent: number;
  errors_json: string | null;
  duration_ms: number | null;
}

export interface JobFacets {
  states: { value: string; count: number }[];
  sources: { value: string; count: number }[];
  sourceKinds: { value: string; count: number }[];
  employmentTypes: { value: string; count: number }[];
  total: number;
}

export interface Keyword {
  id: number;
  term: string;
  rationale: string | null;
  status: string;
}

export interface ApplyPackage {
  job: Job;
  descriptionSource: string;
  description: string;
  tailored: {
    sections?: { heading: string; items: string[] }[];
    cover_letter: string;
    keyword_coverage: { present: string[]; missing: string[] };
    changes_summary: string;
    tailoredMode?: "llm" | "offline" | null;
  } | null;
  renderedResume: string | null;
  renderError: string | null;
  /** Per-JD-requirement coverage from the last generation (null = regenerate to see it). */
  requirementsCoverage:
    | { requirement: string; kind: "must" | "nice"; status: "covered" | "gap" | "unprovable" | "soft"; bulletIds: string[] }[]
    | null;
  screeningAnswers: Record<string, string>;
  masterResumePresent: boolean;
}

/** GET /profile/apply-fields — flat contact fields + the banked answers,
 *  the same payload the fill script inlines. Drives the copy chips. */
export interface ApplyFields {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedinUrl: string;
  websiteUrl: string;
  currentCompany: string;
  currentTitle: string;
  school: string;
  degree: string;
  answers: Record<string, string>;
}

export interface GenerateResumeResult {
  jobId: string;
  dir: string;
  artifacts: { format: string; path: string; bytes: number }[];
  keywordCoverage: { present: string[]; missing: string[] } | null;
  changesSummary: string | null;
  tailoredMode?: "llm" | "offline";
  renderError: string | null;
  renderedResume: string | null;
}

export interface ResumeInfo {
  dir: string;
  artifacts: { format: string; path: string; bytes: number | null }[];
  generatedAt: number | null;
}

/** GET /jobs/:id/resume-status — polled by the apply modal while it's open. */
export interface JobResumeStatus {
  status: "idle" | "queued" | "running" | "done" | "failed";
  error?: string;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  generatedAt: number | null;
  artifacts: { format: string; path: string; bytes: number; generatedAt: number }[];
  dir: string;
}

export interface CaptureRow {
  captureId: number;
  jobId: string;
  url: string;
  source: string | null;
  title: string;
  company: string | null;
  location: string | null;
  salaryText: string | null;
  captureKind: string | null;
  jdPreview: string;
  jdLength: number;
  capturedAt: number;
  jobState: string;
  resume: {
    status: "none" | "partial" | "ready";
    generatedAt: number | null;
    formats: string[];
  };
}

export interface CaptureDetail extends Omit<CaptureRow, "jdPreview" | "jdLength"> {
  jd: string;
}

/** POST /apply-stream — one chained stream over ALL queue jobs: `auto` = the
 *  extension engine fills + advances; `manual` = the Copilot panel assists. */
export interface StartApplyStreamResult {
  streamId: string | null;
  total: number;
  counts: { auto: number; manual: number };
  first: { id: string; url: string; index: number; total: number; mode: "auto" | "manual" } | null;
  skipped: { id: string; reason: string }[];
}

export const api = {
  base: BASE || location.origin,
  health: () => req<any>("/health"),
  pollRuns: (limit = 20) => req<PollRunRow[]>(`/poll-runs?limit=${limit}`),
  pollNow: () => req<any>("/admin/poll-now", { method: "POST" }),
  scoreUnscored: (limit = 50) =>
    req<{
      ok: boolean;
      attempted: number;
      scored: number;
      remaining: number;
      skipped?: boolean;
    }>("/admin/score-unscored", {
      method: "POST",
      body: JSON.stringify({ freshOnly: true, inRegionOnly: true, limit }),
    }),
  publishToSlack: () =>
    req<{ ok: boolean; threshold: number; matched: number; notified: number; sent: boolean }>(
      "/notify/publish",
      { method: "POST" }
    ),
  activity: () => req<any>("/stats/activity"),
  tabCounts: () =>
    req<{ queue: number; captures: number; referrals: number; keywords: number }>(
      "/stats/tab-counts"
    ),

  jobs: (q = "") => req<Job[]>(`/jobs${q}`),
  jobFacets: (q = "") => req<JobFacets>(`/jobs/facets${q}`),
  patchJob: (id: string, body: { state?: string; notes?: string }) =>
    req<Job>(`/jobs/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  applyPackage: (id: string) => req<ApplyPackage>(`/jobs/${id}/apply-package`),
  applyFields: () => req<ApplyFields>("/profile/apply-fields"),
  startApplyStream: (ids: string[]) =>
    req<StartApplyStreamResult>("/apply-stream", { method: "POST", body: JSON.stringify({ ids }) }),
  /** Alert recovery: probe disabled boards, AI-propose + verify replacements. */
  recoverBoards: () =>
    req<{
      ok: boolean;
      results: {
        name: string;
        outcome: "reenabled" | "switched" | "still_broken";
        ats?: string;
        boardToken?: string;
        tried?: number;
        error?: string;
      }[];
    }>("/admin/recover-boards", { method: "POST" }),
  /** Record a scan run (clears the stalled-watch alert after a fallback scan). */
  reportScan: (body: { source: string; scanned: number; strong: number; maybe: number; persisted: number }) =>
    req<{ ok: boolean }>("/scan/report", { method: "POST", body: JSON.stringify(body) }),
  /** Mute permanently-gone boards: stay disabled, stop alerting. */
  acknowledgeBoards: () =>
    req<{ ok: boolean; acknowledged: number }>("/admin/acknowledge-boards", { method: "POST" }),
  apply: (id: string, body: { resumeVariant?: string; coverLetter?: string; notes?: string }) =>
    req<Job>(`/jobs/${id}/apply`, { method: "POST", body: JSON.stringify(body) }),
  generateResume: (id: string) =>
    req<GenerateResumeResult>(`/jobs/${id}/generate-resume`, { method: "POST" }),
  resumePipeline: () => req<ResumePipelineStatus>("/resume-pipeline"),
  /** LLM spend meter (calls / tokens / est. USD) + today's auto-tailor cap usage. */
  spend: () => req<any>("/admin/spend"),
  /** Newest extension auto-scan report (browser-driven LinkedIn watch). */
  scanLastRun: () => req<{ lastRun: any | null }>("/scan/last-run"),
  // ---- prefill-ahead (phone decides, desktop fills) ----
  requestPrefill: (id: string) =>
    req<{ ok: boolean; status?: PrefillStatus; reason?: string }>(`/jobs/${id}/prefill`, { method: "POST" }),
  cancelPrefill: (id: string) => req<{ ok: boolean }>(`/jobs/${id}/prefill`, { method: "DELETE" }),
  prefill: (id: string) => req<PrefillDetail>(`/jobs/${id}/prefill`),
  answerPrefill: (id: string, answers: Record<string, string>) =>
    req<{ ok: boolean; banked: number; refill: boolean }>(`/jobs/${id}/prefill/answers`, {
      method: "POST",
      body: JSON.stringify({ answers }),
    }),
  prefillScreenshotUrl: (id: string) => `${BASE}/jobs/${id}/prefill/screenshot`,
  prefills: () => req<(PrefillDetail & { title: string; company: string | null; score: number | null; url: string; jobState: string })[]>("/prefill"),
  runResumePipeline: (hours?: number) =>
    req<{ ok: boolean; enqueued: number; skippedReason?: string; status: ResumePipelineStatus["counts"] }>(
      "/resume-pipeline/run",
      { method: "POST", body: JSON.stringify(hours ? { hours } : {}) }
    ),
  resumeInfo: (id: string) => req<ResumeInfo>(`/jobs/${id}/resume`),
  resumeStatus: (id: string) => req<JobResumeStatus>(`/jobs/${id}/resume-status`),
  resumeFileUrl: (id: string, format: string) =>
    `${BASE}/jobs/${id}/resume/file?format=${encodeURIComponent(format)}`,
  openResumeFolder: (id: string) =>
    req<{ ok: boolean; dir: string }>(`/jobs/${id}/open-folder`, { method: "POST" }),

  captures: (limit = 100) => req<CaptureRow[]>(`/captures?limit=${limit}`),
  capture: (id: number) => req<CaptureDetail>(`/captures/${id}`),
  pageCapture: (body: {
    url: string;
    rawText: string;
    title?: string;
    company?: string;
    location?: string;
    salaryText?: string;
    source?: string;
    captureKind?: "right_click" | "apply_page";
  }) =>
    req<{ id: number; jobId: string | null }>("/page-captures", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  scanLinkedIn: (url: string, opts?: { maxJobs?: number; persist?: boolean }) =>
    req<{
      ok: boolean;
      scanned: number;
      strong: number;
      maybe: number;
      persisted: number;
      results: {
        title: string;
        company: string | null;
        location: string | null;
        url: string;
        verdict: string;
        score: number;
        reason: string;
      }[];
    }>("/scan/linkedin-search", {
      method: "POST",
      body: JSON.stringify({ url, maxJobs: opts?.maxJobs, persist: opts?.persist ?? true }),
    }),
  captureFromText: (body: { rawText: string; url?: string; source?: string }) =>
    req<{
      ok: boolean;
      needsManual?: boolean;
      method: "llm" | "fallback";
      error?: string;
      captureId?: number;
      jobId?: string | null;
      extracted: {
        title: string | null;
        company: string | null;
        location: string | null;
        salaryText: string | null;
        description: string;
        applyUrl: string | null;
        confidence: number;
      };
    }>("/captures/from-text", { method: "POST", body: JSON.stringify(body) }),
  captureFromUrl: (url: string) =>
    req<{
      ok: boolean;
      needsManual?: boolean;
      error?: string;
      jobId?: string | null;
      extracted: {
        title: string | null;
        company: string | null;
        location: string | null;
        description: string | null;
        salaryText: string | null;
        postedAt: number | null;
      };
    }>("/captures/from-url", { method: "POST", body: JSON.stringify({ url }) }),

  companies: () => req<Company[]>("/companies"),
  companiesHealth: () => req<CompanyHealthRow[]>("/companies/health"),
  addCompany: (body: { name: string; ats: string; boardToken: string }) =>
    req<Company>("/companies", { method: "POST", body: JSON.stringify(body) }),
  toggleCompany: (id: number, enabled: boolean) =>
    req(`/companies/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),

  profile: () => req<any>("/profile"),
  tailorSource: () =>
    req<{ masterResumePresent: boolean; masterResumeAdequate: boolean; masterTextLength: number }>(
      "/profile/tailor-source"
    ),
  saveProfile: (body: any) => req("/profile", { method: "PUT", body: JSON.stringify(body) }),

  referrals: (state = "") => req<Referral[]>(`/referrals${state ? `?state=${state}` : ""}`),
  patchReferral: (id: string, body: { state?: string }) =>
    req<Referral>(`/referrals/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  keywords: (status = "") => req<Keyword[]>(`/keywords${status ? `?status=${status}` : ""}`),
  recommendKeywords: () => req<Keyword[]>("/keywords/recommend", { method: "POST" }),
  patchKeyword: (id: number, status: string) =>
    req<Keyword>(`/keywords/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
};
