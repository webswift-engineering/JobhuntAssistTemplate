// Desktop Chrome apply engine — runs on any ATS host with an adapter in
// applyAdapters.js, triggered by the dashboard's #jh-apply=<backendJobId>
// handoff (Approve button).
//
// The DOM half (field detection, value resolution, filling, submit snapshot)
// lives in applyCore.js and is shared with the phone path
// (extension/mobile/fillDriver.js, served by GET /apply/fill-script). What
// stays here is everything Chrome-specific: backend I/O through the background
// worker, the status bar, stream controls, and recording.
//
// Fill pipeline (each layer only handles what the previous couldn't):
//   1. answer bank + profile fields (deterministic; bank may include answers the
//      human gave to sensitive questions — their own words, reused verbatim)
//   2. label heuristics (names, links, location, school, source, ...)
//   3. DeepSeek via POST /profile/answer-screening (factual questions only;
//      server guards sensitive categories and bans bare zeros; answers are banked)
//   4. human — sensitive questions with no banked answer stay highlighted
//
// HARD BOUNDARY: never clicks Submit, never touches EEO/self-identification
// sections, never guesses salary/authorization/demographic answers. Recording
// happens only after a real submission (confirmation text, or trusted submit
// click + pagehide fallback).
(() => {
  const ADAPTER = (window.JC_APPLY_ADAPTERS || {})[location.host];
  if (!ADAPTER) return;
  const core = window.JC_APPLY_CORE;
  if (!core) return;
  const { sleep } = core;
  // Handoff state — parsed in boot(): from this frame's own hash, or (branded
  // Greenhouse embeds) from the TOP frame's URL via the background worker.
  let jobId = null;
  // Stream mode (chained batch apply): after the human submits, the background
  // worker advances the stream and navigates THIS tab to the next job.
  let streamId = null;
  let streamPos = null;
  // Prefill-ahead (phone decides, desktop fills): opened unattended by the
  // background worker. Same fill, same stop-before-Submit; the result (field
  // table + open questions) is reported for the phone, and the tab stays parked.
  // Phone answers arrive as PREFILL_REFILL → re-run the fill pass.
  let prefill = false;
  let refillHook = null;
  /** Set by run() once the form is found; the submit watcher reads its
   *  engineFilled map and trace, so it must be reachable from module scope. */
  let filler = null;
  const SUBMIT_RE = /submit application|^submit$/i;

  /** Pull jh-apply / jh-stream / jh-pos / jh-prefill out of a hash or full URL. */
  function parseHandoff(str) {
    const m = (str || "").match(/jh-apply=([a-z0-9]+)/i);
    if (!m) return false;
    jobId = m[1];
    streamId = ((str || "").match(/jh-stream=([a-z0-9]+)/i) || [])[1] || null;
    const posM = (str || "").match(/jh-pos=(\d+)-(\d+)/);
    streamPos = posM ? `${posM[1]}/${posM[2]}` : null;
    prefill = /jh-prefill=1/i.test(str || "");
    return true;
  }

  // ---- status bar -----------------------------------------------------------
  // Content lives in a SHADOW ROOT so the page's CSS can't bleed in — the bare
  // div version rendered with overlapping/garbled text on some ATS pages.
  // On a phone (this extension also runs in Android Chromium browsers) a 440px
  // corner card is unreadable and lands under the ATS's sticky chrome, so the
  // bar becomes a full-width bottom sheet inside thumb reach.
  const narrow = window.innerWidth < 640;
  const bar = document.createElement("div");
  bar.style.cssText = narrow
    ? "all:initial;display:block;position:fixed;left:0;right:0;bottom:0;z-index:2147483647"
    : "all:initial;display:block;position:fixed;bottom:16px;left:16px;z-index:2147483647";
  const shadow = bar.attachShadow({ mode: "open" });
  const wrap = document.createElement("div");
  wrap.style.cssText = narrow
    ? "background:#1f2328;color:#e6edf3;padding:12px 14px calc(12px + env(safe-area-inset-bottom));" +
      "font:15px/1.45 system-ui;box-shadow:0 -4px 20px rgba(0,0,0,.45);" +
      "border-top:1px solid #30363d;max-height:45vh;overflow:auto"
    : "background:#1f2328;color:#e6edf3;padding:10px 14px;border-radius:8px;" +
      "font:13px/1.5 system-ui;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:440px";
  shadow.append(wrap);
  // Bump on every engine change — the status bar shows it, so "is Chrome running
  // my latest code?" is answerable without guessing (cost us two debug cycles).
  const ENGINE_BUILD = "e19";
  // Status text and stream controls live in separate nodes so setStatus never
  // wipes the Skip/End buttons.
  const statusEl = document.createElement("div");
  statusEl.style.cssText = "padding-right:16px";
  const controlsEl = document.createElement("div");
  controlsEl.style.cssText = "margin-top:8px;display:none;gap:8px";
  wrap.append(statusEl, controlsEl);
  // The bar can sit right on top of form fields (EEO/signature blocks live at the
  // bottom of long forms, same corner) — "–" collapses it to a small pill.
  const minBtn = document.createElement("button");
  minBtn.textContent = "–";
  minBtn.title = "Minimize — collapses to a pill; click the pill to restore";
  minBtn.style.cssText =
    "position:absolute;top:2px;right:4px;background:none;border:none;color:#8b949e;" +
    "font:16px/1 system-ui;cursor:pointer;padding:2px 6px";
  const pill = document.createElement("div");
  pill.textContent = "🤖";
  pill.title = "Apply assist (minimized) — click to expand";
  pill.style.cssText =
    "display:none;background:#1f2328;padding:8px 10px;border-radius:999px;" +
    "font:15px/1 system-ui;box-shadow:0 4px 16px rgba(0,0,0,.4);cursor:pointer";
  minBtn.addEventListener("click", () => { wrap.style.display = "none"; pill.style.display = "block"; });
  pill.addEventListener("click", () => { pill.style.display = "none"; wrap.style.display = "block"; });
  wrap.style.position = "relative";
  wrap.append(minBtn);
  shadow.append(pill);
  const setStatus = (html) => {
    statusEl.innerHTML =
      `🤖 Apply assist (${ADAPTER.name}·${ENGINE_BUILD}${streamPos ? ` · job ${streamPos}` : ""}) — ` + html;
    if (!bar.isConnected) document.body.appendChild(bar);
  };
  bar.dataset.jcEngineBuild = ENGINE_BUILD;
  const traceTail = (n) => (filler ? filler.trace.slice(-n) : []);

  function setupStreamControls() {
    if (!streamId) return;
    const btn = (label, title, onclick) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.style.cssText = narrow
        ? "background:#30363d;color:#e6edf3;border:1px solid #484f58;border-radius:8px;" +
          "padding:11px 14px;min-height:44px;font:14px system-ui;cursor:pointer"
        : "background:#30363d;color:#e6edf3;border:1px solid #484f58;border-radius:6px;" +
          "padding:3px 10px;font:12px system-ui;cursor:pointer";
      b.addEventListener("click", onclick);
      controlsEl.append(b);
      return b;
    };
    controlsEl.style.display = "flex";
    btn("Skip ▸", "Skip this job for good (marked skipped, leaves the queue) — go straight to the next one", async () => {
      setStatus("skipped — it won't be suggested again. Loading the next job…");
      await bg("STREAM_SKIP", { streamId, afterId: jobId });
    });
    btn("■ End stream", "Stop the batch here (also cancels a pending auto-advance)", async () => {
      await bg("STREAM_STOP", { streamId });
      controlsEl.remove();
      setStatus("stream ended — this tab stays put. Restart from the dashboard anytime.");
    });
  }

  /**
   * All backend traffic goes through the background worker. Content-script fetches
   * inherit the PAGE's CSP — Ashby's connect-src blocks 127.0.0.1, which made the
   * engine hang silently before its first status (looked like "never ran").
   * Always resolves: { ok, data?, error? }, with a hard timeout so nothing hangs.
   */
  function bg(type, payload, timeoutMs = 20000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
      try {
        chrome.runtime.sendMessage({ type, payload }, (resp) => {
          if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
          else finish(resp || { ok: false, error: "no response" });
        });
      } catch (e) {
        finish({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  async function injectResume() {
    const resp = await bg("RESUME_PDF", { id: jobId }, 30000);
    return core.attachResume(ADAPTER, resp.ok ? resp.data?.base64 : null);
  }

  async function llmAnswers(unanswered) {
    const questions = [...new Set(unanswered.filter((u) => u.askLlm !== false).map((u) => u.label).filter((q) => q && q.length > 8))];
    if (!questions.length) return false;
    setStatus(`thinking about ${questions.length} screening question(s) (DeepSeek)…`);
    const resp = await bg("ANSWER_SCREENING", { questions }, 60000);
    if (!resp.ok || !resp.data?.answers) return false;
    return filler.mergeAnswers(resp.data.answers);
  }

  // ---- recording ------------------------------------------------------------
  let recorded = false;
  async function recordApplied() {
    if (recorded) return;
    recorded = true;
    // Fire-and-forget through the worker: it survives this page being torn down
    // by the submit navigation, so no keepalive juggling is needed.
    const resp = await bg("RECORD_APPLY", {
      id: jobId,
      streamId: streamId || undefined,
      notes: `${ADAPTER.name} via apply assist · ${new Date().toISOString().slice(0, 10)}`,
    });
    setStatus(
      resp.ok
        ? streamId
          ? "✅ submitted & recorded — next job loads here in a few seconds (■ End stream to stay)."
          : "✅ submitted — recorded in Job Hunt Assistant. You can close this tab."
        : "✅ submitted — but recording failed (backend down?). Mark applied on the dashboard."
    );
    void bg("DEBUG_LOG", {
      event: "engine-record-result",
      data: { jobId, streamId, ok: resp.ok, error: resp.error ?? null, build: ENGINE_BUILD, trace: traceTail(10) },
    });
    if (resp.ok && streamId) {
      // Stuck watchdog: the worker should navigate this tab within the grace
      // delay. Only pagehide proves it happened — if this page is still alive
      // 15s later, surface it and capture the state for the debug log.
      let navigated = false;
      window.addEventListener("pagehide", () => { navigated = true; }, { once: true });
      setTimeout(() => {
        if (navigated) return;
        setStatus(
          "⚠ auto-advance didn't fire — click <b>Skip ▸</b> to load the next job. (State captured to the debug log.)"
        );
        void bg("DEBUG_LOG", {
          event: "stream-STUCK",
          screenshot: true,
          data: { jobId, streamId, build: ENGINE_BUILD, trace: traceTail(10) },
        });
      }, 15000);
    }
  }

  // ---- submit snapshot (the improvement loop) -------------------------------
  // At the moment the human submits, capture every visible field's label +
  // value + who filled it, diffed against the filler's engineFilled map. The
  // snapshot lands in the backend debug log to guide heuristics, and the
  // human's own answers are banked so the NEXT form asking the same question
  // auto-fills. Protected/EEO questions are never captured, in any form.
  let lastSnapshotAt = 0;
  function reportSubmitSnapshot(trigger) {
    const t = Date.now();
    if (t - lastSnapshotAt < 5000) return; // validation-failure resubmits: once per burst
    lastSnapshotAt = t;
    const fields = core.collectSnapshot(ADAPTER, filler ? filler.engineFilled : null);
    void bg("DEBUG_LOG", {
      event: "submit-snapshot",
      data: { jobId, streamId, build: ENGINE_BUILD, trigger, fields },
    });
    const answers = core.bankableAnswers(fields);
    if (Object.keys(answers).length) void bg("BANK_ANSWERS", { answers });
  }

  const looksSubmitted = () => core.looksSubmitted(ADAPTER);

  function watchForConfirmation() {
    // Static confirmation pages (embed re-run after submit) never mutate —
    // check NOW, not just on future mutations. (Greenhouse run: the watcher armed on
    // an already-final page and sat forever.)
    if (looksSubmitted()) {
      void recordApplied();
      return;
    }
    const obs = new MutationObserver(() => {
      if (looksSubmitted()) {
        obs.disconnect();
        void recordApplied();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    let submitClicked = false;
    // Language-agnostic PRIMARY signal: a real form submission fires "submit"
    // regardless of what the button says. (Greenhouse run: a localized Submit button
    // never matched SUBMIT_RE, so the pagehide recording never armed.)
    document.addEventListener(
      "submit",
      () => {
        submitClicked = true;
        reportSubmitSnapshot("submit-event");
      },
      true
    );
    document.addEventListener(
      "click",
      (e) => {
        const b = e.target && e.target.closest ? e.target.closest("button, input[type=submit]") : null;
        if (!b) return;
        const label = `${b.getAttribute("aria-label") || ""} ${b.textContent || b.value || ""}`.trim();
        // Text match (any language the regex knows) OR structural: a
        // submit-typed button inside the application form.
        if (SUBMIT_RE.test(label) || (b.type === "submit" && b.closest(ADAPTER.formSelector))) {
          submitClicked = true;
          reportSubmitSnapshot("submit-click");
        }
      },
      true
    );
    window.addEventListener("pagehide", () => {
      if (submitClicked && !recorded) void recordApplied();
    });
  }

  // ---- main -----------------------------------------------------------------
  async function run() {
    setStatus("starting…"); // mount immediately so a stall is never invisible
    // HYDRATION GUARD (mandatory on Greenhouse, harmless elsewhere): mutations
    // before React finishes hydrating are wiped by its mismatch recovery.
    if (document.readyState !== "complete") {
      await new Promise((r) => window.addEventListener("load", r, { once: true }));
    }
    setStatus("waiting for the page to settle…");
    await core.quietDom(1200, 15000);

    // RECOVERY PATH: landed straight on a confirmation page — the embed's
    // post-submit re-run, where the dying iframe's own record message may have
    // been lost. Record + advance from here; the advance is idempotent, so a
    // double-fire with the previous instance can't skip a job.
    if (looksSubmitted()) {
      setStatus("submission confirmed — recording…");
      void bg("DEBUG_LOG", { event: "engine-confirmation-page", data: { jobId, streamId, build: ENGINE_BUILD } });
      await recordApplied();
      return;
    }

    setStatus("loading your profile…");
    const fieldsResp = await bg("APPLY_FIELDS", null);
    if (!fieldsResp.ok || !fieldsResp.data) {
      setStatus(`⚠ couldn't load profile (${fieldsResp.error || "unknown"}) — fill manually.`);
      if (prefill) void bg("PREFILL_FAILED", { jobId, reason: `couldn't load profile: ${fieldsResp.error || "unknown"}` });
      return;
    }
    filler = core.createFiller(ADAPTER, fieldsResp.data);

    let form = await core.waitFor(() => document.querySelector(ADAPTER.formSelector), 6000);
    if (!form && ADAPTER.applicationSuffix && !location.pathname.endsWith(ADAPTER.applicationSuffix)) {
      // Posting page — the form lives at a sub-path; navigation preserves the hash
      // and this script re-runs on the new page.
      location.pathname = location.pathname.replace(/\/$/, "") + ADAPTER.applicationSuffix;
      return;
    }
    if (!form) {
      const applyBtn = [...document.querySelectorAll("button, a")].find((b) =>
        ADAPTER.applyButtonRe.test((b.textContent || "").trim())
      );
      if (applyBtn) applyBtn.click();
      form = await core.waitFor(() => document.querySelector(ADAPTER.formSelector), 8000);
    }
    if (!form) {
      setStatus("couldn't find the application form — fill manually; I'll record after you submit.");
      void bg("DEBUG_LOG", { event: "engine-no-form", data: { jobId, streamId, build: ENGINE_BUILD } });
      if (prefill) void bg("PREFILL_FAILED", { jobId, reason: "no application form found (login wall / redirect / captcha?)" });
      watchForConfirmation();
      return;
    }

    // Attach the résumé FIRST: the upload makes the form re-render, which resets
    // fields filled beforehand (observed live on Ashby — phone/LinkedIn/residence
    // came back empty after the attach).
    setStatus("attaching your tailored résumé…");
    const resumeState = await injectResume();

    setStatus("filling the application…");
    let unanswered = await filler.pass();
    // The LLM pass is OPT-IN (DeepSeek pricing): default is bank + heuristics
    // only — the Copilot panel's per-question "Ask AI" is the on-demand path.
    const { autoLlm } = await new Promise((r) => chrome.storage.local.get("autoLlm", r));
    if (autoLlm === true && unanswered.some((u) => u.askLlm !== false) && (await llmAnswers(unanswered))) {
      unanswered = await filler.pass();
    }

    // Free-text "why this company / tell us about you" boxes: draft from the
    // tailored cover letter (always human-reviewed, never auto-submitted).
    let drafted = 0;
    if (core.freeTextBoxes(ADAPTER).length) {
      const pkg = await bg("APPLY_PACKAGE", { id: jobId }, 20000);
      const letter = pkg.ok ? (pkg.data?.tailored?.cover_letter || "").trim() : "";
      drafted = core.draftFreeText(ADAPTER, letter, { engineFilled: filler.engineFilled });
    }

    // Verify + refill: React re-renders (file upload, async validation) can revert
    // values silently, so re-assert everything one last time.
    setStatus("verifying…");
    await sleep(1000);
    unanswered = await filler.pass();

    const summary = [
      resumeState === "injected"
        ? "tailored résumé attached"
        : resumeState === "already"
          ? "résumé already attached"
          : resumeState === "unavailable"
            ? "⚠ résumé injection failed — attach it yourself (Open folder on the dashboard)"
            : "⚠ no upload field found — attach the résumé yourself",
      drafted ? `${drafted} free-text answer(s) DRAFTED — proofread before sending` : null,
      unanswered.length
        ? `⚠ answer the highlighted: ${[...new Set(unanswered.map((u) => u.label))].slice(0, 4).join("; ")}`
        : "all fields filled",
      "EEO/demographics left for you (by design)",
    ].filter(Boolean).join(" · ");
    setStatus(`ready for YOUR review — ${summary}. Click <b>Submit application</b> yourself; I'll record it.`);
    void bg("DEBUG_LOG", {
      event: "engine-ready",
      data: {
        jobId,
        streamId,
        build: ENGINE_BUILD,
        resumeState,
        drafted,
        unanswered: [...new Set(unanswered.map((u) => u.label))].slice(0, 8),
        trace: traceTail(15),
      },
    });
    watchForConfirmation();

    if (prefill) {
      // Report for the phone, then park. Phone answers land in the bank and the
      // background worker sends PREFILL_REFILL → reload fields, re-run the pass.
      await reportPrefill(unanswered, resumeState, drafted);
      refillHook = async () => {
        setStatus("new answers from your phone — re-filling…");
        const f = await bg("APPLY_FIELDS", null);
        if (f.ok && f.data) filler = core.createFiller(ADAPTER, f.data);
        const un = await filler.pass();
        await reportPrefill(un, resumeState, drafted);
      };
    }
  }

  /** Prefill mode: field table + open questions → backend (screenshot added by the worker). */
  async function reportPrefill(unanswered, resumeState, drafted) {
    const open = [...new Set(unanswered.map((u) => u.label))].slice(0, 40);
    const res = await bg(
      "PREFILL_READY",
      { jobId, fields: core.collectSnapshot(ADAPTER, filler ? filler.engineFilled : null), unanswered: open, resumeState, drafted: drafted || 0 },
      30000
    );
    setStatus(
      `📱 prefilled for phone review${res.ok ? "" : " (report failed: " + (res.error || "?") + ")"} — ` +
        (open.length ? `${open.length} question(s) still need you: ${open.slice(0, 3).join("; ")}` : "all fields filled") +
        `. Submit is yours — this tab stays parked.`
    );
  }

  /**
   * Resolve the handoff, then run. Two entry shapes:
   * - Direct ATS page: the #jh-apply hash is on THIS frame's URL.
   * - Branded Greenhouse board (careerpuck, okta.com, …): Greenhouse REDIRECTS
   *   the canonical URL to the company's branded page, which embeds the real
   *   job-boards.greenhouse.io form in an iframe. The hash survives the redirect
   *   on the TOP frame's URL, but that's cross-origin from in here — so the
   *   background worker reads it off sender.tab.url for us.
   */
  async function boot() {
    if (!parseHandoff(location.hash)) {
      if (window.top === window) return; // top-level page without a handoff — idle
      const resp = await bg("TAB_URL", null, 5000);
      if (!resp.ok || !resp.data?.url || !parseHandoff(resp.data.url)) return;
    }
    setupStreamControls();
    void run();
  }

  // Phone answered an open question → the worker asks this parked tab to re-fill.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "PREFILL_REFILL" || !prefill || !refillHook) return false;
    if (msg.jobId && msg.jobId !== jobId) return false;
    refillHook()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  });

  void boot();
})();
