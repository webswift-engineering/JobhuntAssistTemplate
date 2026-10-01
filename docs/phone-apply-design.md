# Phone-first apply — design (2026-08-28)

Extends [`phone-first-funnel.md`](phone-first-funnel.md), which moved *triage* to
the phone. This one answers the part that doc left open: **how do you actually
fill and submit an application from a phone**, given the autofill engine is a
Chrome extension and the phone can't run one.

## The problem, precisely

The pipeline already ends on the phone — Slack pings arrive there all day. Every
step *after* the ping needs the PC:

| Step | Where it works today | Why |
|---|---|---|
| See the ping | phone ✅ | Slack |
| Read the job, decide apply/skip | phone ⚠️ | dashboard reachable over Tailscale, but desktop-first CSS |
| Tailor the résumé | phone ✅ | server-side; the phone just triggers it |
| **Fill the form** | **PC only** ❌ | `applyEngine.js` is a Chrome MV3 content script |
| Submit | PC only ❌ | follows the fill |
| Record it | PC only ❌ | the extension posts it |

So the ping lands during the workday and the work happens at night, at whatever
energy is left. The fix is not "a better notification" — the notification is
fine. It is to make the three blocked rows work on a phone.

## Two paths, because the platform decides

**On Android, just run the extension.** This is the recommended path and it is
strictly better than everything else in this document, because it is the same
code desktop runs. Chrome for Android has never supported extensions, but
Chromium forks do: Kiwi carried this for seven years and shut down in January
2025; **Quetta** and **Lemur** replaced it. Lemur and Quetta both sideload a
local `.crx`/`.zip`, which matters here — this extension isn't in the Chrome Web
Store, so a browser that only installs from the store is no help.

Android gets the *full* feature set: auto-record after Submit, answer banking,
reliable résumé attach (it's Chromium, so `DataTransfer` works), and stream mode
chaining a batch through one tab. What it loses is only what has no touch
equivalent — the side panel, page context menus, and the auto-scan window, all
now guarded so the service worker still boots (see "Android compatibility"
below).

**On iOS, use the Shortcut.** Safari supports web extensions, but shipping one
needs Xcode, a Mac, a $99/yr Apple Developer account and store review, for a
single-user tool. So iOS gets the fill-script path below, which also covers
stock Chrome for Android, Samsung Internet, and any browser without extension
support.

### Rejected outright, on every platform

**Proxy the ATS form through our own server.** Breaks the form (React bundles,
same-origin XHR, anti-bot), and rewriting someone's application form to serve it
from our host is exactly the kind of thing the human/bot boundary exists to
avoid.

**Render our own form from the ATS's question schema and POST it.** Greenhouse,
Lever and Ashby all expose the schema. But submitting it programmatically *is*
auto-submit — the thing the README forbids, for good reasons (anti-bot, terms,
integrity). Off the table.

**A bookmarklet.** Works in iOS Safari and Chrome for Android, but a bookmarklet
is static text and can't fetch our backend: the ATS's `connect-src` blocks it
and, on an `https` page, so does mixed-content blocking. There's nowhere to put
the profile.

## The no-extension path: iOS Shortcuts as the content script

Safari's share sheet can run a Shortcut, and Shortcuts has **Run JavaScript on
Web Page** — arbitrary JavaScript in the page context of the current Safari tab.
That is the iOS equivalent of a content script, and it's the whole unlock.

The one constraint is that the JS field is static text. But the Shortcut *can*
fetch text over HTTP first and pass it in, and Apple's documented pattern for
that is `new Function(decodeURIComponent(…))`. So instead of the script fetching
its data, **the server ships the script and the data already fused together**:

```
Safari (ATS form) ──Share──▶ Shortcut "JobHunt Fill"
                                │
                                │ 1. Get URLs from Input          → the form's URL
                                │ 2. Get Contents of URL          → GET {BASE}/apply/fill-script?url=…
                                │       header x-access-token          (adapters + core + driver
                                │                                       + this job's data, URL-encoded)
                                │ 3. Run JavaScript on Web Page
                                │       new Function("done",decodeURIComponent("«step 2»"))(completion)
                                ▼
                        the form fills in place; a bottom sheet reports what's left
                                │
                        human reviews · attaches résumé if needed · taps Submit
                                │
                        taps "✓ I submitted" → dashboard records it
```

Nothing is fetched at run time, because nothing *can* be: the ATS page's
`connect-src` blocks our host. This is the same wall that made the desktop
engine proxy every request through the extension's background worker
(`applyEngine.js`, the `bg()` comment). On the phone there is no worker, so the
data travels inside the script.

### Why the fill logic isn't duplicated

`applyEngine.js` was 830 lines of two different things. The DOM half — label
resolution, the never-guess rules, geo-suggest candidate ordering, the combobox
click recipe, the submit snapshot — is where every hard-won heuristic lives, and
none of it is Chrome-specific. The Chrome half is backend I/O, the status bar,
stream controls and recording.

That split is now literal:

```
extension/applyAdapters.js   per-ATS selectors and regexes (data only)
extension/applyCore.js       the DOM half — no chrome.*, no network        ◀── shared
extension/applyEngine.js     desktop: background worker, stream, recording
extension/mobile/fillDriver.js  phone: bottom sheet, deep links, no network
backend/src/apply/fillScript.ts  concatenates adapters + core + driver + payload
```

`backend/test/applyCore.test.ts` (19 tests) pins the shared heuristics against
jsdom forms shaped like real Greenhouse and Ashby markup;
`backend/test/fillScript.test.ts` (11 tests) runs the assembled script through
the exact `new Function("done", …)` wrapper Shortcuts uses, so a bad
concatenation fails in CI rather than on a phone.

### What each path gives up

| | Desktop extension | Android extension | iOS shortcut |
|---|---|---|---|
| Fill text, selects, comboboxes, yes/no | ✅ | ✅ | ✅ same code all three |
| Never touch EEO / guess sensitive answers | ✅ | ✅ | ✅ |
| Attach the tailored résumé | ✅ `DataTransfer` | ✅ Chromium | ⚠️ attempted; `input.files` assignment isn't guaranteed on iOS |
| Auto-record after Submit | ✅ | ✅ | ❌ one tap ("✓ I submitted" → `/?applied=<id>`) |
| Bank the human's answers at submit | ✅ | ✅ | ❌ next desktop session picks it up |
| Ask the LLM about an unanswered question | opt-in | opt-in | ❌ needs a live call — do it on the queue card first |
| Chain a batch through one tab | ✅ stream mode | ✅ | ❌ one job per share-sheet run |
| Posting page → form navigation | automatic | automatic | the sheet links to the form; re-run there |
| Apply Copilot side panel (Workday, LinkedIn) | ✅ | ❌ no side panel API — the dashboard's copy chips cover it | ❌ same |
| Page context menus / auto-scan window | ✅ | ❌ no touch context menu, single window | ❌ |

Android is desktop minus the side panel. iOS is a real step down, so every gap
degrades loudly rather than silently — the résumé attach in particular says so
and links the PDF when it fails.

### Android compatibility

One thing had to change for the extension to work on Android at all:
`background.js` registered `chrome.contextMenus.onClicked` and
`chrome.alarms.onAlarm` at the top level of the service worker. On a build
without those APIs that throws *during worker startup*, which takes down the
whole extension — including the backend proxy every content script goes through,
so autofill dies with it and the only symptom is "nothing happens".

Optional APIs now go through an `onOptional()` guard, so desktop-only features
skip registration instead of crashing the worker. Covered by
`backend/test/extensionAndroid.test.ts`, which boots `background.js` in a `vm`
against a `chrome` object holding only what Android provides — and asserts the
desktop features still register when the APIs are present.

Also phone-shaped: the in-page status bar becomes a full-width bottom sheet
below 640px (a 440px corner card is unreadable and lands under the ATS's sticky
header), and the stream controls get 44px touch targets.

### Boards with no adapter

Workday, LinkedIn and custom career sites have no fill adapter, on any device.
For those the dashboard's apply sheet shows **tap-to-copy chips** — contact
fields plus every banked screening answer, one tap each. The human still types,
but never has to remember or re-derive an answer. This is the phone port of the
desktop Copilot panel's model, and it degrades to something useful on *any*
site.

`navigator.clipboard` needs a secure context and the recommended remote setup is
Tailscale over plain `http`, so the copy helper falls back to `execCommand` with
the iOS selection dance — the phone is precisely where the modern API is
missing.

## The loop this produces

| When | Device | Action |
|---|---|---|
| Commute | phone | Slack ping → `?job=<id>` opens the card → Apply-queue / Skip |
| Any break | phone | tap Apply ▸ → Open the form → it fills → review → Submit (Android records it; iOS needs one tap) |
| Breaks | phone | share sheet → capture a job (`/captures/from-url`, already shipped) |
| Evening, 2–3×/week | laptop | stream-apply whatever needed a login: Workday, LinkedIn |

The evening batch doesn't disappear — it shrinks to the boards that genuinely
need a desktop, instead of being everything.

The dashboard's "Open the form ▸" link appends `#jh-apply=<id>` so it serves
both paths without detecting which is installed: an extension picks the hash up
and fills automatically; the Shortcut ignores it, because
`/apply/fill-script` resolves the job from the URL instead.

## Setup — Android (one-time)

1. Phase 0 of `phone-first-funnel.md`: build the dashboard, set `HOST`,
   `ACCESS_TOKEN` and `PUBLIC_URL`, install Tailscale on both devices.
2. Zip the extension with `manifest.json` at the archive root. On the Windows PC:
   ```powershell
   Compress-Archive -Path extension\* -DestinationPath jobcapture.zip -Force
   ```
3. Install **Quetta** or **Lemur** from the Play Store (both sideload local
   `.crx`/`.zip`; Quetta is the more stable Kiwi successor, Lemur has the more
   reliable local-file install). Transfer the zip to the phone and install it
   from the browser's extensions page.
4. In the extension popup → **⚙ Backend settings**: set the Backend URL to the
   Tailscale URL and paste the same `ACCESS_TOKEN`, then **Save & test**.
5. Open the dashboard in that same browser and Add to Home Screen.

Then the loop is just: tap **Apply ▸** → **Open the form ▸** → it fills →
review → Submit. Nothing else to learn.

## Setup — iOS (one-time)

Phase 0 as above. `PUBLIC_URL` matters here — it's what the fill script's
"✓ I submitted" link points at.

Then build the Shortcut (Shortcuts app → new shortcut → **Show in Share Sheet**,
accept *URLs* and *Safari web pages*; Settings → Shortcuts → **Allow Running
Scripts** must be on):

1. **Get URLs from Input**
2. **Get Contents of URL**
   - `http://<pc>.<tailnet>.ts.net:8787/apply/fill-script?url=<URLs from step 1, URL-encoded>`
   - Header `x-access-token` = your `ACCESS_TOKEN`
3. *(optional, for the résumé)* **Get Contents of URL** →
   `…/jobs/<id>/resume/file?format=pdf` → **Save File** to a fixed
   *Shortcuts/JobHunt* folder with "Ask where to save" off
4. **Run JavaScript on Web Page**, input = Shortcut Input, script:
   ```js
   new Function("done",decodeURIComponent("«Contents of URL from step 2»"))(completion);
   ```
5. **Show Result** (the driver's summary: what was filled, what's left)

## Rejected and deferred

- **Auto-submit, on any device.** Unchanged core boundary.
- **A native app or a second mobile frontend.** The built dashboard over
  Tailscale is the mobile app; a 640px breakpoint is the entire mobile UI budget.
- **Firefox for Android.** It can sideload signed XPIs and supports MV3, but
  Mozilla still recommends MV2 for Android and `background.service_worker` isn't
  a Firefox key — this extension would need porting. Not worth it while
  Chromium forks run it unchanged.
- **A phone-side Copilot panel** to replace the missing side panel on Android.
  The dashboard's copy chips already cover the no-adapter boards; revisit if
  Workday becomes a large share of applications.
- **Web Push instead of Slack.** iOS 16.4+ supports it for home-screen PWAs and
  it would open the app directly instead of Slack's in-app browser. Real value,
  but it improves the *notification*, and the notification was never the broken
  part. Revisit if Slack's in-app browser turns out to be the friction.
- **An LLM pass from the phone.** Needs a live backend call the page can't make.
  The dashboard can already answer a question on demand before you open the
  form; that's the right place for it.
- **Batch/stream mode on the phone.** Wants tab control the share sheet doesn't
  give. One job per run is honest, and phone sessions are short anyway.
