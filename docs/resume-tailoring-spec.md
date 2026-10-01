# Spec — Right-click JD Capture → Tailored, ATS-safe Résumé (DOCX + PDF)

> **Audience:** an autonomous coding agent executing inside the repository root.
> **Style:** do the phases in order. Each phase is independently shippable and has its own
> *Acceptance* + *Verify* block. Do **not** start a phase until the previous one's Verify passes.
> When a step says "reuse", reuse the cited file — do **not** rebuild it.

---

## 0. TL;DR

Extend the existing Job Hunt Assistant so the user can:

1. **Right-click any job page → "Capture this job"** — records `title`, `company`, `url`,
   `externalId`, and the full JD text into the shared backend.
2. **Generate a tailored, single-column résumé** (TXT + DOCX + PDF) for that job, grounded in the
   user's `work-experience/` corpus, and **store all artifacts in a unique per-job folder** on disk.
3. **See applied / not-applied state** both in the dashboard and as a badge on the job site.

This is **one tool sharing the existing backend** (`<repo>/backend`, SQLite at
`backend/data/jobs.db`). No second service, no second database.

---

## 1. Architecture

```
work-experience/  ──(Phase 4: compile once)──▶  backend/data/master-profile.json
   *.md corpus                                       │ structured, tagged bullets (closed set)
                                                      │
Browser (any job page)                                │
  └ right-click "Capture this job"  ──Phase 1──▶ POST /page-captures ──▶ jobs row (title/company/url)
       (extension context menu +                                          state: discovered
        page extractor: JSON-LD → parser → generic)                       dedup_key = linkedin:<id>
                                                      │
Dashboard / extension "Generate résumé" ──Phase 2──▶ POST /jobs/:id/generate-resume
                                                      │
                                       tailorResume(profile|master, JD)   ← no-fabrication guard
                                                      │
                          ┌───────────────────────────┼───────────────────────────┐
                          ▼                           ▼                           ▼
                  renderResume() TXT          renderDocx() DOCX            renderPdf() PDF
                  (EXISTS)                    (Phase 3, NEW)              (Phase 3, NEW, Chrome)
                          └───────────── write to backend/data/resumes/<slug>-<id8>/ ──────────┘
                                                      │
                                       resume_artifacts rows + job.json manifest
                                                      │
Mark applied ──▶ POST /jobs/:id/apply ──▶ jobs.state='applied'  ──▶ listing card shows ✅ (EXISTS)
```

### What already exists (reuse — do not rebuild)

| Capability | Location |
|---|---|
| Job row with `title`/`company`/`url`/`external_id`/`state`/`applied_at` | `backend/src/db/schema.sql` (`jobs`) |
| Capture endpoint that **creates a job from a capture** w/ title+company+externalId | `recordPageCapture()` in `backend/src/captures.ts`; `POST /page-captures` in `backend/src/routes.ts` |
| State machine incl. terminal `applied` | `backend/src/state.ts` |
| Mark-applied + record application | `POST /jobs/:id/apply` in `routes.ts`; `recordApplication()` in `captures.ts` |
| Tailor (JD-aware, **no-fabrication guard**) | `tailorResume()` in `backend/src/llm/tailorResume.ts` |
| Parser-safe **TXT** render + lint | `renderResume()` / `lintParserSafe()` in `backend/src/llm/renderResume.ts` |
| Apply-package (tailor+render for a job) | `GET /jobs/:id/apply-package` in `routes.ts` |
| Extension → backend messaging (single base URL) | `extension/background.js` handlers; `JC.send` in `extension/registry.js` |
| Card state badges (🆕👁✅🚫⭐) via `/jobs/seen` | `decorate()` in `extension/content.js` |
| Deterministic dedup key (JS mirrors Node) | `JC.dedupKey` in `registry.js`; `backend/src/dedup.ts` |

### What is new

- **Phase 1:** extension context menu + page extractor; capture works on **any** site (not just the 3 hard-coded hosts), via `activeTab` + `chrome.scripting`.
- **Phase 2:** disk layer (per-job folder), `resume_artifacts` table, generate/download/open-folder endpoints, dashboard buttons, detail-page state chip.
- **Phase 3:** styled **single-column** DOCX + PDF renderers (`backend/src/render/`).
- **Phase 4:** `master-profile.json` compiled from `work-experience/`, used as the tailoring source of truth.

---

## 2. Hard invariants (breaking any of these = the task is wrong)

1. **Dedup-key alignment.** A captured LinkedIn job MUST be sent with `source:"linkedin"` and
   `externalId` = the numeric LinkedIn job id, so the backend `dedup_key` equals `linkedin:<id>`,
   which equals `JC.dedupKey({source:"linkedin", externalId:id})` in `registry.js`. This is what
   makes the ✅ badge appear on listing cards after applying. Verify against `backend/src/dedup.ts`
   and `registry.js` — the two key derivations must stay byte-identical.
2. **No fabrication.** Renderers and storage consume **only** the object returned by `tailorResume()`.
   Never add JD keywords that aren't in the source. `enforceNoFabrication()` must still run and pass.
3. **Parser-safe by construction.** DOCX and PDF MUST be **single column**, standard headings,
   normalized dates, **no tables / text-boxes / images / multi-column / headers-footers**. Add a
   DOCX-level assertion (reject any `Table`/columns) mirroring `lintParserSafe()` for TXT.
4. **Localhost-only, single-user, no auth, no auto-submit.** The human always uploads/submits. Any
   new file write stays under `RESUME_DIR`. Any "open folder"/shell call is localhost-only and
   Windows-pathsafe.
5. **Don't regress.** All existing tests must stay green (`cd backend && npm test`). Add new tests
   alongside; don't weaken existing ones.
6. **Secrets + artifacts stay out of git.** `backend/data/` is already gitignored — keep generated
   résumés there. New keys go in `.env` / `.env.example` only.

---

## 3. Phase 1 — Right-click JD capture (records title / company / url)

**Goal:** user right-clicks anywhere on a job/JD page → a "Capture this job" context-menu item →
the active page's `{source, title, company, location, url, externalId, rawText}` is extracted and
POSTed to `/page-captures`, creating (or enriching) a `jobs` row.

### Files
- `extension/manifest.json` — modify
- `extension/background.js` — modify (context menu + click handler)
- `extension/extract.js` — **new** (self-contained page extractor injected via `chrome.scripting`)
- `backend/src/routes.ts` — `/page-captures` already accepts the needed fields; **no change** unless
  you add an optional `location` passthrough (see step 4).

### Steps
1. **Manifest:** add `"contextMenus"` to `permissions`. `activeTab` + `scripting` are already present
   (`manifest.json`), and a context-menu click is a user gesture, so `activeTab` grants temporary
   host access for `executeScript` on **any** site — no broad host-permission change needed.
2. **Context menu (background.js):**
   ```js
   chrome.runtime.onInstalled.addListener(() => {
     chrome.contextMenus.create({
       id: "jc-capture-jd",
       title: "Capture this job for Job Hunt Assistant",
       contexts: ["page", "selection", "link"],
     });
   });
   chrome.contextMenus.onClicked.addListener(async (info, tab) => {
     if (info.menuItemId !== "jc-capture-jd" || !tab?.id) return;
     const [{ result } = {}] = await chrome.scripting.executeScript({
       target: { tabId: tab.id },
       files: ["extract.js"],            // defines window.__jcExtractJob()
     });
     // executeScript returns the file's last-evaluated value → make extract.js end with __jcExtractJob()
     const job = result;
     if (!job?.title) { /* badge an error via chrome.action.setBadgeText or notifications */ return; }
     const res = await http("/page-captures", { method: "POST", body: JSON.stringify(job) });
     // res.data = { id, jobId }. Surface success (badge "✓" or chrome.notifications).
   });
   ```
   Note: `http()` and `base()` already exist in `background.js` — reuse them.
3. **Extractor (`extension/extract.js`)** — dependency-free, self-contained, returns the capture
   payload. Precedence (first hit wins per field):
   1. **JSON-LD `JobPosting`** — scan `script[type="application/ld+json"]` for `@type:"JobPosting"`;
      pull `title`, `hiringOrganization.name`, `jobLocation…address`, `description` (strip HTML),
      `identifier`/`url`. Robust across Greenhouse/Lever/Workday/company sites.
   2. **Site-specific** — if `linkedin.com`: `externalId` from `?currentJobId=` or `/jobs/view/(\d+)`;
      `title` from `h1`; `company` from the employer link. (Mirror selectors in
      `extension/parsers/linkedin.js`.)
   3. **Generic fallback** — `title` = first `h1` || `<title>`; `company` = `og:site_name` meta;
      `rawText` = user selection if any, else `document.body.innerText.slice(0, 12000)`;
      `url` = canonical link || `location.href`.
   - **`source`** = host-derived: `linkedin` | `indeed` | `greenhouse` | `lever` | `workday` |
     `ashby` | else the hostname. **`externalId`** = LinkedIn id, or ATS slug/req-id from URL, else
     `null` (backend will fuzzy-dedup on company|title|location).
   - File must **end with** `window.__jcExtractJob ? __jcExtractJob() : (function(){…return payload})()`
     so `executeScript` resolves to the payload object.
   - **Invariant check:** for LinkedIn, the resulting `{source:"linkedin", externalId}` must produce a
     dedup key equal to the listing card's. Add a console assertion in dev.
4. **(Optional) `location` passthrough:** `recordPageCapture` ignores `location` today. If you want
   location stored on first capture, add `location` to the `/page-captures` zod schema and pass it
   into `ingestJob(...)` inside `recordPageCapture()` (`captures.ts`). Keep it optional/nullable.

### Acceptance
- Right-clicking a LinkedIn job detail page and a non-LinkedIn ATS page (e.g. a Greenhouse posting)
  both create a `jobs` row with correct `title`, `company`, `url`, and (LinkedIn) `external_id`.
- The LinkedIn-captured job's `dedup_key` is `linkedin:<id>` and its listing card shows the
  non-`new` badge after capture (state becomes `discovered` → badge per `decorate()`).
- Capturing the same page twice does **not** create a duplicate row (dedup holds).

### Verify
```bash
# backend running: cd backend && npm run dev
# Simulate the extension POST:
curl -s -X POST http://127.0.0.1:8787/page-captures -H "Content-Type: application/json" \
  -d '{"source":"linkedin","title":"Senior Backend Engineer","company":"Acme","url":"https://www.linkedin.com/jobs/view/4012345678/","externalId":"4012345678","rawText":"About the job ... Spring Boot, AWS ..."}'
# → {"id":N,"jobId":"..."}; GET /jobs should list it with title/company/url set.
curl -s "http://127.0.0.1:8787/jobs?allRegions=1&allAges=1&limit=5"
```
Then load the unpacked extension (`chrome://extensions` → reload), open a real LinkedIn job, and
right-click → Capture. Confirm a row appears via the dashboard queue.

---

## 4. Phase 2 — Per-job résumé folder, artifacts, and applied signal

**Goal:** one endpoint generates the tailored résumé for a job and writes **all artifacts into a
unique folder**; the dashboard can download them and open the folder; applied-state is visible in
both the dashboard and the browser.

### 4.1 Disk layout
```
backend/data/resumes/<company-title-slug>-<jobId8>/
  ├── resume.txt          # renderResume() output (EXISTS today, now persisted)
  ├── resume.docx         # Phase 3
  ├── resume.pdf          # Phase 3
  ├── cover-letter.txt    # tailored.cover_letter
  └── job.json            # manifest: { jobId, title, company, url, capturedAt, descriptionSource,
                          #             jd, keyword_coverage, changes_summary, generatedAt, artifacts[] }
```
- `RESUME_DIR` config (default `./data/resumes`, resolved against backend cwd) in `backend/src/config.ts`
  + `.env.example`. `backend/data/` is gitignored — good.
- Slug: `slugify(`${company ?? "resume"}-${title}`).slice(0,60) + "-" + jobId.slice(0,8)`,
  lowercase, `[^a-z0-9]+ → "-"`, trim leading/trailing `-`. Deterministic per job.

### 4.2 DB — append to `backend/src/db/schema.sql`
```sql
CREATE TABLE IF NOT EXISTS resume_artifacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  format       TEXT NOT NULL,          -- 'txt' | 'docx' | 'pdf' | 'cover_letter' | 'manifest'
  path         TEXT NOT NULL,          -- RESUME_DIR-relative path
  bytes        INTEGER,
  generated_at INTEGER NOT NULL,
  UNIQUE(job_id, format)
);
CREATE INDEX IF NOT EXISTS idx_resume_artifacts_job ON resume_artifacts(job_id);
```
Schema is auto-applied on boot (`CREATE TABLE IF NOT EXISTS`; see `backend/src/db/client.ts`). No
migration runner needed.

### 4.3 New module `backend/src/render/resumeStore.ts`
- `resumeDir(job): string` — absolute folder path from slug.
- `writeArtifact(db, jobId, format, bytesOrString): {path, bytes}` — writes file, `mkdir -p`, upserts
  `resume_artifacts` (ON CONFLICT(job_id,format) DO UPDATE).
- `listArtifacts(db, jobId)` / `readArtifact(db, jobId, format)`.
- `writeManifest(db, jobId, manifest)` — writes `job.json`, registers as `format='manifest'`.

### 4.4 New endpoints (`backend/src/routes.ts`)
- `POST /jobs/:id/generate-resume` — reuse the exact tailor+render logic from
  `GET /jobs/:id/apply-package` (lines ~152–187). Then: write `resume.txt`, `cover-letter.txt`,
  `job.json` (DOCX/PDF added in Phase 3). Returns:
  ```jsonc
  { "jobId":"…", "dir":"…", "artifacts":[{"format":"txt","path":"…","bytes":123}, …],
    "keywordCoverage":{…}, "changesSummary":"…", "renderError":null }
  ```
  If `masterResumePresent` is false → 422 `{error:"no master resume / profile"}` (don't write junk).
- `GET /jobs/:id/resume` — `{ dir, artifacts, generatedAt }` or 404 if none generated.
- `GET /jobs/:id/resume/file?format=docx|pdf|txt|cover_letter` — stream with correct
  `Content-Type` + `Content-Disposition: attachment; filename="<Company>-<Title>.<ext>"`.
- `POST /jobs/:id/open-folder` *(optional, localhost-only)* — `child_process.spawn("explorer.exe", [dir])`
  on win32; no-op + 200 elsewhere. Guard: only bind if `req.socket.remoteAddress` is loopback.

### 4.5 Applied signal
- **Dashboard** (`dashboard/src/main.ts`): in the apply modal, show `job.state` + `applied_at`; after
  generate, render **Download DOCX / PDF / TXT** + **Open folder** (calls the endpoints above). Keep
  the existing keyword-coverage block ([main.ts:324](dashboard/src/main.ts)). "Tailor & apply" already
  calls `POST /jobs/:id/apply` — keep it; pass the persisted `resume.txt` as `resumeVariant`.
- **Browser** (`extension/content.js`): on a job **detail** page that maps to a known job (reuse
  `viewedTarget`/the new extractor for the id), call `SEEN` and render a small chip (reuse
  `content.css` styles) showing `✅ Applied` / `🆕 Not applied`, plus a "Generate résumé" button that
  opens `${DASHBOARD_URL}/#job/<jobId>` (or triggers generate then opens the folder). Listing cards
  already badge via `decorate()` — no change.
- **Mark applied from the browser** *(optional)*: a second context-menu item "Mark this job applied"
  → reuse the existing `PATCH_STATE` background handler (`background.js`) with `{state:"applied"}`.

### Acceptance
- `POST /jobs/:id/generate-resume` creates the folder with `resume.txt`, `cover-letter.txt`,
  `job.json`, and rows in `resume_artifacts`. Re-running overwrites in place (no dup folders/rows).
- Dashboard shows download buttons that return the files with correct filenames/MIME.
- Applying a job flips dashboard state to `applied` and (LinkedIn) the listing card to ✅.

### Verify
```bash
JOB=$(curl -s "http://127.0.0.1:8787/jobs?allRegions=1&allAges=1&limit=1" | python -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
curl -s -X POST http://127.0.0.1:8787/jobs/$JOB/generate-resume | head -c 400
ls -la backend/data/resumes/*/        # folder with txt + cover-letter + job.json
curl -s "http://127.0.0.1:8787/jobs/$JOB/resume" 
cd backend && npm test                # existing + new resumeStore tests green
```

---

## 5. Phase 3 — Styled single-column DOCX + PDF renderers

**Goal:** turn the tailored object into a **polished but single-column** DOCX (source of truth) and a
matching PDF. Single-column keeps it ATS-parseable; styling makes it presentable. The two-column
"sidebar" look of a typical résumé PDF is **intentionally dropped** for uploads.

### Deps (add to `backend/package.json`)
- `docx` (DOCX builder, full control, ATS-safe).
- `puppeteer-core` (PDF via the **already-installed Chrome** — no chromium download).
  Add `CHROME_PATH` to config/`.env.example`, default
  `C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe`.

### Files (new, under `backend/src/render/`)
- `layout.ts` — single shared layout spec: section order (`Summary → Skills → Experience →
  Education`), font family/sizes, one accent color, spacing, date format (reuse `normalizeDates()`
  from `renderResume.ts`). Exposes (a) a structured model both renderers read and (b) an HTML template
  string for the PDF, so DOCX and PDF look identical.
- `renderDocx.ts` — `renderDocx(tailored): Promise<Buffer>` using `docx`. **No tables, no columns,
  no text-boxes, no images.** Headings = styled paragraphs with a bottom border. Add
  `assertDocxParserSafe(doc)` that throws if any `Table`/multi-column section is present (mirror
  `lintParserSafe`).
- `renderPdf.ts` — `renderPdf(tailored): Promise<Buffer>`: fill the `layout.ts` HTML template →
  `puppeteer-core.launch({ executablePath: CHROME_PATH, headless: "new" })` → `page.setContent` →
  `page.pdf({format:"Letter", printBackground:true, margin:…})`. Reuse one shared browser instance
  (lazy singleton) to keep it fast; close on process exit.

### Wire-in
- In `POST /jobs/:id/generate-resume` (Phase 2), after TXT: also write `resume.docx` and `resume.pdf`
  via the new renderers and register both artifacts. If PDF rendering fails (Chrome missing), record
  `renderError` and still return TXT+DOCX — never 500 the whole request over PDF.

### Acceptance
- Generated DOCX opens in Word as a clean **single-column** résumé; copy-pasting its text preserves
  reading order (proof of parser-safety). PDF is visually identical to the DOCX.
- `assertDocxParserSafe` throws on a deliberately table-containing doc (unit test).
- Pipe the DOCX text through the existing `lintParserSafe` (extract text first) → passes.

### Verify
```bash
curl -s -X POST http://127.0.0.1:8787/jobs/$JOB/generate-resume >/dev/null
curl -s "http://127.0.0.1:8787/jobs/$JOB/resume/file?format=docx" -o /tmp/r.docx && file /tmp/r.docx
curl -s "http://127.0.0.1:8787/jobs/$JOB/resume/file?format=pdf"  -o /tmp/r.pdf  && pdftotext -layout /tmp/r.pdf - | head -40
cd backend && npm test
```

---

## 6. Phase 4 — Grounding in `work-experience/` (structured master profile)

**Goal:** raise tailoring quality by selecting from the user's richer evidence corpus
(`<repo>/work-experience/**/*.md`, e.g. `acme/prior-resume-notes.md`) instead of a single
pasted master string — **without** weakening the no-fabrication guarantee.

### Design
1. **Schema** `backend/data/master-profile.json` (committed example at
   `backend/master-profile.example.json`):
   ```jsonc
   { "contact": { "name":"", "email":"", "phone":"", "location":"", "links":[] },
     "summary": "",
     "skills": { "Backend":[], "Cloud":[], "Security":[], "...":[] },
     "experience": [
       { "company":"", "title":"", "location":"", "start":"YYYY-MM", "end":"Present",
         "bullets": [ { "id":"acme-1", "text":"…", "tags":["oauth","oidc","spring"] } ] } ],
     "education": [ { "school":"", "degree":"", "year":"" } ] }
   ```
2. **Compile step** `backend/src/profile/compileProfile.ts` (run on demand, not per-request): read the
   corpus, LLM-extract into the schema, **write the JSON for human review**. Every bullet keeps a
   stable `id`. This is the only place that reads `work-experience/`.
3. **Tailor from profile** — extend `tailorResume()` (or add `tailorFromProfile()`): the LLM
   **selects bullet `id`s** (a closed set) per section and may lightly rephrase. Fabrication becomes
   structurally impossible — every emitted bullet maps to a real `id`. Keep `enforceNoFabrication()`
   as the backstop. Fall back to the current string `masterResume` path when no profile exists.
4. **Profile source switch:** `getProfile()` / apply-package / generate-resume prefer
   `master-profile.json` when present, else `profile.master_resume` (current behavior). Backwards
   compatible.

### Acceptance
- `compileProfile` produces a reviewable `master-profile.json` whose bullets all trace to corpus text.
- Tailoring a JD selects relevant bullets by `id`; `keyword_coverage.missing` items never appear in
  output (existing guard test extended to the profile path).
- With no profile present, behavior is unchanged (string master path still works).

### Verify
```bash
cd backend && npx tsx src/profile/compileProfile.ts   # writes data/master-profile.json
cd backend && npm test                                # guard tests cover the profile path
```

---

## 7. Data contracts (appendix)

**Capture payload (extension → `POST /page-captures`)** — matches existing zod schema in
`routes.ts`; `location` optional only if step 3.4 done:
```ts
{ source: string; title: string; company?: string|null; location?: string|null;
  url: string; externalId?: string|null; rawText: string }
```

**`recordPageCapture` behavior (existing):** no `jobId` → `ingestJob(...)` creates a `jobs` row
(`source_kind:"extension"`, `state` defaults to `discovered`). Existing `jobId` → enriches
`description`. Always inserts a `page_captures` row. (`captures.ts:53`.)

**Dedup key (must match on both sides):** `externalId` present → `"<source>:<externalId>"`; else
`"fuzzy:" + sha1(norm(company)|norm(title)|norm(location))`. See `registry.js` (JS) and
`backend/src/dedup.ts` (TS) — keep identical.

**State machine:** `discovered → relevant → notified → applied`; `skipped` from any non-applied;
`applied` terminal. Enforced server-side (`state.ts`); invalid transition → HTTP 409.

---

## 8. Definition of Done

- [ ] Right-click "Capture this job" works on LinkedIn **and** a non-LinkedIn ATS page; row has
      `title`/`company`/`url` (+ `external_id` on LinkedIn). Dedup holds on re-capture.
- [ ] `POST /jobs/:id/generate-resume` writes a unique per-job folder with TXT + DOCX + PDF +
      cover-letter + `job.json`, and `resume_artifacts` rows; re-run overwrites in place.
- [ ] DOCX/PDF are single-column and pass the parser-safety assertions; no-fabrication guard intact.
- [ ] Applied state shows in the dashboard and as a ✅ badge on LinkedIn listing cards.
- [ ] (If Phase 4 done) tailoring is grounded in `master-profile.json` with id-based bullet selection.
- [ ] `cd backend && npm test` green (existing + new tests). README updated with the new endpoints,
      `RESUME_DIR`, and `CHROME_PATH`.

## 9. Out of scope (do NOT do)

- Auto-submitting applications or auto-filling ATS web forms. We **produce files**; the human uploads.
  *(2026-08 update: form **pre-fill** with mandatory human review + human submit is now covered by
  `docs/apply-assist-spec.md` / the `/apply` skill; auto-**submit** remains forbidden.)*
- Any multi-user, auth, or non-localhost hosting.
- Committing generated résumés or `.env` (keep under gitignored `backend/data/`).
- Reproducing the two-column sidebar layout for uploaded résumés (deliberately single-column).
