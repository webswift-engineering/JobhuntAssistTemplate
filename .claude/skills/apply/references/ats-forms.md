# ATS form maps — Greenhouse / Lever / Ashby (v1 scope)

Per-family field maps, widget-interaction recipes, and resume-upload tiers for the
`/apply` skill. Everything here assumes the **hosted, unauthenticated** apply form —
company-embedded/iframed variants: extract the hosted URL from the iframe `src` and
navigate there; if there is none, fall back to Phase F.

## ATS detection (from job.url host)

| Host | Family | Apply URL shape |
|---|---|---|
| `job-boards.greenhouse.io` (rewrite `boards.greenhouse.io` →) | greenhouse | `.../<token>/jobs/<id>` — apply form is on-page at the `#app` anchor (or click "Apply") |
| `jobs.lever.co` | lever | `jobs.lever.co/<company>/<id>/apply` (append `/apply` if on the posting page) |
| `jobs.ashbyhq.com` | ashby | `jobs.ashbyhq.com/<company>/<id>/application` |
| `*.myworkdayjobs.com` | workday | **OUT OF SCOPE** — requires account creation/login → Phase F |
| `linkedin.com` | linkedin | **OUT OF SCOPE** — login wall → Phase F |
| anything else | unknown | try to find an embedded hosted form; else Phase F |

## Greenhouse

System fields (native inputs — `form_input` works). Verified on a live Greenhouse form:
- `first_name` ← profile `contact.name` split on last space (first part)
- `last_name` ← remainder
- `preferred_name` — optional, leave blank
- `email` ← `contact.email`
- `phone` ← `contact.phone` (auto-formats; has its own country-code flyout)
- `country` — react-select combobox for the CANDIDATE's country. ⚠ Do not confuse it
  with the phone flyout: an option labeled like "Canada +1" belongs to the PHONE
  widget, not the country field.
- `candidate-location` — geo-suggest combobox: type the city, click the exact
  "City, Region, Country" option
- Resume: native "Attach" file input (+ Dropbox / Google Drive buttons — ignore) and
  an "Enter manually" text alternative (TXT artifact works there)
- "Quick Apply with MyGreenhouse" button — ignore (account flow)
- Custom questions render as `question_*` fields; selects are **react-select comboboxes**

React-select recipe: click the combobox → type the option text → click the option.
⚠ Selections do NOT appear in the underlying `input.value` (React state) — verify by
reading the surrounding container's text, not the input. ≤2 attempts, then leave
blank + flag.

⚠ CAPTCHA nuance (verified): Greenhouse forms carry a hidden invisible-reCAPTCHA
field (`g-recaptcha-response`) on every form — that alone is NOT an abort condition,
since any challenge fires at Submit, which is the human's step. Abort only on a
visible/interactive CAPTCHA challenge.

**EEO block**: a delimited "Voluntary Self-Identification" section (gender / race /
veteran / disability). NEVER interact with it — not even "Decline to answer". List it
as "skipped for you" in the handoff summary.

## Lever

Single page, mostly native inputs:
- `name` — ONE full-name field: use full `contact.name`
- `email`, `phone`
- `org` — current company ← latest `experience[0].company`
- `urls[LinkedIn]` / `urls[GitHub]` / `urls[Portfolio]` ← classify `contact.links[]` by hostname
- `resume` — file input
- `comments` — cover-letter textarea: paste the generated cover letter, mark DRAFT
- Bottom "U.S. Equal Employment Opportunity" survey — skip entirely.

## Ashby

React app; use `read_page` refs + `find`, not CSS selectors:
- `_systemfield_name`, `_systemfield_email`, `_systemfield_resume`, etc.
- Custom fields are labeled containers; comboboxes need the click→type→pick recipe.
- An "Autofill from resume" button exists — IGNORE it (nondeterministic); fill explicitly.

## Label heuristics (tier 2 — custom questions on any family)

Case-insensitive regex on the field label:

| Label matches | Value |
|---|---|
| `linkedin` | LinkedIn URL from `contact.links` |
| `website\|portfolio\|github` | matching link by hostname |
| `current (company\|employer)` | latest `experience[0].company` |
| `how did you hear` | "Job board" |
| `location\|city` | `contact.location` |
| `full legal name` | `contact.name` |

## Screening answers (tier 3)

1. Normalize the question label (lowercase, strip punctuation) → exact lookup in the
   apply-package `screeningAnswers` bank (user-curated via PUT /profile).
2. Structured facts (years of experience) → compute from `master-profile.json`
   experience dates; only if the question is unambiguous.
3. Free-text ("Why us?", "Tell us about a project") → draft from the generated cover
   letter + the matching story in `work-experience/behavioral-interview-scripts.md`
   (pick by the story-bank table at its top; condense to 80–150 written words; DROP
   any metric marked ⚠/unverified). Insert AND mark `DRAFT — verify` in the summary.
4. Work authorization / sponsorship / compensation / legal yes-no with no bank entry:
   **leave blank, flag red, never guess.**

## Resume upload tiers (capability-detected at runtime)

1. **Native file-upload tool** — if the current browser toolset has a file-upload tool
   (e.g. `mcp__claude-in-chrome__file_upload`), focus the attach control and use it
   with the absolute `resume.pdf` path.
2. **DataTransfer injection** — `javascript_tool`: inline the PDF bytes as base64 into
   a script that builds `new File([bytes], "resume.pdf", {type:"application/pdf"})`,
   assigns it to the `<input type=file>` via a `DataTransfer`, and dispatches `change`.
   Do NOT have the page fetch from `localhost:8787` (private-network-access blocks it).
   Verify the filename chip appears; Greenhouse's "paste resume" text box + the TXT
   artifact is the in-family fallback.
3. **Human attaches** — `POST /jobs/:id/open-folder` + flag "attach resume.pdf
   yourself" in the summary. Upload is the one step allowed to degrade to manual
   without aborting.

NOTE: many ATS uploaders transmit the file to their storage the moment it is attached
(before Submit). In a **dry run**, stop at tier-reporting — do not actually attach.
