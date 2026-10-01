# Apply-assist (`/apply` skill) — spec

Status: v1 shipped 2026-08-03. Lives at `.claude/skills/apply/` (SKILL.md +
references/ats-forms.md); run from Claude Code as `/apply <job-id or URL>`.

## Boundary statement

The resume-tailoring spec (§9) excludes auto-filling ATS forms *as a backend
feature*; this spec moves form **pre-fill** to the agent side while keeping the
README's human/bot boundary intact and sharpening it:

| Bot (Claude, browser pane) | Human (always) |
|---|---|
| Fetch job + profile + tailored resume | Review every filled field |
| Open the hosted ATS form, map + fill fields | Complete flagged/blank items |
| Draft screening answers (marked DRAFT) | **Click Submit** |
| Report a fill summary + gaps, then stop | Confirm "submitted" in chat |
| Record the application after confirmation | Logins, CAPTCHAs, EEO questions |

Never: auto-submit, CAPTCHA solving, account creation/credentials, EEO or
self-identification answers (not even "decline"), guessed authorization /
sponsorship / compensation answers, treating an observed thank-you page as consent.

## Scope

- **v1**: Greenhouse, Lever, Ashby *hosted* forms (public, unauthenticated).
- **Out of scope v1** (route to the copy-paste fallback): Workday (account+login),
  LinkedIn Easy Apply (login wall; modal wizard sits adjacent to Submit — risky),
  company-embedded forms with no hosted equivalent.

## Data sources (all pre-existing)

- `GET /jobs/:id/apply-package` — JD, cover letter, `screeningAnswers` bank
- `backend/data/master-profile.json` — contact/skills/experience (field values)
- `backend/data/resumes/<slug>-<id8>/resume.pdf` — upload payload
  (`POST /jobs/:id/generate-resume` when missing)
- `work-experience/behavioral-interview-scripts.md` — free-text answer material
- `POST /jobs/:id/apply` + `applications` table — recording

## Pipeline integration (v1.1, 2026-08-04)

The crawl→apply flow is automated up to the human review moment:
1. Crawl/scan ingests the job → scored → FTE gate → Slack ping (≥ NOTIFY_THRESHOLD).
2. Résumé auto-generates at RESUME_AUTO_THRESHOLD with no human action.
3. The daily digest reports the **ready-to-apply count** (résumé ✓, unapplied,
   FTE-probable, ≥ notify bar) and points at `/apply next`.
4. `/apply next` auto-picks the top ready job (supported-ATS only), pre-fills,
   hard-stops for review; after submit/skip it offers the next — a batch session.
5. Outcome recording: every fill attempt appends `apply-prep …: filled N/M / aborted`
   to the job's notes; actual submissions land in the `applications` table as before.
The submit click itself is deliberately NOT automatable (human/bot boundary above).

## Phone (v1.3, 2026-08-28)

The same fill logic runs on iOS with no extension: the backend concatenates
`applyAdapters.js` + `applyCore.js` + `mobile/fillDriver.js` + the job's data
into one self-contained script at `GET /apply/fill-script`, and an iOS Shortcut
injects it with Safari's "Run JavaScript on Web Page". Boundary unchanged — the
human reviews and submits. Full design: `docs/phone-apply-design.md`.

## v2 backlog

- **Field helper (shipped 2026-09-20):** in-page dropdown of profile + banked
  answers on focus, and résumé attach on Upload click. Follows the human
  through login / Next; never auto-advances, never submits. Enable on every
  site from the extension popup, or right-click “presets & résumé on this page”.
- `form_adapters` cache per host, mirroring `siteAdapterStore.ts` — learn a custom
  form's field map once.
- Chrome-connected mode (user's own logged-in browser) for login-walled boards —
  same human-submit boundary.
- `GET /profile/apply-fields` endpoint returning pre-split contact fields.
- Detect the post-submit thank-you page to *prompt* (never auto-trigger) Phase E.

## Stream mode (v1.2, 2026-08-06) — chained batch apply

The dashboard round-trip between applications is gone. `⚡ Stream apply` (apply
queue toolbar) chains the whole batch through ONE tab:

```
dashboard ⚡ ─► POST /apply-stream {ids}     (server keeps only: assist host +
   │                                          fresh 24h + résumé-ready + unapplied)
   └─► opens job 1: <url>#jh-apply=<id>&jh-stream=<sid>&jh-pos=1-N
        engine fills → human proofreads → HUMAN clicks Submit
        engine records (RECORD_APPLY {streamId}) via the background worker
        worker: POST /apply-stream/:sid/advance → next URL
        ~4s grace ("End stream" cancels) → chrome.tabs.update(same tab, next)
        engine re-injects on the new page → fills → … → dashboard /?stream=done
```

Design points:
- **Backend-owned queue** (`backend/src/applyStream.ts`, in-memory): the worker
  never holds batch state; a restart just means restarting the stream.
- **Advance is idempotent by position**: the engine's confirmation watcher and
  pagehide fallback can both fire for one submission — a duplicate `afterId`
  re-reads the current position instead of skipping a job.
- **Mid-stream re-check**: jobs applied/skipped from another tab while the
  stream runs are silently passed over at advance time.
- **Human controls in the status bar**: `Skip ▸` (advance without recording)
  and `■ End stream` (stops the batch AND cancels a pending auto-advance, so it
  doubles as "let me stay on this confirmation page").
- The submit click itself remains human — stream mode changes what happens
  *after* Submit, never who clicks it.
