// Main content-script flow (§11). Runs after registry.js + parsers/*.js.
// All capture is passive; the only UI affordance is the apply-page bar (role 4).
(function () {
  const JC = window.__JOBCAPTURE;
  const parser = JC.pick(location.href);
  if (!parser) return;

  const BADGE = { new: "🆕", viewed: "👁", applied: "✅", skipped: "🚫", relevant: "⭐", notified: "🔔" };
  let hideMasked = false;

  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  async function runListings() {
    const cards = Array.from(document.querySelectorAll(parser.cardSelector || "*"))
      .filter((c) => parser.cardKey?.(c));
    const fresh = cards.filter((c) => !c.dataset.jobcapture);

    // 1. Ingest new cards.
    if (fresh.length) {
      const jobs = parser.parseListings(document).filter((j) => j.title);
      if (jobs.length) {
        const res = await JC.send("INGEST", jobs);
        if (res.ok && Array.isArray(res.data)) {
          // 2. emit 'listed' for each ingested card.
          for (const r of res.data) {
            JC.send("EVENT", { source: parser.source, event: "listed", jobId: r.id, url: location.href });
          }
        }
      }
    }

    // 2b. Augment / mask by DB state.
    const keyByCard = new Map();
    const keys = [];
    for (const card of cards) {
      const k = parser.cardKey(card);
      if (!k) continue;
      keyByCard.set(card, k);
      keys.push(k);
    }
    if (!keys.length) return;
    const seenRes = await JC.send("SEEN", keys);
    const seen = seenRes.ok ? seenRes.data : {};

    for (const card of cards) {
      card.dataset.jobcapture = "1";
      const k = keyByCard.get(card);
      const entry = seen[k];
      const state = entry ? entry.state : "new";
      decorate(card, state);
    }
  }

  function decorate(card, state) {
    const anchor = parser.badgeAnchor?.(card);
    if (anchor && !anchor.querySelector(".jc-badge")) {
      const b = document.createElement("span");
      b.className = "jc-badge";
      b.textContent = " " + (BADGE[state] || BADGE.new);
      b.title = `Job Hunt Assistant: ${state}`;
      anchor.appendChild(b);
    }
    card.classList.remove("jc-applied", "jc-skipped", "jc-fresh", "jc-hidden");
    if (state === "applied") card.classList.add("jc-applied");
    else if (state === "skipped") card.classList.add("jc-skipped");
    else if (state === "notified" || state === "relevant") card.classList.add("jc-fresh");
    if (hideMasked && (state === "applied" || state === "skipped")) card.classList.add("jc-hidden");
  }

  // 3. Interest signal — human opened a detail view.
  async function runViewed() {
    const target = parser.viewedTarget?.(document);
    if (!target) return;
    if (document.documentElement.dataset.jcViewed === target.cardKey) return;
    document.documentElement.dataset.jcViewed = target.cardKey;
    const seenRes = await JC.send("SEEN", [target.cardKey]);
    const entry = seenRes.ok ? seenRes.data[target.cardKey] : null;
    JC.send("EVENT", {
      source: parser.source,
      event: "viewed",
      jobId: entry?.id ?? null,
      url: target.url,
    });
    showDetailChip(entry, target);
  }

  function showDetailChip(entry, target) {
    if (document.getElementById("jc-detail-chip")) return;
    const state = entry?.state ?? "discovered";
    const jobId = entry?.id;
    const chip = document.createElement("div");
    chip.id = "jc-detail-chip";
    chip.className = "jc-detail-chip";
    const label = state === "applied" ? "✅ Applied" : "🆕 Not applied";
    chip.innerHTML = `<span class="jc-chip-label">${label}</span>`;
    if (jobId) {
      const gen = document.createElement("button");
      gen.textContent = "Generate résumé";
      gen.onclick = () => {
        window.open(`http://localhost:5173/#job/${jobId}`, "_blank");
      };
      chip.appendChild(gen);
    }
    document.body.appendChild(chip);
  }

  // 4. Referral leads.
  async function runReferrals() {
    if (document.documentElement.dataset.jcReferral) return;
    const raw = parser.parseReferralRaw?.(document);
    if (!raw) return;
    document.documentElement.dataset.jcReferral = "1";
    JC.send("EVENT", { source: parser.source, event: "thread_opened", url: raw.threadUrl });
    await JC.send("REFERRAL_INGEST", raw);
  }

  // 5. Apply page (cross-cutting).
  function runApplyPage() {
    if (!parser.isApplyPage?.(location.href, document)) return;
    if (document.getElementById("jc-apply-bar")) return;
    JC.send("EVENT", { source: parser.source, event: "apply_page_opened", url: location.href });

    const ctx = parser.applyContext?.(document) || { url: location.href, rawText: document.body.innerText.slice(0, 12000) };
    JC.send("PAGE_CAPTURE", { url: ctx.url, source: parser.source, rawText: ctx.rawText, externalId: ctx.externalId });

    const bar = document.createElement("div");
    bar.id = "jc-apply-bar";
    bar.innerHTML = `<span>Job Hunt Assistant — applying?</span>`;
    const mk = (label, tailored) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.onclick = () => {
        JC.send("EVENT", { source: parser.source, event: "apply_intent", url: location.href, meta: { tailored } });
        bar.querySelector(".jc-done")?.remove();
        const done = document.createElement("span");
        done.className = "jc-done";
        done.textContent = tailored ? " ✓ tailoring noted" : " ✓ noted";
        bar.appendChild(done);
      };
      return btn;
    };
    bar.appendChild(mk("Tailor for this job", true));
    bar.appendChild(mk("Apply as-is", false));
    const close = document.createElement("button");
    close.textContent = "✕";
    close.className = "jc-close";
    close.onclick = () => bar.remove();
    bar.appendChild(close);
    document.body.appendChild(bar);
  }

  async function processAll() {
    try {
      if (parser.kind === "listings") {
        await runListings();
        await runViewed();
      } else if (parser.kind === "referrals") {
        await runReferrals();
      }
      runApplyPage(); // cross-cutting
    } catch (e) {
      console.warn("[jobcapture]", e);
    }
  }

  // 6. Observe dynamic content.
  const scheduled = debounce(processAll, 500);
  const obs = new MutationObserver(scheduled);
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // Allow the popup to toggle masking.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "TOGGLE_HIDE_MASKED") {
      hideMasked = !!msg.value;
      document.querySelectorAll("[data-jobcapture]").forEach((c) => (c.dataset.jobcapture = ""));
      processAll();
    }
  });

  processAll();
})();
