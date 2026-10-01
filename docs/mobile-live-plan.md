# Mobile go-live plan: LinkedIn scan → tailored résumé → assisted apply, from the phone

Status: Phases 0, 1 and 2 shipped; Phase 3 is the open decision. Builds on `phone-first-funnel.md` (2026-08-26) and `apply-assist-spec.md`.

## 1. Goal and constraints

| | Target |
|---|---|
| Discovery | LinkedIn SDE postings from the past 24 h, using the user's logged-in session, every 1–2 h |
| Tailoring | Capture the JD, produce a tailored résumé from the bullet pool automatically |
| Apply | Fill every field the bot can fill; the user makes the decisions from the phone |
| Window | Weekdays 07:00–17:00 (America/New_York) |
| Cost | ≈ $0. Only variable cost is DeepSeek; everything else stays on free tiers |
| Boundary (unchanged) | No CAPTCHA solving, no account creation, no EEO/self-ID answers, no submit without a per-application human decision |

## 2. What already exists (don't rebuild)

| Need | Existing piece | Gap |
|---|---|---|
| LinkedIn scan on the user's session | `extension/background.js` auto-scan: `chrome.alarms`, unfocused window in the user's Chrome profile, 3 pages × 25 cards, `POST /scan/report` | Interval is 210 min ± 20 with 23:00–08:00 quiet hours. Needs 90 min, weekday 07–17 window, catch-up scan at 07:00 |
| Rate-limit safety | `scan/controller.js` (jitter, pool 3, JD fetch stops after 5 fails, 20 cards unattended), `jdBackfill.ts` fills missing JDs server-side via the guest API | None. Keep as is |
| Score + tailor | `/scan/report` → triage → `resumePipeline.ts` auto-tailors at `RESUME_AUTO_THRESHOLD` 0.7 → DOCX + one-page PDF in `backend/data/resumes/` | No daily cap or spend meter |
| Notify | Slack high-score push at 0.78 (`highScoreNotify.ts`) | No deep link to the job on the phone dashboard |
| Phone access | Tailscale + `ACCESS_TOKEN` + PWA manifest; `.env` already has `HOST`, `ACCESS_TOKEN`, `PUBLIC_URL` (phone-first Phase 0 done) | Dashboard has no mobile breakpoint; no "batch" view |
| Apply fill | `applyEngine.js` e17 (Greenhouse / Lever / Ashby), stream mode, answer bank, submit snapshot, Copilot panel; `easyApply.js` fills LinkedIn Easy Apply to the Review step | Fill only happens when I open the tab on the desktop. Nothing pre-fills ahead of me, and nothing lets the phone see or finish a filled form |
| Keep PC awake | `scripts/keep-awake-tray.ps1` + 09:00 scheduled task, backend + Postgres auto-start tasks, watchdog | Starts at 09:00 not 07:00; Chrome is not auto-launched, and `chrome.alarms` only fire while Chrome is running |

## 3. Target architecture

```
07:00 weekday                                   phone (PWA over Tailscale)
 +- Task Scheduler: wake PC, keep-awake, launch Chrome (the user's profile)
 |
 +- every 90 min 07:00-17:00 - extension auto-scan --+
 |    07:00 run: past 24 h, 3 pages (catch-up)       |
 |    later runs: past 3 h, 1-2 pages                |  POST /scan/report
 |                                                   v
 |   backend ---- triage (DeepSeek, cheap) -- ingest -- score
 |                    |
 |                    +- >=0.70 & fresh & under daily cap -- tailor -- PDF/DOCX
 |                    |
 |                    +- >=0.78 -- Slack card -- deep link ----------> "Review" on phone:
 |                    |                                                 JD, fit, resume preview,
 |                    |                                                 Skip / Queue for apply
 |                    +- queued & ATS supported -- PREFILL-AHEAD (desktop Chrome, background tab)
 |                          fill from bank + profile, attach PDF, stop before Submit,
 |                          snapshot fields + screenshot -------------> "Ready" on phone:
 |                                                                      filled N/M, open questions;
 |                                                                      the user answers them (auto-banked)
 |                                                                      [Approve submit] / [Tonight]
 +- 17:00: release keep-awake; Chrome stays open, alarms idle until next weekday
```

Two hard rules carry over: the bot never types a guess into a sensitive or EEO question, and a Submit click happens only after the user taps Approve for that specific application (Phase 3, see §7).

## 4. Phases

### Phase 0 — configuration only (half a day, no code)

1. Saved LinkedIn search URL for auto-scan: SDE keywords, target geo, `f_TPR=r86400`, `f_WT` as wanted. Store via popup → auto-scan settings.
2. Keep-awake task: trigger 07:00 instead of 09:00; `-Until 17:00` already right. Add a second scheduled task at 06:58 that launches Chrome with the user's profile (`chrome.exe --profile-directory="Default" --no-startup-window`) so alarms fire.
3. Confirm phone Phase 0 from `phone-first-funnel.md`: Tailscale up on both devices, PWA installed, Share-sheet shortcut hits `/captures/from-url`.
4. Verify unattended behaviour with the PC locked: alarm fires, scan reports, PDF renders. (Windows may throttle a locked session; if the scan stalls, turn the display off without locking via the tray app instead.)

Acceptance: 24 h of `scan_runs` rows at the expected times without touching the PC.

### Phase 1 — cadence + phone review surface (1–2 days)

Extension (`background.js`):
- Replace quiet hours with an **active window**: weekdays 07:00–17:00 local, configurable. Outside it the alarm re-arms to the next window start.
- Interval default 90 min (jitter ± 10). First run of the day scans past 24 h / 3 pages; subsequent runs rewrite `f_TPR` to elapsed interval × 2 (≈ `r10800`) and scan 1–2 pages. Roughly halves LinkedIn requests per day while missing nothing.
- Emit a Slack nudge via the existing `scanWatch.ts` staleness check if no scan lands within 2× the interval during the window (Chrome closed, logged out, wall hit).

Backend:
- Slack deep links `{PUBLIC_URL}/#job=<id>` (phone-first Phase 1 item 2).
- `TAILOR_DAILY_CAP` (default 12) and a `/admin/spend` meter (calls, tokens, est. cost per day) so cost is visible, not assumed.

Dashboard:
- ≤640 px breakpoint, 44 px targets, sticky bottom action bar (phone-first Phase 1 item 1).
- "Review" list = fresh ≥0.78 with résumé status; actions Skip / Queue for apply / Regenerate.

Acceptance: from the phone only, the user can triage a day's finds in ≈10 minutes and every queued job has a résumé ready.

### Phase 2 — prefill-ahead (2–4 days)

Goal: when the user opens a queued job on the phone, the form is already filled on the desktop.

- New stream mode `unattended` in `applyStream.ts`: for queued jobs on Greenhouse / Lever / Ashby, the extension opens the apply URL in the background window, runs the normal fill pipeline (bank + profile + heuristics; LLM stays opt-in), attaches the PDF, and stops at the same point it stops today.
- It then posts an `apply_prefill` record: per-field filled / skipped / needs-human, screenshot of the form (reuse `applyDebug` screenshots), and keeps the tab parked (cap 5 parked tabs, 12 h TTL like streams).
- Phone "Ready" card shows the field table and the open questions as inputs. Submitting an answer calls `/profile/bank-answers`, then the parked tab re-runs fill for that field.
- Failure modes stay fail-soft: branded boards that redirect, CAPTCHA, login walls → card says "needs desktop", batched for the evening like today.

Acceptance: ≥80 % of queued GH/Lever/Ashby jobs show "all fields filled, 0–2 questions" on the phone before the user looks at them.

### Phase 3 — remote approve (decision, ~1 day)

Today the engine never clicks Submit; the user does. On the phone they can't reach the desktop tab, so the choice is:

- **A. Remote-approve Submit.** Phone shows the final snapshot; the user taps **Approve** for that one application; the parked tab clicks Submit, waits for the confirmation (existing language-agnostic detection), records the submit snapshot. One tap = one submit, never batch-approved, never on a form with unanswered required questions. This moves the click, not the decision.
- **B. Chrome Remote Desktop / RDP from the phone**, zero code: the user clicks Submit on the parked tab. Clunky on a phone but fully manual.

Recommendation: use B immediately (free, needs nothing), implement A only after Phase 2 has run a week clean. LinkedIn Easy Apply joins A last, because it carries the account-restriction risk in §6.

## 5. Cost model

| Item | Cost | Control |
|---|---|---|
| LinkedIn scan (the user's session) | $0 | request volume ≈ 7 scans × (1–3 pages + ≤20 JD fetches) per day |
| ATS polling, guest JD backfill, Slack, Tailscale, PWA | $0 | free tiers / self-hosted |
| DeepSeek triage | cents/day | already the cheap model; batched per scan |
| DeepSeek tailoring | the only meaningful line | `TAILOR_DAILY_CAP`, threshold 0.70, spend meter. **$0 option**: point `DEEPSEEK_BASE_URL` at a local OpenAI-compatible server (Ollama / LM Studio) for tailoring, keep DeepSeek for triage. Measure quality on 5 known JDs before switching |
| Screening answers via LLM | ≈ $0 | opt-in per question, banked forever |
| JSearch / Adzuna | $0 | stay under free tiers (~4/day and 250/day) |
| PC on 07–17 | electricity | already the case for the backend |

Rule: no new paid service. Anything new must fit in the DeepSeek line or run locally.

## 6. Risks

1. **LinkedIn account restriction.** Scripted browsing on a logged-in account is against LinkedIn's user agreement, and live runs hit a "trusted-click wall". Mitigations: keep the human-like pacing in `controller.js`, 7 scans/day max, JD fetch capped at 20 unattended, no Easy Apply automation until Phase 3, and a kill switch (`autoScanEnabled` off from the popup, plus a `/admin/scan/pause` endpoint reachable from the phone). Accept that the account can still get a checkpoint; the guest API + ATS polling keep discovery alive if it does.
2. **Wrong submit.** Only Phase 3A can cause one; guard with per-application approval, required-field check, and the existing snapshot diff.
3. **Locked-screen throttling / Chrome not running.** Covered by the 06:58 launch task and the staleness nudge.
4. **Spend creep.** Cap + meter, and the existing rule that the notify threshold never changes spend.
5. **Focus stealing while the user is on the PC.** Auto-scan already opens unfocused windows; prefill tabs must too.

## 7. Open decisions

- Phase 3: allow remote-approved Submit (A), or stay manual via remote desktop (B)?
- Include LinkedIn Easy Apply in prefill-ahead at all, given risk 1?
- Try a local model for tailoring to reach true $0, or accept a capped DeepSeek line?
- Daily tailor cap value (proposal: 12) and target apps/week (phone-first spec says 5–10).

## 8. Metrics (dashboard "Today" strip)

new jobs/day · ≥0.78/day · résumés generated/day · prefilled-ready/day · submitted/week · DeepSeek $/day · last scan age.
