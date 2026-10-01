# Phone-first funnel — spec/proposal (2026-08-26)

> **Follow-up:** [`phone-apply-design.md`](phone-apply-design.md) (2026-08-28)
> supersedes phase 1.1 and phase 2.3 below. Phase 1.1 (the mobile triage pass)
> shipped as a 640px breakpoint; phase 2.3 turned out to be more than a
> copy-paste panel — the phone runs the real fill engine via an iOS Shortcut.

## Problem

The user has no desktop access during the day. The current funnel assumes desktop at every human touchpoint
(extension capture, dashboard triage, `/apply` submit), so application volume
collapsed to whatever evening energy is left. The fix is to move every
*decision-shaped* touchpoint to the phone and compress desktop time into one
short evening batch.

Target loop (≈15 phone-minutes/day + 2–3 evening batches/week):

| When | Device | Action | Time |
|---|---|---|---|
| Commute AM | phone | Slack ping → triage overnight matches: Apply-queue / Skip | 5 min |
| Breaks/lunch | phone | LinkedIn/Indeed app browsing → share-sheet capture; triage | 5–10 min |
| Evening | own laptop | `/apply` batch over the day's queue → review → submit | 20–30 min |

Goal: 5–10 quality applications/week with zero daytime desktop use.

## Phase 0 — no code: switch on what's already built (one-time, ~20 min on the PC)

Everything in this phase already exists in the README ("Access from your other
devices"); it just has to be enabled once:

1. `cd dashboard && npm run build` (backend then serves it on :8787).
2. `npm run gen-token` → set `HOST=0.0.0.0`, `ACCESS_TOKEN`, `PUBLIC_URL` in
   `backend/.env`; restart the backend task.
3. Install Tailscale on the PC + phone (same account).
4. On the phone: open the Tailscale URL, sign in with the token,
   **Add to Home Screen** → app icon.
5. Build the iOS share-sheet Shortcut (README steps) → one-tap capture from
   Safari/LinkedIn app on the phone, no extension needed.

After phase 0 the phone can already: see the queue, mark Relevant/Skip/Applied,
capture by URL or paste, and run the server-side LinkedIn-search scan.

## Phase 1 — small code changes (highest value per line)

1. **Mobile triage pass on the queue view.** `styles.css` is desktop-first
   (`#app { max-width: 1180px }`, one `@media (max-width: 800px)` rule for
   `.grid2`). Add a phone breakpoint (~640px): single-column cards, 44px+ touch
   targets for the three actions (`Apply ▸ / Relevant / Skip` already exist in
   `main.ts` card actions), sticky bottom action bar on the open card, collapse
   filters behind a toggle, hide keyboard-shortcut chrome. No new view — the
   existing one-tab queue, restyled.
2. **Slack deep links.** `highScoreNotify.ts` pings contain no URL back into the
   dashboard. When `PUBLIC_URL` is set, append per-job links
   (`{PUBLIC_URL}/#job=<id>`) and make the dashboard open that card from the
   hash. Turns each ping into a 2-tap triage.
3. **"Tonight's batch" section.** A queue filter for `state=relevant` decided
   since last apply-session, with per-job résumé status (`✅ ready / not
   generated`). This is the handoff artifact between phone-day and
   laptop-evening; it makes the evening session start with zero re-finding.

## Phase 2 — medium, opt-in

1. **Tailor-ahead toggle.** Marking Relevant from the phone can enqueue
   `generate-resume` so PDFs are ready before evening. Must respect the
   existing LLM-spend guardrail (`config.ts` deliberately keeps the
   notification bar from changing tailoring spend): default OFF, explicit
   settings toggle, daily cap (e.g. 5), skip when score < notify threshold.
2. **`/apply` batch mode.** `/apply` currently takes one job-id/URL. Add a mode
   that walks the "tonight's batch" list: pre-fill → human reviews/submits →
   next. Same human-submit boundary (see `apply-assist-spec.md`).
3. **Phone submit for easy forms.** Greenhouse/Lever/Ashby hosted forms are
   mobile-friendly and unauthenticated. For jobs whose résumé PDF is already
   generated, a card action "Apply on phone" = open the form + a copyable
   answers panel (contact fields, screening drafts from the apply-package) +
   résumé PDF download link so the phone's file picker can attach it. Human
   still fills/submits; this just removes the desktop dependency for the
   simple half of ATSes. Workday/login-walled boards stay evening-batch.

## Explicitly out of scope

- Auto-submit from any device (unchanged core boundary).
- A native app / separate mobile frontend — the built dashboard over Tailscale
  is the mobile app.
- Exposing the backend publicly without auth (server already refuses
  non-loopback bind without `ACCESS_TOKEN`; Cloudflare Tunnel is the sanctioned
  public-https path).

## Sequencing

Phase 0 is user-setup on the Windows PC and unblocks everything; do it first.
Phase 1 items are independent and each shippable alone (order: 1 → 3 → 2).
Phase 2 only after a week of real phone triage shows where the friction
actually is.
