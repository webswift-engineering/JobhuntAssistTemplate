// Orchestrates a single "Scan this page" run: detect -> acquire JDs (throttled) ->
// triage in batches -> paint. Injected last, after the other scan/*.js files.
(function () {
  const JCS = window.__JCSCAN;
  if (!JCS) return;
  if (JCS.running) return; // guard against double-injection
  JCS.running = true;

  const MAX_CARDS = 40;
  const MAX_CARDS_AUTO = 20; // unattended runs stay short (background timer throttling)
  const CHUNK = 8;
  const JITTER_MIN = 300;
  const JITTER_MAX = 800;
  const ABORT_AFTER_CONSECUTIVE_FAILS = 5;
  // The backend backfills missing JDs and rescores right after a persisted scan;
  // one delayed /jobs/seen pass repaints the badges with those final stored scores.
  const LATE_REPAINT_DELAY_MS = 75000;

  const jitter = () => JITTER_MIN + Math.floor(Math.random() * (JITTER_MAX - JITTER_MIN));

  async function readSetting(key, fallback) {
    try {
      const v = await chrome.storage.local.get(key);
      return v && key in v ? v[key] : fallback;
    } catch {
      return fallback;
    }
  }

  async function triageChunk(cards, ctx) {
    const jobs = cards.map((c) => ({
      title: c.title,
      company: c.company,
      location: c.location,
      description: c.description ?? null,
      dedupKey: c.dedupKey,
      url: c.href ?? null,
      externalId: c.externalId ?? null,
    }));
    const res = await JCS.send("TRIAGE", { jobs, source: ctx.source, persist: ctx.persist });
    if (!res || !res.ok || !res.data || !Array.isArray(res.data.results)) return 0;
    res.data.results.forEach((result, i) => {
      if (cards[i]) JCS.overlay.paintCard(cards[i], result);
    });
    return res.data.persisted || 0;
  }

  // LinkedIn (and similar SPAs) render result cards lazily as the list scrolls.
  // Manual scans work because the user already scrolled; unattended runs must
  // nudge both the window and any scrollable list pane before detection.
  async function hydrateList() {
    const panes = [
      ".jobs-search-results-list",
      ".scaffold-layout__list > div",
      "ul.jobs-search__results-list",
      ".jobs-search-results-list__list",
    ]
      .map((s) => document.querySelector(s))
      .filter(Boolean);
    for (let i = 1; i <= 8; i++) {
      for (const el of panes) el.scrollTop = (el.scrollHeight * i) / 8;
      window.scrollTo(0, (document.body.scrollHeight * i) / 8);
      await JCS.sleep(400);
    }
    for (const el of panes) el.scrollTop = 0;
    window.scrollTo(0, 0);
    await JCS.sleep(300);
  }

  // After the scan, the backend keeps working (JD backfill -> rescore). Re-query the
  // stored scores once and repaint any card whose authoritative score is now known.
  function scheduleLateRepaint(cards, source) {
    const keyed = cards.filter((c) => c.externalId && c.el);
    if (!keyed.length) return;
    setTimeout(async () => {
      try {
        if (!document.body || !document.body.isConnected) return;
        const keys = keyed.map((c) => `${source}:${String(c.externalId).trim()}`);
        const res = await JCS.send("SEEN", keys);
        if (!res || !res.ok || !res.data) return;
        keyed.forEach((c, i) => {
          const entry = res.data[keys[i]];
          // SPA navigation removes the cards; only repaint ones still on screen.
          if (!entry || entry.score == null || !c.el.isConnected) return;
          const stored = String(entry.reason || "");
          const m = /^\[(strong|maybe|weak|disqualified)\]\s*/.exec(stored);
          const verdict =
            (m && m[1]) || (entry.score >= 0.6 ? "strong" : entry.score < 0.25 ? "weak" : "maybe");
          JCS.overlay.paintCard(c, {
            verdict,
            score: entry.score,
            reason: m ? stored.slice(m[0].length) : stored,
          });
        });
      } catch {
        /* best-effort repaint */
      }
    }, LATE_REPAINT_DELAY_MS);
  }

  function scanDone(payload) {
    try {
      JCS.send("SCAN_DONE", payload);
    } catch {
      /* ignore */
    }
  }

  async function run() {
    const auto = window.__JCSCAN_AUTO === true; // alarm-triggered unattended run
    const forceAdapt = auto ? false : await readSetting("scanForceAdapt", false);
    if (forceAdapt) {
      try {
        await chrome.storage.local.remove("scanForceAdapt");
      } catch {
        /* ignore */
      }
    }

    if (auto) await hydrateList();

    let detected = JCS.detectCards(); // also populates JCS.lastDiag for diagnostics
    if (forceAdapt) detected = null; // manual re-teach skips built-in detection

    // Built-in detection missed (or forced): let DeepSeek adapt this site.
    // Unattended runs skip AI adaptation — the saved search URL is a known site.
    if (!auto && (!detected || detected.cards.length < 3) && JCS.aiAdapt) {
      JCS.overlay.mount(0);
      JCS.overlay.note("Adapting site with AI…");
      let ai = await JCS.aiAdapt(forceAdapt);
      if ((!ai || ai.cards.length < 3) && !forceAdapt) ai = await JCS.aiAdapt(true);
      if (ai && ai.cards.length >= 3) detected = ai;
    }

    if (!detected || !detected.cards.length) {
      const d = JCS.lastDiag || {};
      JCS.overlay.mount(0);
      JCS.overlay.finish(
        `No job cards found. (ckey:${d.componentKeyCards} view:${d.viewLinks} curId:${d.currentJobIdLinks} ids:${d.dataJobId} slider:${d.sliderItems} jk:${d.dataJk} jobLinks:${d.jobHrefAnchors} reg:${d.jcRegistry})`
      );
      JCS.running = false;
      if (auto) {
        scanDone({
          total: 0,
          counts: { strong: 0, maybe: 0, weak: 0, disqualified: 0 },
          persisted: 0,
          cancelled: false,
          error: "no job cards found",
        });
      }
      return;
    }

    const cards = detected.cards.slice(0, auto ? MAX_CARDS_AUTO : MAX_CARDS);
    const total = cards.length;
    const ctx = {
      source: detected.source,
      persist: auto ? true : await readSetting("saveScanned", true),
    };
    JCS.overlay.mount(total);

    // One shared detail pane means cards must be processed serially — concurrent
    // workers would race each other clicking cards into the same pane.
    const twoPane = JCS.detectCards && document.querySelector(
      ".jobs-search__job-details, .jobs-details, .scaffold-layout__detail, " +
        "#jobsearch-ViewjobPaneWrapper, .jobsearch-RightPane, #vjs-container-iframe, " +
        ".jobsearch-JobComponent, #mosaic-vjJobDetails"
    );
    const poolSize = twoPane ? 1 : 3;

    let done = 0;
    let persistedTotal = 0;
    let consecutiveFails = 0;
    let jdDisabled = false; // flip to title-only if we look rate-limited
    let next = 0;
    const pending = [];

    async function worker() {
      for (;;) {
        if (JCS.overlay.isCancelled()) return;
        const i = next++;
        if (i >= cards.length) return;
        const card = cards[i];

        if (!jdDisabled) {
          try {
            const jd = await JCS.acquireJd(card);
            card.description = jd.description;
            if (jd.description) consecutiveFails = 0;
            else consecutiveFails++;
          } catch {
            consecutiveFails++;
          }
          if (consecutiveFails >= ABORT_AFTER_CONSECUTIVE_FAILS) jdDisabled = true;
        }

        done++;
        JCS.overlay.setProgress(done, total);

        pending.push(card);
        if (pending.length >= CHUNK) {
          const batch = pending.splice(0, pending.length);
          try {
            persistedTotal += await triageChunk(batch, ctx);
          } catch {
            /* keep scanning */
          }
        }
        await JCS.sleep(jitter());
      }
    }

    const workers = [];
    for (let w = 0; w < poolSize; w++) workers.push(worker());
    await Promise.all(workers);

    if (pending.length) {
      try {
        persistedTotal += await triageChunk(pending.splice(0, pending.length), ctx);
      } catch {
        /* ignore */
      }
    }

    // Summary counts from painted verdicts.
    const counts = { strong: 0, maybe: 0, weak: 0, disqualified: 0 };
    for (const c of cards) {
      const v = c.el?.dataset?.jcVerdict;
      if (v && counts[v] != null) counts[v]++;
    }
    const summary = JCS.overlay.isCancelled()
      ? `Cancelled at ${done}/${total}`
      : `${counts.strong} strong · ${counts.maybe} maybe · ${counts.weak} weak · ${counts.disqualified} skip`;
    JCS.overlay.finish(summary);
    JCS.running = false;
    if (auto) {
      scanDone({
        total,
        counts,
        persisted: persistedTotal,
        cancelled: JCS.overlay.isCancelled(),
      });
    } else if (ctx.persist && !JCS.overlay.isCancelled()) {
      // Auto-scan windows close right after SCAN_DONE — repaint only manual scans.
      scheduleLateRepaint(cards, detected.source);
    }
  }

  run().catch((e) => {
    console.warn("[jc-scan]", e);
    JCS.running = false;
    if (window.__JCSCAN_AUTO === true) {
      scanDone({
        total: 0,
        counts: { strong: 0, maybe: 0, weak: 0, disqualified: 0 },
        persisted: 0,
        cancelled: false,
        error: String((e && e.message) || e),
      });
    }
  });
})();
