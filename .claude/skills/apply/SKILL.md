---
name: apply
description: >
  Semi-automated apply flow. Pre-fills an ATS application form (Greenhouse / Lever /
  Ashby hosted forms) in the Claude browser pane from master-profile.json and the
  job's tailored resume, drafts screening answers, then STOPS for the human to review
  and click Submit themselves. Never submits, never solves CAPTCHAs, never logs in or
  creates accounts, never touches EEO/self-identification questions. Usage:
  /apply <job-id or apply-page URL> · /apply next (auto-picks the top ready job)
  · /apply queue (lists what's ready)
---

# /apply — pre-fill an application for human review

**Boundary (non-negotiable, from README "human/bot boundary"):** the bot pre-fills;
the human reviews and clicks Submit. The skill must never click Submit (or any
control that submits), never solve CAPTCHAs, never enter credentials or create
accounts, and never answer EEO/self-identification or guessed legal/authorization
questions. Only an explicit user message ("submitted") counts as submission — a
thank-you page observed in the pane does not.

Reference: [references/ats-forms.md](references/ats-forms.md) — per-ATS field maps,
widget recipes, upload tiers. Read it before Phase B.

## Phase A — Resolve & preflight (no browser)

1. `GET http://127.0.0.1:8787/health` — if down, tell the user to run the
   "Restart JobHunt Server" shortcut (or `backend/scripts/start-server.cmd`) and stop.
2. Resolve the argument:
   - job id → `GET /jobs/:id`
   - URL → try to match an existing job; else `POST /captures/from-url {url}` and use
     the returned job.
   - **`next` / `queue`** — the apply queue is: `GET /jobs?minScore=0.78&
     employmentType=full_time&excludeStates=applied,skipped&sort=score&limit=20`
     (repeat once with `employmentType=unknown` and merge, full_time first), keep only
     rows whose attached `resume.status === "ready"` AND whose URL host maps to a
     supported ATS family (Greenhouse/Lever/Ashby — others are listed as
     "manual-only"). `queue`: print the top 5 as `score | company | title | id |
     family` and stop. `next`: take the top row and continue as if its id was passed.
     After Phase E (or an explicit user skip), offer the next row in the queue —
     this makes a batch apply session: fill → human reviews+submits → record → next.
3. Guards:
   - `job.state === "applied"` → warn (state is terminal; re-recording is harmless
     but suspicious) and require explicit go-ahead.
   - Detect ATS family from the URL host (table in ats-forms.md). Workday / LinkedIn /
     unknown → Phase F directly.
4. `GET /jobs/:id/apply-package` → JD text, cover letter, `screeningAnswers` bank.
   Read `backend/data/master-profile.json` (or `MASTER_PROFILE_PATH`) for contact
   fields; split name on last space; classify `links[]` by hostname.
5. Resume: `GET /jobs/:id/resume`. If 404 → `POST /jobs/:id/generate-resume`, poll
   `GET /jobs/:id/resume-status` (cap ~90s). Resolve the absolute `resume.pdf` path
   from the returned `dir` and confirm it exists on disk.

## Phase B — Open & read the form (browser pane)

1. Navigate to the apply form (family-specific URL shape; rewrite
   `boards.greenhouse.io` → `job-boards.greenhouse.io`).
2. `read_page` (interactive) → inventory fields: label, type, required, ref.
3. **Abort to Phase F before touching anything** if the page shows a
   visible/interactive CAPTCHA challenge, a login form, or no recognizable
   application fields. (A hidden `g-recaptcha-response` field alone is normal on
   Greenhouse and NOT an abort condition — any challenge fires at Submit, the
   human's step.)

## Phase C — Fill

Order: identity fields → links → resume upload → selects → screening questions.
Leave EEO/self-identification sections completely untouched.

- Tier 1: ATS template map (ats-forms.md).
- Tier 2: label heuristics (ats-forms.md table).
- Tier 3: screening answers (bank match → structured facts → drafted free-text
  marked DRAFT; authorization/comp/legal without a bank entry stay blank + flagged).
- Verify every `form_input` by re-reading the element; custom widgets get the
  click→type→pick recipe, ≤2 attempts, then blank + flag.
- Resume upload: tiers in ats-forms.md; degrading to "human attaches" is fine.

## Phase D — Review handoff (the hard stop)

Print a summary table: `field | value filled | source (profile / answer-bank /
drafted / —) | status (filled / DRAFT—verify / skipped for you)`. Explicitly list:
EEO left untouched, drafted answers to proofread, unfilled required fields, whether
the resume is attached or needs manual attach. Then:

> Everything above is filled in the browser pane. Review it, complete the flagged
> items, and click Submit yourself. Tell me once you've submitted (or if you bailed).

**Stop. Do not click anything further. Do not treat page navigation or a thank-you
page as consent.**

**Record the fill outcome now** (regardless of what the human decides): PATCH the
job's notes, appending one line —
`apply-prep <date>: filled N/M fields, K flagged (<family>)` on success, or
`apply-prep <date>: aborted — <reason>` when Phase B/C bailed to F. This is the
per-job prep record the dashboard card shows; the `applications` table (Phase E)
remains the record of actual submissions.

## Phase E — Record (only after the user explicitly says they submitted)

1. `POST /jobs/:id/apply` with
   `{resumeVariant: <resume folder basename>, notes: "Submitted by user via /apply · <ats> · <date>"}`
   (include `coverLetter` only if one was actually used).
2. Offer to save any screening answers the user corrected back to the profile bank
   (`PUT /profile` — merge into `screeningAnswers`).
3. If the user says they bailed: record nothing; optionally PATCH notes with
   "apply attempted, aborted: <reason>".

## Phase F — Fallback (never dead-end)

1. `POST /jobs/:id/open-folder` — opens the tailored-resume folder in Explorer.
2. Print a copy-paste block of every value the skill would have filled (contact,
   links, drafted answers) so the human can fill the form in their own browser.
3. Phase E recording is still offered after a manual apply.

## Failure modes

| Failure | Behavior |
|---|---|
| CAPTCHA / login wall / no fields | Stop before filling → Phase F |
| Embedded iframe form | Navigate to the hosted URL from the iframe src; else F |
| Upload fails all tiers | Continue; flag "attach resume yourself" |
| Widget rejects value twice | Leave blank, flag; never loop |
| Backend down / resume gen timeout | Named error + fix instruction; no browser work |
| User never confirms submission | Nothing recorded; state unchanged |
| Already-applied job | Warn; require explicit go-ahead |
