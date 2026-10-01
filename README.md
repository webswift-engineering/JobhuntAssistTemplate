# Job Hunt Assistant

A single-user, **localhost-only** tool that keeps *you* on the decisions only a human can make
(apply / skip, final submit, going where bots are blocked) and hands every mechanical task to the bot:
polling ATS endpoints, deduping, state-tracking, relevance ranking, drafting parser-safe tailored
resumes, recommending keywords, and pinging you the moment a fresh high-match job appears.

> **Core principle — the human/bot boundary**
>
> | Bot does (zero human effort) | Human does (and only this) |
> |---|---|
> | Poll ATS on schedule, capture pages it can't reach (via your browser), dedup, track state, rank by relevance, draft resume/cover letter, recommend keywords, notify, record progress, pre-fill apply forms for your review (`/apply` skill — see `docs/apply-assist-spec.md`) | Decide apply/skip · **final submit** (login, CAPTCHAs, EEO questions) · review pre-filled forms + drafted screening answers · approve tailored resume · go where the bot is blocked |

> **About this repository.** This is the public, scrubbed version of the tool I run every day.
> My private instance also carries my own work-experience corpus, master profile, application
> history and per-company résumé scripts; none of that is here. Everything needed to run it
> with *your* data is — see [Bring your own profile](#bring-your-own-profile).

## What's inside

```
backend/     Node + TS + Express + SQLite. ATS adapters, scheduler, LLM services, REST API.
dashboard/   Vite + vanilla TS. One-tab review queue, apply view, referrals, companies, profile.
             Doubles as the phone app (Tailscale + Add to Home Screen).
extension/   Chrome MV3. Passive capture from Indeed / LinkedIn while you browse.
             applyCore.js (the fill logic) is shared with the phone — see below.
docs/        Specs and design notes (apply assist, phone-first funnel, résumé tailoring).
work-experience/
             Your raw career corpus for the optional compile step. Gitignored except the
             README template and compile-config.example.json.
```

Two capture paths, kept strictly separate:

- **Path A — ATS polling** (automated, backend scheduler). Recorded in `poll_runs` for progress/history.
- **Path B — Extension capture** (only while you browse; *never* touches `poll_runs`).
- **Path C — Daily discovery** (JSearch + Adzuna). Broader market search for your keyword in US/CA, last 24h. Recorded in `discovery_runs`; jobs land in the same queue with `source_kind=discovery`.

## Quick start

### 1. Backend (required)

```bash
cd backend
npm install
copy .env.example .env      # (Windows)  ·  cp .env.example .env (mac/linux)
npm run dev                 # serves http://127.0.0.1:8787, runs schema, starts scheduler
npm test                    # vitest (52 tests)
```

The backend works **with no API key** — relevance scoring, resume tailoring, referral extraction,
and keyword suggestions all fall back to transparent heuristics. Add `DEEPSEEK_API_KEY` to `.env`
to upgrade those to LLM-quality.

### 2. Dashboard

```bash
cd dashboard
npm install
npm run dev                 # http://127.0.0.1:5173 (dev, hot reload)
```

For local dev the Vite server on `:5173` talks to the backend on `:8787`. For everyday
use (and to reach it from other devices — see below), build it once and the **backend
serves it** on its own port:

```bash
cd dashboard
npm run build               # → dashboard/dist, served by the backend at http://127.0.0.1:8787
```

Set your **profile** (master resume + target titles/keywords) first — preferences drive relevance
scoring, the master resume drives tailored drafts.

### 3. Chrome extension

No build step. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
select the `extension/` folder. Then browse Indeed / LinkedIn normally — jobs and
referral leads flow into the backend automatically; cards get state badges (🆕 👁 ✅ 🚫 ⭐).

The same unpacked extension runs on **Android** in an extension-capable Chromium browser —
see *Applying from your phone* below.

## How the pieces map to the problems

- **Speed (P1):** scheduler polls ATS **hourly Mon–Sat** → ingest → score → **one Slack ping per poll** when new ATS jobs have match **> 0%**. Career pages (FAANG+) polled on the same schedule. Every run logged in `poll_runs`.
- **Coverage (P2):** server-side ATS adapters (Greenhouse, Lever, Ashby, Workday) + **daily JSearch/Adzuna discovery** (`software engineer`, US + CA, last 24h) + extension capture
  for aggregators + **referral leads** pasted from community forums the ATS path can't produce.
- **Overload (P3):** dedup + state machine (system owns memory) + LLM relevance ranking + keyword
  recommendations + **guardrailed, parser-safe tailored resume drafts** + in-page applied/skipped masking.

## Safety constraints

- **No auto-submit** — submission is always human (login, forms, anti-bot, integrity).
- **Resume tailor never fabricates** — it may only re-emphasize/reorder/rephrase content already in
  your master resume. Missing JD keywords are *reported*, never injected (enforced + unit-tested).
- **Single-user.** Secrets live only in `.env`. By default the app binds to `127.0.0.1` with no
  auth (localhost only). To reach it from other devices, set `ACCESS_TOKEN` — the server **refuses
  to bind to a non-loopback host without one** (see *Access from your other devices* below). Treat
  captured page text as sensitive.

## Access from your other devices (iPad / phone / other PC)

The backend serves the dashboard directly, so there's a single URL for every device. The
recommended setup keeps everything on this PC and reaches it privately over
[Tailscale](https://tailscale.com) (free, nothing exposed to the public internet). Your
Windows-local features — PDF rendering, "open folder", and the extension — keep working.

1. **Build the dashboard** so the backend can serve it:
   ```bash
   cd dashboard && npm run build
   ```
2. **Generate an access token** and put it in `backend/.env`:
   ```bash
   cd backend && npm run gen-token       # copy the output
   ```
   ```ini
   # backend/.env
   HOST=0.0.0.0
   ACCESS_TOKEN=<paste the generated token>
   PUBLIC_URL=http://<this-pc>.<tailnet>.ts.net:8787
   ```
3. **Install Tailscale** on this PC and on your iPad / phone / other PC, all signed into the
   same account. Find this PC's name/IP in the Tailscale app (MagicDNS name like
   `your-pc.tailnet.ts.net`, or a `100.x.y.z` address).
4. **Restart the backend** (`npm run dev`). It now listens on all interfaces with auth on.
5. On any device, open `http://<this-pc>.<tailnet>.ts.net:8787`, enter the token once, and
   you're in. On iPad/iPhone → Share → **Add to Home Screen** for an app-like icon.

> Auth is a signed-in cookie (valid ~1 year per device). Sign out at `/logout`. Requests to the
> API also accept `x-access-token`/`Authorization: Bearer` headers or a one-time `?token=` query.

**Chrome extension on your other PC:** open the popup → **⚙ Backend settings**, set the Backend
URL to your Tailscale URL and paste the same token, then **Save & test**. The same settings work
on Android in an extension-capable Chromium browser (see *Applying from your phone* below); on
iPad/iPhone you use the dashboard plus the fill-script Shortcut.

### Capturing a job on iPad / phone (no extension)

The extension only runs on desktop Chrome. On other devices, capture a job two ways:

- **Dashboard → Captures → "＋ Paste a job"**: paste the job URL and tap **⤓ Fetch from URL**.
  For Greenhouse, Lever, Ashby (and any site with schema.org `JobPosting`) it auto-reads the
  title, company, location, salary, and full description and captures it. If the site is
  JS-only/blocked (Indeed, LinkedIn), copy the description off the page and paste it in, then
  **＋ Capture job**. Either way the job lands in the queue, gets scored, and is ready to tailor.

- **iOS Share-Sheet Shortcut** (one tap from Safari). Build once in the **Shortcuts** app:
  1. New Shortcut → turn on **Show in Share Sheet**; set *Accept* to **URLs** (and *Safari web pages*).
  2. Add **Get URLs from Input**.
  3. Add **Get Contents of URL**:
     - URL = the *URL* from step 2 (Shortcuts input)
     - Method = **POST**, Request Body = **JSON**
     - Header: `x-access-token` = your `ACCESS_TOKEN`
     - JSON field: `url` (Text) = the URL from step 2
     - Point it at `http://<this-pc>.<tailnet>.ts.net:8787/captures/from-url`
       (Shortcuts aren't subject to browser mixed-content rules, so the Tailscale `http://` URL is fine.)
  4. (Optional) Add **Show Notification** with the response so you see "captured" vs "needs review".

  Then from any job page in Safari: **Share → your shortcut**. It captures clean ATS/JSON-LD
  postings instantly; for sites it can't read, open the dashboard and paste the description.

### Applying from your phone

Full design: [`docs/phone-apply-design.md`](docs/phone-apply-design.md).

Which path you get depends on the platform. Either way you still review every
field and tap Submit yourself.

#### Android — run the extension (recommended)

Chrome for Android has no extensions, but Chromium forks do, and this gets you
the *full* desktop behaviour: autofill, reliable résumé attach, auto-record after
Submit, answer banking, and stream batch mode.

1. Zip the extension with `manifest.json` at the archive root:
   ```powershell
   Compress-Archive -Path extension\* -DestinationPath jobcapture.zip -Force
   ```
2. Install **[Quetta](https://play.google.com/store/search?q=quetta%20browser)** or
   **Lemur** from the Play Store — both sideload a local `.crx`/`.zip`, which is
   what you need since this extension isn't in the Chrome Web Store. (Kiwi
   Browser did this for years but shut down in January 2025.)
3. Move the zip to the phone and install it from the browser's extensions page.
4. Extension popup → **⚙ Backend settings** → Backend URL = your Tailscale URL,
   paste the same `ACCESS_TOKEN` → **Save & test**.
5. Open the dashboard in that browser → Add to Home Screen.

Then: a job → **Apply ▸** → **Open the form ▸** → it fills → review → Submit. It
records itself.

Not available on Android (no touch equivalent): the Apply Copilot side panel,
page context menus, and the auto-scan window. The dashboard's tap-to-copy chips
cover what the side panel did; use the dashboard's server-side LinkedIn scan
instead of the auto-scan window.

#### iOS — the fill-script Shortcut

Safari web extensions need a Mac, Xcode and a paid developer account, so instead
the backend serves the *same* fill engine as one self-contained script and an iOS
Shortcut injects it with Safari's **Run JavaScript on Web Page**. Same field
detection, same heuristics, same hard boundary. (This also works on stock Chrome
for Android and Samsung Internet if you'd rather not install another browser.)

Build the Shortcut once (Settings → Shortcuts → **Allow Running Scripts** must be on;
turn on **Show in Share Sheet**, accept *URLs* and *Safari web pages*):

1. **Get URLs from Input**
2. **Get Contents of URL** → `http://<this-pc>.<tailnet>.ts.net:8787/apply/fill-script?url=<the URL from step 1>`
   with header `x-access-token` = your `ACCESS_TOKEN`
3. **Run JavaScript on Web Page** (input = Shortcut Input):
   ```js
   new Function("done",decodeURIComponent("<Contents of URL from step 2>"))(completion);
   ```
4. **Show Result** — the summary of what was filled and what's left for you

Then: dashboard → a job → **Open the form ▸** → **Share → JobHunt Fill** → review →
Submit → tap **✓ I submitted** in the fill sheet to record it.

Works on Greenhouse, Lever and Ashby hosted forms (the boards with adapters in
`extension/applyAdapters.js`). For Workday / LinkedIn / custom career sites the
apply sheet shows **tap-to-copy chips** for your contact fields and every banked
screening answer instead. Set `PUBLIC_URL` — the "✓ I submitted" link points at it.

> The résumé attach is best-effort on iOS (Safari doesn't guarantee programmatic
> file-input assignment). When it fails the sheet says so and links the PDF —
> add a **Get Contents of URL** + **Save File** step to the Shortcut to keep a
> copy in *Files ▸ JobHunt* so the picker is two taps.

- **Scan a whole LinkedIn search** (the desktop "Scan this list", server-side). Dashboard →
  Captures → **"⌕ Scan a LinkedIn search"**: run a Jobs search in LinkedIn, copy its URL, paste it
  in and tap **Scan**. The backend re-runs the search via LinkedIn's public *guest* API (no login),
  fetches each JD, triages every result against your profile, and adds the strong/maybe matches to
  your queue — sorted by fit. Works from iPad/phone with no extension.

**Prefer a public https URL instead of a VPN?** Run a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-tunnel/)
to `http://127.0.0.1:8787`, keep `HOST=127.0.0.1`, set `PUBLIC_URL` to the tunnel domain and
`COOKIE_SECURE=1`. The same `ACCESS_TOKEN` login protects it.

## Auto-start on Windows

The backend auto-starts at logon via the Scheduled Task **"JobHuntAssist Backend"**
(current user, no stored password, restarts up to 3× on failure). It runs
`backend/scripts/start-server.cmd` invisibly (via `start-server-hidden.vbs`), which runs
`npm run start` and appends output to `backend/logs/server.log`.

**Database:** the jobhunt PostgreSQL instance (127.0.0.1:5434, data dir `backend/data/pg`,
PG 17, not a Windows service) is auto-started by these same scripts: `start-server.cmd`,
the watchdog, and the restart script all `pg_ctl start` it if 5434 isn't accepting
connections. Its server log is `backend/logs/postgres.log`.

**Server down? Double-click "Restart JobHunt Server" on the Desktop.** It runs
`backend/scripts/restart-server.cmd`, which stops the task, frees port 8787, restarts,
and confirms `/health` in a visible console window.

**Watchdog:** the Scheduled Task **"JobHuntAssist Watchdog"** runs `backend/scripts/watchdog.ps1`
(hidden) every 5 minutes. If `/health` on port 8787 answers 200 — including a manually-run
`npm run dev` server — it does nothing. Otherwise it kills any hung port-8787 owner,
starts the backend task, and logs one line to `backend/logs/watchdog.log`.

**Developing with `npm run dev`?** Stop the background instance first (it holds port 8787):

```powershell
Stop-ScheduledTask -TaskName "JobHuntAssist Backend"
Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

When done developing, start it again: `Start-ScheduledTask -TaskName "JobHuntAssist Backend"`.
Disable/enable auto-start entirely: `Disable-ScheduledTask` / `Enable-ScheduledTask -TaskName "JobHuntAssist Backend"`.
(If the task fires while a dev server holds the port, it fails and gives up after 3 retries — harmless.)
A running dev server on 8787 already satisfies the watchdog, but if you want the port left
free for a long dev session with the managed server stopped, also run
`Disable-ScheduledTask "JobHuntAssist Watchdog"` (re-enable it afterwards).

## Configuration (`backend/.env`)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | API port |
| `DEEPSEEK_API_KEY` | — | enables LLM services (optional) |
| `DEEPSEEK_MODEL` | `deepseek-chat` | model |
| `POLL_CRON` | `0 * * * 1-6` | ATS poll cadence (hourly, Mon–Sat) |
| `TZ` | `America/New_York` | scheduler timezone |
| `ROUTINE_CRON` | `0 9 * * 1-6` | morning browse reminder (Slack) |
| `ROUTINE_EVENING_CRON` | `0 18 * * 1-6` | evening browse reminder (Slack) |
| `NOTIFY_THRESHOLD` | `0.7` | min score to notify |
| `SLACK_WEBHOOK_URL` | — | Slack incoming webhook (else logs to console) |
| `DASHBOARD_URL` | `http://localhost:5173` | deep-link target in notifications |
| `DISCOVERY_ENABLED` | `1` | daily JSearch + Adzuna sweep |
| `DISCOVERY_CRON` | `0 8 * * *` | discovery schedule (daily 8 AM in `TZ`) |
| `DISCOVERY_QUERY` | `software engineer` | search keyword |
| `DISCOVERY_MAX_DAYS_OLD` | `1` | Adzuna max age (days) |
| `JSEARCH_API_KEY` | — | RapidAPI key for JSearch (or `RAPIDAPI_KEY`) |
| `JSEARCH_DATE_POSTED` | `today` | JSearch recency filter |
| `JSEARCH_COUNTRIES` | `us,ca` | JSearch country codes |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | — | Adzuna API credentials |
| `ADZUNA_COUNTRIES` | `us,ca` | Adzuna country codes |
| `SALARY_FLOOR_HYBRID_CAD` / `SALARY_FLOOR_REMOTE_CAD` | off | optional salary floor; known below-floor jobs leave the queue and never notify |

## Daily discovery (JSearch + Adzuna)

Once per day (default **8:00 AM** in `TZ`), the backend searches **“software engineer”** in **US and Canada** with jobs posted in the **last 24 hours**. Results merge into the same job queue as ATS polls (filter: **Discovery** in the dashboard).

1. **JSearch** — sign up at [RapidAPI JSearch](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch), copy your key → `JSEARCH_API_KEY` (free tier ~200 requests/month; default config uses ~4/day).
2. **Adzuna** — register at [developer.adzuna.com](https://developer.adzuna.com/signup) → `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` (free tier 250 requests/day).
3. Restart the backend, then trigger a manual run:
   ```bash
   curl -X POST http://127.0.0.1:8787/admin/discovery-now
   ```
4. Check status: `GET /health` (`discovery` block) or `GET /discovery-runs`. Dashboard header shows last discovery run.

New discovery jobs are scored automatically. Slack gets **one batched message per run** for jobs with match **> 0%** (same freshness/region rules as ATS).


Fresh ATS jobs with match **> 0%** trigger **one batched Slack message per poll** (not per job).
Jobs scoring exactly **0%** do not ping. Set `SLACK_WEBHOOK_URL` in `.env` and restart.

1. Create a Slack **Incoming Webhook**: https://api.slack.com/apps → *Create New App* → *From scratch*
   → **Incoming Webhooks** → *Activate* → *Add New Webhook to Workspace* → pick a channel → copy the URL.
2. Set `SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...` in `backend/.env` and restart.
3. Test it end-to-end without waiting for a real match:
   ```bash
   curl -X POST http://127.0.0.1:8787/admin/test-notify
   ```
   Returns `{ "channel": "slack" }` and posts a test message. With no webhook set it falls back to
   `{ "channel": "console" }` and logs the notification to the backend terminal.

## Resume tailoring (right-click capture → DOCX + PDF)

Full spec: [`docs/resume-tailoring-spec.md`](docs/resume-tailoring-spec.md) · Progress: [`docs/resume-tailoring-progress.md`](docs/resume-tailoring-progress.md)

1. **Reload** the unpacked extension — right-click any job page → **Capture this job**.
2. In the dashboard **Apply** modal → **Generate résumé** — writes to `backend/data/resumes/<slug>/`.
3. Download **DOCX / PDF / TXT** or **Open folder** (Windows Explorer, localhost only).

| Endpoint | Method | Purpose |
|---|---|---|
| `/page-captures` | POST | Extension / curl JD capture |
| `/jobs/:id/generate-resume` | POST | Tailor + write TXT, DOCX, PDF, cover-letter, `job.json` |
| `/jobs/:id/resume` | GET | List artifacts + folder path |
| `/jobs/:id/resume/file?format=docx\|pdf\|txt` | GET | Download file |
| `/jobs/:id/open-folder` | POST | Open résumé folder (localhost only) |
| `/apply/fill-script?url=…` | GET | Self-contained autofill script for the phone (iOS Shortcut) |

### Bring your own profile

1. Copy `backend/master-profile.example.json` to `backend/data/master-profile.json` and fill in
   your contact details, skills and curated experience bullets. This file is gitignored and is
   the only source the tailor may draw from — it never invents content.
2. Optional, for a richer bullet pool: drop raw material (project notes, old résumés, design
   docs) under `work-experience/<employer>/` following
   [`work-experience/README.md`](work-experience/README.md), copy
   `work-experience/compile-config.example.json` to `compile-config.json` to declare employer
   aliases and internal codenames to translate, then compile:

   ```bash
   cd backend && npx tsx src/profile/compileProfile.ts   # → data/master-profile.json (review before use)
   ```

   The compile step is add-only and deduplicated, and backs up the master profile first.

| Var | Default | Purpose |
|---|---|---|
| `RESUME_DIR` | `./data/resumes` | per-job artifact folders |
| `CHROME_PATH` | `C:\Program Files\Google\Chrome\Application\chrome.exe` | PDF rendering |
| `MASTER_PROFILE_PATH` | `./data/master-profile.json` | structured bullet corpus (overrides pasted resume when present) |

## Adding an ATS company

Dashboard → **Companies** tab → add name, ATS type, and board token (the company slug).
Workday tokens are packed as `host|tenant|site`, e.g.
`https://acme.wd1.myworkdayjobs.com|acme|External`. Then **Poll now** (or wait for the schedule).
