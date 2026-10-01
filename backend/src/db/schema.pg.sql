-- PostgreSQL schema — mirror of schema.sql (SQLite), same tables/columns/semantics.
-- Timestamps stay epoch-ms bigints (all code compares against Date.now()).
-- Flags stay 0/1 integers so `enabled = 1` predicates work unchanged.
-- Idempotent: applied on every boot, like the SQLite schema.
--
-- Multi-user: every user-owned table carries user_id (owner = 1). Content-keyed
-- caches (jd_requirements, site_adapters) stay global. A migration section at the
-- bottom upgrades pre-multi-user databases in place.

CREATE TABLE IF NOT EXISTS users (
  id                integer PRIMARY KEY,
  name              text NOT NULL UNIQUE,
  token_hash        text UNIQUE,          -- sha256 hex of the login/API token
  slack_webhook_url text,                 -- per-user channel; owner falls back to SLACK_WEBHOOK_URL
  created_at        bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id               text PRIMARY KEY,
  user_id          integer NOT NULL DEFAULT 1,
  dedup_key        text NOT NULL,
  source           text NOT NULL,
  source_kind      text NOT NULL,
  company          text,
  title            text NOT NULL,
  location         text,
  url              text NOT NULL,
  external_id      text,
  description      text,
  posted_at        bigint,
  posted_text      text,
  relevance_score  double precision,      -- -1 sentinel = out-of-region
  relevance_reason text,
  state            text NOT NULL DEFAULT 'discovered',
  first_seen_at    bigint NOT NULL,
  last_seen_at     bigint NOT NULL,
  viewed_at        bigint,
  notified_at      bigint,
  applied_at       bigint,
  notes            text,
  salary_text      text,
  region_status    text,
  scored_by        text,
  scored_at        bigint,
  auto_skipped_at  bigint,
  employment_type  text                   -- 'full_time'|'contract'|'part_time'|'intern'|'unknown'; NULL = unknown
);
-- idx_jobs_user_dedup is created in the migration section below, after the
-- user_id ALTER — creating it here would fail on a pre-multi-user database.
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(relevance_score);
-- Queue recency sort key (matches listJobs ORDER BY COALESCE(posted_at, first_seen_at)).
CREATE INDEX IF NOT EXISTS idx_jobs_effective_ts ON jobs ((COALESCE(posted_at, first_seen_at)) DESC);
-- Hot queue path: active rows by score then recency.
CREATE INDEX IF NOT EXISTS idx_jobs_queue_score
  ON jobs (relevance_score DESC NULLS LAST, (COALESCE(posted_at, first_seen_at)) DESC)
  WHERE state NOT IN ('applied','skipped');
CREATE INDEX IF NOT EXISTS idx_jobs_unscored
  ON jobs ((COALESCE(posted_at, first_seen_at)) DESC)
  WHERE relevance_score IS NULL;

CREATE TABLE IF NOT EXISTS companies (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer NOT NULL DEFAULT 1,
  name        text NOT NULL,
  ats         text NOT NULL,
  board_token text NOT NULL,
  enabled     integer NOT NULL DEFAULT 1,
  last_job_count integer,
  last_poll_status text,
  last_polled_at bigint,
  auto_disabled_at bigint,
  auto_disabled_reason text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_error  text
);

CREATE TABLE IF NOT EXISTS profile (
  user_id                integer PRIMARY KEY,
  master_resume          text,
  preferences_json       text,
  screening_answers_json text
);

CREATE TABLE IF NOT EXISTS applications (
  job_id         text PRIMARY KEY REFERENCES jobs(id),
  user_id        integer NOT NULL DEFAULT 1,
  applied_at     bigint NOT NULL,
  resume_variant text,
  cover_letter   text,
  notes          text
);

CREATE TABLE IF NOT EXISTS keyword_suggestions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    integer NOT NULL DEFAULT 1,
  term       text NOT NULL,
  rationale  text,
  created_at bigint NOT NULL,
  status     text NOT NULL DEFAULT 'suggested'
);

CREATE TABLE IF NOT EXISTS poll_runs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        integer NOT NULL DEFAULT 1,
  started_at     bigint NOT NULL,
  finished_at    bigint,
  trigger        text NOT NULL,
  status         text NOT NULL,
  companies_polled integer DEFAULT 0,
  jobs_seen      integer DEFAULT 0,
  jobs_new       integer DEFAULT 0,
  jobs_scored    integer DEFAULT 0,
  notifications_sent integer DEFAULT 0,
  errors_json    text,
  duration_ms    bigint
);
CREATE INDEX IF NOT EXISTS idx_poll_runs_started ON poll_runs(started_at);

CREATE TABLE IF NOT EXISTS discovery_runs (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            integer NOT NULL DEFAULT 1,
  started_at         bigint NOT NULL,
  finished_at        bigint,
  trigger            text NOT NULL,
  status             text NOT NULL,
  jobs_seen          integer DEFAULT 0,
  jobs_new           integer DEFAULT 0,
  jobs_scored        integer DEFAULT 0,
  notifications_sent integer DEFAULT 0,
  errors_json        text,
  duration_ms        bigint
);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_started ON discovery_runs(started_at);

CREATE TABLE IF NOT EXISTS career_watches (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         integer NOT NULL DEFAULT 1,
  name            text NOT NULL,
  url             text NOT NULL,
  search_url      text,
  enabled         integer NOT NULL DEFAULT 1,
  last_open_count integer,
  last_status     text,
  last_hint       text,
  last_polled_at  bigint,
  content_hash    text
);
-- idx_career_watches_user_name is created in the migration section below.

CREATE TABLE IF NOT EXISTS referrals (
  id          text PRIMARY KEY,
  user_id     integer NOT NULL DEFAULT 1,
  source      text NOT NULL,
  company     text,
  roles       text,
  referrer    text,
  contact     text,
  deadline    text,
  thread_url  text NOT NULL,
  raw_text    text,
  dedup_key   text NOT NULL,
  state       text NOT NULL DEFAULT 'new',
  job_id      text REFERENCES jobs(id),
  captured_at bigint NOT NULL
);
-- idx_referrals_user_dedup is created in the migration section below.
CREATE INDEX IF NOT EXISTS idx_referrals_state ON referrals(state);

CREATE TABLE IF NOT EXISTS capture_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer NOT NULL DEFAULT 1,
  source      text NOT NULL,
  event       text NOT NULL,
  job_id      text,
  url         text,
  meta_json   text,
  occurred_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capture_events_time ON capture_events(occurred_at);

CREATE TABLE IF NOT EXISTS page_captures (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer NOT NULL DEFAULT 1,
  job_id      text REFERENCES jobs(id),
  url         text NOT NULL,
  source      text,
  title       text,
  company     text,
  location    text,
  salary_text text,
  capture_kind text DEFAULT 'right_click',
  raw_text    text NOT NULL,
  meta_json   text,
  captured_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_captures_job ON page_captures(job_id);

CREATE TABLE IF NOT EXISTS resume_artifacts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      integer NOT NULL DEFAULT 1,
  job_id       text NOT NULL REFERENCES jobs(id),
  format       text NOT NULL,
  path         text NOT NULL,
  bytes        bigint,
  generated_at bigint NOT NULL,
  UNIQUE(job_id, format)
);
CREATE INDEX IF NOT EXISTS idx_resume_artifacts_job ON resume_artifacts(job_id);

CREATE TABLE IF NOT EXISTS triage_cache (
  user_id     integer NOT NULL DEFAULT 1,
  dedup_key   text NOT NULL,
  jd_hash     text,
  verdict     text NOT NULL,
  score       double precision,
  result_json text NOT NULL,
  updated_at  bigint NOT NULL,
  PRIMARY KEY (user_id, dedup_key)
);

CREATE TABLE IF NOT EXISTS site_adapters (
  host         text PRIMARY KEY,
  adapter_json text NOT NULL,
  updated_at   bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            integer NOT NULL DEFAULT 1,
  source             text NOT NULL,
  scanned            integer DEFAULT 0,
  strong             integer DEFAULT 0,
  maybe              integer DEFAULT 0,
  persisted          integer DEFAULT 0,
  cancelled          integer DEFAULT 0,
  error              text,
  notifications_sent integer DEFAULT 0,
  reported_at        bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scan_runs_reported ON scan_runs(reported_at);

CREATE TABLE IF NOT EXISTS scan_watch_nudge (
  user_id   integer PRIMARY KEY,
  nudged_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at                bigint NOT NULL,
  model             text NOT NULL,
  purpose           text,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  ok                integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_at ON llm_usage(at);

CREATE TABLE IF NOT EXISTS apply_prefills (
  job_id           text PRIMARY KEY REFERENCES jobs(id),
  user_id          integer NOT NULL DEFAULT 1,
  status           text NOT NULL DEFAULT 'queued',
  requested_at     bigint NOT NULL,
  started_at       bigint,
  updated_at       bigint NOT NULL,
  tab_id           integer,
  tab_open         integer NOT NULL DEFAULT 0,
  refill_requested integer NOT NULL DEFAULT 0,
  attempts         integer NOT NULL DEFAULT 0,
  resume_state     text,
  drafted          integer DEFAULT 0,
  fields_json      text,
  unanswered_json  text,
  error            text,
  screenshot_path  text
);
CREATE INDEX IF NOT EXISTS idx_apply_prefills_user_status ON apply_prefills(user_id, status);

CREATE TABLE IF NOT EXISTS jd_requirements (
  jd_hash    text PRIMARY KEY,
  extracted  text NOT NULL,
  method     text NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS resume_tasks (
  job_id      text PRIMARY KEY REFERENCES jobs(id),
  user_id     integer NOT NULL DEFAULT 1,
  status      text NOT NULL DEFAULT 'queued',
  error       text,
  attempts    integer NOT NULL DEFAULT 0,
  queued_at   bigint NOT NULL,
  started_at  bigint,
  finished_at bigint
);
CREATE INDEX IF NOT EXISTS idx_resume_tasks_status ON resume_tasks(status);

-- ---------------------------------------------------------------------------
-- Migrations for databases created before multi-user support. Idempotent —
-- ADD COLUMN IF NOT EXISTS backfills every existing row as the owner (user 1),
-- and the DO blocks rework singleton/unique constraints exactly once.
-- ---------------------------------------------------------------------------

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS user_id integer NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS employment_type text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_min_cad integer;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_max_cad integer;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workplace text;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_dedup_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_user_dedup ON jobs(user_id, dedup_key);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS user_id integer NOT NULL DEFAULT 1;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS user_id integer NOT NULL DEFAULT 1;
ALTER TABLE keyword_suggestions ADD COLUMN IF NOT EXISTS user_id integer NOT NULL DEFAULT 1;
ALTER TABLE poll_runs ADD COLUMN IF NOT EXISTS user_id integer NOT NULL DEFAULT 1;
ALTER TABLE discovery_runs ADD COLUMN IF NOT EXISTS user_id integer NOT NULL DEFAULT 1;
ALTER TABLE capture_events ADD COLUMN IF NOT EXISTS user_id integer NOT NULL DEFAULT 1;
ALTER TABLE page_captures ADD COLUMN IF NOT EXISTS user_id integer NOT NULL DEFAULT 1;
ALTER TABLE resume_artifacts ADD COLUMN IF NOT EXISTS user_id integer NOT NULL DEFAULT 1;
ALTER TABLE resume_tasks ADD COLUMN IF NOT EXISTS user_id integer NOT NULL DEFAULT 1;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS user_id integer NOT NULL DEFAULT 1;

ALTER TABLE career_watches ADD COLUMN IF NOT EXISTS user_id integer NOT NULL DEFAULT 1;
ALTER TABLE career_watches DROP CONSTRAINT IF EXISTS career_watches_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_career_watches_user_name ON career_watches(user_id, name);

ALTER TABLE referrals ADD COLUMN IF NOT EXISTS user_id integer NOT NULL DEFAULT 1;
ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_dedup_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_user_dedup ON referrals(user_id, dedup_key);

-- profile: singleton (id = 1, CHECK id = 1) → one row per user keyed by user_id.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profile' AND column_name = 'id'
  ) THEN
    ALTER TABLE profile RENAME COLUMN id TO user_id;
  END IF;
END $$;
ALTER TABLE profile DROP CONSTRAINT IF EXISTS profile_id_check;

-- scan_watch_nudge: singleton → one row per user.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'scan_watch_nudge' AND column_name = 'id'
  ) THEN
    ALTER TABLE scan_watch_nudge RENAME COLUMN id TO user_id;
  END IF;
END $$;
ALTER TABLE scan_watch_nudge DROP CONSTRAINT IF EXISTS scan_watch_nudge_id_check;

-- triage_cache: verdicts depend on the user's prefs/profile → PK (user_id, dedup_key).
ALTER TABLE triage_cache ADD COLUMN IF NOT EXISTS user_id integer NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'triage_cache' AND c.contype = 'p' AND array_length(c.conkey, 1) = 2
  ) THEN
    ALTER TABLE triage_cache DROP CONSTRAINT IF EXISTS triage_cache_pkey;
    ALTER TABLE triage_cache ADD PRIMARY KEY (user_id, dedup_key);
  END IF;
END $$;
