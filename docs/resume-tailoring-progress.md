# Resume tailoring — implementation progress

Tracks delivery against [resume-tailoring-spec.md](./resume-tailoring-spec.md).

| Phase | Status | Notes |
|-------|--------|-------|
| **Phase 1** — Right-click JD capture | ✅ Done | `extension/extract.js`, context menu in `background.js`, `location` passthrough |
| **Phase 2** — Per-job folder + artifacts + API | ✅ Done | `resumeStore.ts`, `generate-resume` endpoints, dashboard downloads |
| **Phase 3** — DOCX + PDF renderers | ✅ Done | `layout.ts`, `renderDocx.ts`, `renderPdf.ts` (Chrome via `CHROME_PATH`) |
| **Phase 4** — `work-experience/` → master profile | ✅ Done | `compileProfile.ts`, `tailorFromProfile.ts`, `master-profile.example.json` |

## Definition of Done checklist

- [x] Right-click **Capture this job** on any page (LinkedIn + ATS via JSON-LD)
- [x] LinkedIn dedup key = `linkedin:<id>` (matches `registry.js`)
- [x] `POST /jobs/:id/generate-resume` → folder with TXT, DOCX, PDF, cover-letter, `job.json`
- [x] Dashboard: Generate, Download DOCX/PDF/TXT, Open folder
- [x] Applied state in dashboard + ✅ on listing cards (existing)
- [x] Detail-page chip (LinkedIn) with applied / not-applied + Generate link
- [x] Optional context menu **Mark applied**
- [x] No-fabrication guard unchanged
- [x] DOCX parser-safety assertion + tests
- [x] Profile path: compile corpus → `backend/data/master-profile.json`

## Verify commands

```bash
# Phase 1 — simulate capture
curl -s -X POST http://127.0.0.1:8787/page-captures -H "Content-Type: application/json" \
  -d '{"source":"linkedin","title":"Senior Backend Engineer","company":"Acme","url":"https://www.linkedin.com/jobs/view/4012345678/","externalId":"4012345678","rawText":"About the job ..."}'

# Phase 2/3 — generate résumé
JOB=$(curl -s "http://127.0.0.1:8787/jobs?allRegions=1&allAges=1&limit=1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[0].id))")
curl -s -X POST http://127.0.0.1:8787/jobs/$JOB/generate-resume

# Phase 4 — compile profile from work-experience/
cd backend && npx tsx src/profile/compileProfile.ts

# Tests
cd backend && npm test
```

## Pending / optional follow-ups

- [x] **Captures tab** — full JD + salary + tailoring progress (DeepSeek)
- [ ] Reload unpacked extension after pulling (`chrome://extensions`)
- [ ] Run `compileProfile.ts` once and **review** `backend/data/master-profile.json` before relying on bullet selection
- [ ] Set `CHROME_PATH` in `.env` if Chrome is not in the default Windows path

## Config (`.env`)

```
RESUME_DIR=./data/resumes
CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
MASTER_PROFILE_PATH=./data/master-profile.json
WORK_EXPERIENCE_DIR=../work-experience
```
