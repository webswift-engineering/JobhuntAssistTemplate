-- Accounts (owner = 1). token_hash is sha256 hex of the login/API token.
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  token_hash        TEXT UNIQUE,
  slack_webhook_url TEXT,               -- per-user channel; owner falls back to SLACK_WEBHOOK_URL
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL DEFAULT 1,
  dedup_key       TEXT NOT NULL,
  source          TEXT NOT NULL,        -- 'greenhouse'|'lever'|'indeed'|'linkedin'|'forum'|...
  source_kind     TEXT NOT NULL,        -- 'ats' | 'extension'
  company         TEXT,
  title           TEXT NOT NULL,
  location        TEXT,
  url             TEXT NOT NULL,
  external_id     TEXT,
  description     TEXT,
  posted_at       INTEGER,              -- epoch ms, when ATS says it was posted (if known)
  posted_text     TEXT,                 -- raw "3 days ago" for extension sources
  relevance_score REAL,                 -- 0..1, nullable until scored; -1 = out-of-region
  relevance_reason TEXT,                -- short LLM rationale
  state           TEXT NOT NULL DEFAULT 'discovered',
                  -- discovered | relevant | notified | applied | skipped
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  viewed_at       INTEGER,              -- set when human clicks into the listing (interest signal)
  notified_at     INTEGER,
  applied_at      INTEGER,
  notes           TEXT,
  salary_text     TEXT,                 -- extracted compensation snippet if visible on page
  region_status   TEXT,                 -- 'in' | 'out' | NULL (unknown, treated as in)
  scored_by       TEXT,                 -- 'llm' | 'heuristic' | 'region' | 'triage' | 'dealbreaker'
  scored_at       INTEGER,              -- epoch ms of the last scoring pass
  auto_skipped_at INTEGER,              -- machine skip (score below threshold) — bulk-reversible
  employment_type TEXT,                 -- 'full_time'|'contract'|'part_time'|'intern'|'unknown';
                                        -- NULL = pre-migration row (treated as unknown)
  salary_min_cad  INTEGER,              -- annualized, CAD-normalized; NULL = no parseable salary
  salary_max_cad  INTEGER,
  workplace       TEXT                  -- 'remote'|'hybrid'|'onsite'|'unknown'; NULL = pre-migration
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_user_dedup ON jobs(user_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(relevance_score);
-- Queue recency sort key (matches listJobs ORDER BY) — avoids full-table filesort.
CREATE INDEX IF NOT EXISTS idx_jobs_effective_ts ON jobs(COALESCE(posted_at, first_seen_at) DESC);
-- Unscored-jobs scans (scheduler backfill + dashboard badge).
CREATE INDEX IF NOT EXISTS idx_jobs_unscored ON jobs(COALESCE(posted_at, first_seen_at) DESC)
  WHERE relevance_score IS NULL;

CREATE TABLE IF NOT EXISTS companies (        -- which ATS to poll (P2)
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL DEFAULT 1,
  name        TEXT NOT NULL,
  ats         TEXT NOT NULL,            -- 'greenhouse'|'lever'|'ashby'|'workday'|'oracle'
  board_token TEXT NOT NULL,            -- company slug / tenant id
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_job_count INTEGER,
  last_poll_status TEXT,               -- active | empty | error
  last_polled_at INTEGER,
  auto_disabled_at INTEGER,            -- set when the poller disables a broken board
  auto_disabled_reason TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT                      -- most recent poll error for this board
);

CREATE TABLE IF NOT EXISTS profile (          -- one row per user
  user_id                INTEGER PRIMARY KEY,
  master_resume          TEXT,          -- source of truth, never auto-edited
  preferences_json       TEXT,          -- titles, locations, seniority, seed keywords
  screening_answers_json TEXT
);

CREATE TABLE IF NOT EXISTS applications (
  job_id         TEXT PRIMARY KEY REFERENCES jobs(id),
  user_id        INTEGER NOT NULL DEFAULT 1,
  applied_at     INTEGER NOT NULL,
  resume_variant TEXT,                  -- the tailored draft the human approved
  cover_letter   TEXT,
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS keyword_suggestions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL DEFAULT 1,
  term       TEXT NOT NULL,
  rationale  TEXT,
  created_at INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'suggested'  -- suggested | used | dismissed
);

-- scheduler progress / run history (answers "keep track of progress")
CREATE TABLE IF NOT EXISTS poll_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL DEFAULT 1,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  trigger        TEXT NOT NULL,         -- 'schedule' | 'manual'
  status         TEXT NOT NULL,         -- 'running' | 'success' | 'partial' | 'error'
  companies_polled INTEGER DEFAULT 0,
  jobs_seen      INTEGER DEFAULT 0,     -- total normalized jobs returned
  jobs_new       INTEGER DEFAULT 0,     -- newly inserted (fresh)
  jobs_scored    INTEGER DEFAULT 0,
  notifications_sent INTEGER DEFAULT 0,
  errors_json    TEXT,                  -- per-adapter errors, if any
  duration_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_poll_runs_started ON poll_runs(started_at);

CREATE TABLE IF NOT EXISTS discovery_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL DEFAULT 1,
  started_at         INTEGER NOT NULL,
  finished_at        INTEGER,
  trigger            TEXT NOT NULL,
  status             TEXT NOT NULL,
  jobs_seen          INTEGER DEFAULT 0,
  jobs_new           INTEGER DEFAULT 0,
  jobs_scored        INTEGER DEFAULT 0,
  notifications_sent INTEGER DEFAULT 0,
  errors_json        TEXT,
  duration_ms        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_started ON discovery_runs(started_at);

-- Non-ATS career pages (FAANG + custom portals) — polled for listing changes.
CREATE TABLE IF NOT EXISTS career_watches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL DEFAULT 1,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  search_url      TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_open_count INTEGER,
  last_status     TEXT,                  -- active | empty | freeze_hint | error
  last_hint       TEXT,
  last_polled_at  INTEGER,
  content_hash    TEXT                  -- detect page changes when count is unreliable
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_career_watches_user_name ON career_watches(user_id, name);

-- referral leads from community forums and messages (Path B, human-read).
CREATE TABLE IF NOT EXISTS referrals (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL DEFAULT 1,
  source      TEXT NOT NULL,           -- 'forum'
  company     TEXT,
  roles       TEXT,                    -- LLM-extracted; may be multiple roles in one post
  referrer    TEXT,                    -- person offering the referral
  contact     TEXT,                    -- email / wechat / DM handle if posted
  deadline    TEXT,
  thread_url  TEXT NOT NULL,
  raw_text    TEXT,                     -- original post text, kept for re-extraction
  dedup_key   TEXT NOT NULL,            -- e.g. 'ref:' + sha1(thread_url)
  state       TEXT NOT NULL DEFAULT 'new',  -- new | contacted | applied | skipped
  job_id      TEXT REFERENCES jobs(id),     -- optional link if it maps to a known posting
  captured_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_user_dedup ON referrals(user_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_referrals_state ON referrals(state);

-- lightweight interest / coverage signals from the extension (Path B).
CREATE TABLE IF NOT EXISTS capture_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL DEFAULT 1,
  source      TEXT NOT NULL,           -- 'linkedin'|'indeed'|'forum'|'greenhouse'|...
  event       TEXT NOT NULL,           -- 'listed'|'viewed'|'thread_opened'|'apply_page_opened'|'apply_intent'
  job_id      TEXT,                    -- if it maps to a job
  url         TEXT,
  meta_json   TEXT,                    -- e.g. {"tailored":true} for apply_intent
  occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capture_events_time ON capture_events(occurred_at);

-- full-page snapshot taken at the application moment (Path B).
CREATE TABLE IF NOT EXISTS page_captures (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL DEFAULT 1,
  job_id      TEXT REFERENCES jobs(id),
  url         TEXT NOT NULL,
  source      TEXT,
  title       TEXT,
  company     TEXT,
  location    TEXT,
  salary_text TEXT,
  capture_kind TEXT DEFAULT 'right_click',  -- right_click | apply_page
  raw_text    TEXT NOT NULL,
  meta_json   TEXT,
  captured_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_captures_job ON page_captures(job_id);

CREATE TABLE IF NOT EXISTS resume_artifacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL DEFAULT 1,
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  format       TEXT NOT NULL,
  path         TEXT NOT NULL,
  bytes        INTEGER,
  generated_at INTEGER NOT NULL,
  UNIQUE(job_id, format)
);
CREATE INDEX IF NOT EXISTS idx_resume_artifacts_job ON resume_artifacts(job_id);

-- Cached list-triage verdicts (Scan this page). Keyed by the extension dedup key
-- so re-scanning a search page is instant and JDs are not re-fetched.
CREATE TABLE IF NOT EXISTS triage_cache (
  user_id     INTEGER NOT NULL DEFAULT 1,
  dedup_key   TEXT NOT NULL,
  jd_hash     TEXT,                  -- sha1 of the JD used; null when title-only
  verdict     TEXT NOT NULL,         -- strong | maybe | weak | disqualified
  score       REAL,
  result_json TEXT NOT NULL,         -- full TriageResult
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, dedup_key)
);

-- LLM-generated extraction adapters per host (Scan this page auto-adapts unknown sites).
CREATE TABLE IF NOT EXISTS site_adapters (
  host         TEXT PRIMARY KEY,
  adapter_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Auto-scan run reports from the extension (browser-driven LinkedIn watch).
CREATE TABLE IF NOT EXISTS scan_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL DEFAULT 1,
  source             TEXT NOT NULL,      -- 'linkedin-auto' | ...
  scanned            INTEGER DEFAULT 0,
  strong             INTEGER DEFAULT 0,
  maybe              INTEGER DEFAULT 0,
  persisted          INTEGER DEFAULT 0,
  cancelled          INTEGER DEFAULT 0,
  error              TEXT,               -- set when the run failed (timeout, no cards, offline)
  notifications_sent INTEGER DEFAULT 0,
  reported_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scan_runs_reported ON scan_runs(reported_at);

-- Per-user dedupe marker for the "watch looks stopped" Slack nudge.
CREATE TABLE IF NOT EXISTS scan_watch_nudge (
  user_id   INTEGER PRIMARY KEY,
  nudged_at INTEGER NOT NULL
);

-- One row per LLM call (spend meter: GET /admin/spend). Tokens straight from the
-- provider's usage block; cost is derived at read time from LLM_PRICE_*_PER_M.
CREATE TABLE IF NOT EXISTS llm_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  at                INTEGER NOT NULL,
  model             TEXT NOT NULL,
  purpose           TEXT,                 -- 'triage' | 'tailor' | 'score' | ... (best effort)
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  ok                INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_at ON llm_usage(at);

-- Prefill-ahead (phone decides, desktop fills): one row per job queued for apply.
-- The extension parks the filled ATS tab; the phone reviews fields + answers the
-- open questions. See backend/src/applyPrefill.ts for the state machine.
CREATE TABLE IF NOT EXISTS apply_prefills (
  job_id           TEXT PRIMARY KEY REFERENCES jobs(id),
  user_id          INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'queued', -- queued|running|ready|needs_desktop|error|submitted|cancelled|expired
  requested_at     INTEGER NOT NULL,
  started_at       INTEGER,
  updated_at       INTEGER NOT NULL,
  tab_id           INTEGER,                       -- extension tab holding the parked form
  tab_open         INTEGER NOT NULL DEFAULT 0,
  refill_requested INTEGER NOT NULL DEFAULT 0,
  attempts         INTEGER NOT NULL DEFAULT 0,
  resume_state     TEXT,
  drafted          INTEGER DEFAULT 0,
  fields_json      TEXT,                          -- [{label,value,source}]
  unanswered_json  TEXT,                          -- [label]
  error            TEXT,
  screenshot_path  TEXT
);
CREATE INDEX IF NOT EXISTS idx_apply_prefills_user_status ON apply_prefills(user_id, status);

-- Structured JD requirements (multi-stage tailoring, stage 1). Cached by jd_hash
-- so re-generating a résumé for the same JD never re-pays the extraction call.
CREATE TABLE IF NOT EXISTS jd_requirements (
  jd_hash    TEXT PRIMARY KEY,
  extracted  TEXT NOT NULL,          -- JSON JdRequirements
  method     TEXT NOT NULL,          -- 'llm' | 'heuristic'
  created_at INTEGER NOT NULL
);

-- Auto résumé generation queue: high-match jobs (score >= notify threshold) are
-- enqueued after scans/polls and processed one at a time (LLM tailor + PDF render).
CREATE TABLE IF NOT EXISTS resume_tasks (
  job_id      TEXT PRIMARY KEY REFERENCES jobs(id),
  user_id     INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | error
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  queued_at   INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_resume_tasks_status ON resume_tasks(status);
