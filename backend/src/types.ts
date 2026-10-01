export type JobState =
  | "discovered"
  | "relevant"
  | "notified"
  | "applied"
  | "skipped";

export type SourceKind = "ats" | "extension" | "discovery";

export type ReferralState = "new" | "contacted" | "applied" | "skipped";

export type CaptureEventType =
  | "listed"
  | "viewed"
  | "thread_opened"
  | "apply_page_opened"
  | "apply_intent";

/** Normalized job emitted by every source (ATS adapters + extension parsers). */
export interface RawJob {
  source: string;
  sourceKind: SourceKind;
  company?: string | null;
  title: string;
  location?: string | null;
  url: string;
  externalId?: string | null;
  description?: string | null;
  postedAt?: number | null; // epoch ms
  postedText?: string | null;
  /** Raw structured employment-type field from the source (e.g. JSearch
   *  FULLTIME/CONTRACTOR, Adzuna permanent/contract, Lever commitment).
   *  Classified into jobs.employment_type at ingest; absent → regex fallback. */
  employmentType?: string | null;
}

export interface JobRow {
  id: string;
  user_id: number;
  dedup_key: string;
  source: string;
  source_kind: SourceKind;
  company: string | null;
  title: string;
  location: string | null;
  url: string;
  external_id: string | null;
  description: string | null;
  posted_at: number | null;
  posted_text: string | null;
  relevance_score: number | null;
  relevance_reason: string | null;
  state: JobState;
  first_seen_at: number;
  last_seen_at: number;
  viewed_at: number | null;
  notified_at: number | null;
  applied_at: number | null;
  notes: string | null;
  salary_text?: string | null;
  /** 'in' | 'out' | null (unknown — treated as in-region by queries). */
  region_status?: "in" | "out" | null;
  /** How the current relevance_score was produced (null = pre-tracking legacy row). */
  scored_by?: "llm" | "heuristic" | "region" | "triage" | "dealbreaker" | null;
  scored_at?: number | null;
  /** Set when the machine (not the human) skipped this job — bulk-reversible. */
  auto_skipped_at?: number | null;
  /** Classified at ingest; NULL = pre-migration row (treated as 'unknown'). */
  employment_type?: "full_time" | "contract" | "part_time" | "intern" | "unknown" | null;
  /** Annualized, CAD-normalized salary bounds parsed at ingest; NULL = unknown. */
  salary_min_cad?: number | null;
  salary_max_cad?: number | null;
  /** Classified at ingest; NULL = pre-migration row. */
  workplace?: "remote" | "hybrid" | "onsite" | "unknown" | null;
}

export interface IngestResult {
  id: string;
  dedupKey: string;
  isNew: boolean;
  state: JobState;
}

export interface CompanyRow {
  id: number;
  name: string;
  ats: string;
  board_token: string;
  enabled: number;
  last_job_count?: number | null;
  last_poll_status?: string | null;
  last_polled_at?: number | null;
}

export interface SearchLinks {
  linkedin?: string;
  indeed?: string;
}

export interface Preferences {
  titles?: string[];
  locations?: string[];
  /** Hard allowlist: only show/notify/score jobs in these countries. Default US+CA. */
  allowedRegions?: ("US" | "CA")[];
  seniority?: string;
  keywords?: string[];
  /** Hard knockouts: any of these terms in title/company/JD scores the job 0
   *  (both the triage and scoreJob paths). E.g. "contract", "c2c", "clearance". */
  dealbreakers?: string[];
  /** Companies whose jobs notify at the lower NOTIFY_TARGET_COMPANY_THRESHOLD bar. */
  targetCompanies?: string[];
  /** Saved search URLs — used in the morning Slack digest (click-through). */
  searchLinks?: SearchLinks;
  [k: string]: unknown;
}
