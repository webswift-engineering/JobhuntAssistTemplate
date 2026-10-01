// Tiered JD acquisition for a single card.
//   Tier 1: fetch the detail URL + parse JSON-LD (universal, non-disruptive).
//   Tier 2: click the card and scrape the in-page detail pane (two-pane sites).
//           Indeed gets a dedicated Tier 2: fetches are Cloudflare-blocked there, so
//           the user's own (trusted) tab is the only reliable JD source — we read the
//           already-open vjk pane and select cards the way Indeed's serp itself does.
//   Tier 3: open the URL in a background tab and run extract.js (click-through sites).
(function () {
  const JCS = (window.__JCSCAN = window.__JCSCAN || {});

  // Cap heavy background-tab scrapes per scan so a large list (e.g. LinkedIn's ~25
  // cards) doesn't spawn dozens of tabs. Remaining cards fall back to title-only triage.
  const MAX_TAB_SCRAPES = 6;
  let tabScrapes = 0;

  const DETAIL_SELECTORS = [
    ".jobs-search__job-details", ".jobs-details", ".scaffold-layout__detail",
    ".jobs-description__content", "#job-details",
    ".jobsearch-JobComponent", "[data-testid='jobsearch-JobInfoHeader']",
    "#jobsearch-ViewjobPaneWrapper", "#jobDescriptionText", "#mosaic-vjJobDetails",
  ];
  const JD_KEYWORDS = /responsibilities|requirements|qualifications|about the (job|role)|what you'?ll do|who you are|minimum|preferred/i;

  const isTwoPane = () => DETAIL_SELECTORS.some((s) => document.querySelector(s));

  /** Top document plus any same-origin iframes (Indeed renders the pane in one on some layouts). */
  function scanDocs() {
    const docs = [document];
    for (const f of document.querySelectorAll("iframe")) {
      try {
        const d = f.contentDocument;
        if (d && d.body) docs.push(d);
      } catch {
        /* cross-origin iframe — unreadable */
      }
    }
    return docs;
  }

  /** Longest on-page text block that reads like a job description. */
  function scrapeJdBlock() {
    let best = "";
    for (const doc of scanDocs()) {
      for (const sel of [...DETAIL_SELECTORS, "main", "article"]) {
        for (const el of doc.querySelectorAll(sel)) {
          const t = (el.innerText || el.textContent || "").trim();
          if (t.length > best.length && JD_KEYWORDS.test(t)) best = t;
        }
      }
    }
    return best.length > 400 ? best.slice(0, 20000) : "";
  }

  async function fetchHtml(url) {
    // Same-origin fetch runs directly from the page (no host permission needed);
    // cross-origin goes through the background worker (needs granted host permission).
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === location.origin;
    } catch {
      return null;
    }
    if (sameOrigin) {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) return null;
        return await res.text();
      } catch {
        return null;
      }
    }
    const res = await JCS.send("FETCH_JD", { url });
    return res && res.ok ? res.text : null;
  }

  async function tier1Fetch(card) {
    if (!card.href) return null;
    const html = await fetchHtml(card.href);
    if (!html) return null;
    const job = JCS.extractJsonLdJob(html);
    if (job && job.description && job.description.length > 200) {
      return { description: job.description, tier: "fetch-jsonld" };
    }
    return null;
  }

  async function tier2Click(card) {
    if (!card.el || !isTwoPane()) return null;

    // NEVER hijack the user's tab: if the card's clickable is an anchor that points
    // to a DIFFERENT page (e.g. Indeed's /viewjob), skip clicking and let Tier-1
    // fetch / Tier-3 background tab handle it. Only click same-page (SPA) cards.
    const anchor = card.el.querySelector("a[href]");
    if (anchor) {
      try {
        const dest = new URL(anchor.getAttribute("href"), location.href);
        if (dest.pathname !== location.pathname) return null;
      } catch {
        return null;
      }
    }

    const before = location.href;
    const beforeLen = scrapeJdBlock().length;
    const target = anchor || card.el;
    try {
      target.click();
    } catch {
      return null;
    }
    // Two-pane selection updates the detail block without a hard navigation.
    const changed = await JCS.waitFor(
      () => {
        const t = scrapeJdBlock();
        return t && t.length !== beforeLen ? t : null;
      },
      { timeout: 3000 }
    );
    // If we hard-navigated away, the list is gone — bail (caller may retry via tab).
    if (location.pathname !== new URL(before).pathname && !isTwoPane()) return null;
    return changed ? { description: changed, tier: "click-pane" } : null;
  }

  // ---- Indeed Tier 2 --------------------------------------------------------
  // Indeed sits behind Cloudflare: background fetch() (Tier 1) gets 403s and fresh
  // background tabs (Tier 3) often hit "verify you are human" interstitials. The
  // user's own tab is trusted, so scrape the detail pane there instead.

  const isIndeed = () => /(^|\.)indeed\./i.test(location.hostname);

  // Precise pane selectors, most specific first (unlike scrapeJdBlock we don't want
  // "longest block on the page" — on Indeed's serp that would be the whole card list).
  const INDEED_JD_SELECTORS = [
    "#jobDescriptionText",
    ".jobsearch-JobComponent-description",
    "#jobsearch-ViewjobPaneWrapper",
    ".jobsearch-JobComponent",
    "#mosaic-vjJobDetails",
  ];
  const INDEED_PANE_SEL = INDEED_JD_SELECTORS.join(",") + ",#vjs-container-iframe,.jobsearch-RightPane";

  const hasIndeedPane = () => scanDocs().some((d) => d.querySelector(INDEED_PANE_SEL));

  /** JD text from the Indeed detail pane (top document or same-origin iframe). */
  function scrapeIndeedPane() {
    for (const doc of scanDocs()) {
      for (const sel of INDEED_JD_SELECTORS) {
        for (const el of doc.querySelectorAll(sel)) {
          const t = (el.innerText || el.textContent || "").trim();
          if (t.length > 200) return t.slice(0, 20000);
        }
      }
    }
    return "";
  }

  /** Job id (jk) of whatever the Indeed pane / viewjob page currently shows. */
  function indeedOpenJobId() {
    const p = new URLSearchParams(location.search);
    return p.get("vjk") || (/\/viewjob/i.test(location.pathname) ? p.get("jk") : null);
  }

  async function tier2Indeed(card) {
    if (!isIndeed()) return null;

    // The pane for this card is already open (vjk= in the URL) — just read it.
    if (card.externalId && indeedOpenJobId() === card.externalId) {
      const t = await JCS.waitFor(() => scrapeIndeedPane() || null, { timeout: 2000, interval: 200 });
      if (t) return { description: t, tier: "open-pane" };
    }

    if (!card.el || !hasIndeedPane()) return null;

    const beforePath = location.pathname;
    const beforeText = scrapeIndeedPane();
    const target =
      card.el.querySelector("a[id^='job_'], h2 a[href], a.jcs-JobTitle, a[data-jk]") ||
      card.el.querySelector("a[href]") ||
      card.el;

    // Select the card the way Indeed itself does: its serp JS intercepts the click
    // and swaps the pane (pushState + vjk=). Suppress the anchor's default navigation
    // ourselves so a missing/changed handler can never hijack the user's tab —
    // Indeed's own listener still runs and updates the pane.
    const guard = (e) => e.preventDefault();
    window.addEventListener("click", guard, { capture: true, once: true });
    try {
      target.click();
    } catch {
      return null;
    } finally {
      window.removeEventListener("click", guard, { capture: true });
    }

    const text = await JCS.waitFor(
      () => {
        if (location.pathname !== beforePath) return null;
        if (card.externalId && indeedOpenJobId() !== card.externalId) return null;
        const t = scrapeIndeedPane();
        return t && t !== beforeText ? t : null;
      },
      { timeout: 5000, interval: 200 }
    );
    if (location.pathname !== beforePath) return null;
    return text ? { description: text, tier: "click-pane" } : null;
  }

  // ---------------------------------------------------------------------------

  const BOT_WALL_RE = /verify you are human|checking your browser|review the security of your connection|are you a robot/i;

  async function tier3Tab(card) {
    if (!card.href) return null;
    if (tabScrapes >= MAX_TAB_SCRAPES) return null;
    tabScrapes++;
    const res = await JCS.send("OPEN_TAB_SCRAPE", { url: card.href });
    if (
      res && res.ok && res.description && res.description.length > 200 &&
      !BOT_WALL_RE.test(res.description.slice(0, 800))
    ) {
      return { description: res.description, tier: "background-tab" };
    }
    return null;
  }

  /** Acquire a JD for one card, trying the cheapest/least-disruptive tier first. */
  JCS.acquireJd = async function (card) {
    // Indeed: Tier 1 fetches are Cloudflare-403'd, so the in-tab pane comes first.
    if (isIndeed()) {
      const t2i = await tier2Indeed(card);
      if (t2i) return t2i;
    }

    const t1 = await tier1Fetch(card);
    if (t1) return t1;

    if (!isIndeed() && isTwoPane()) {
      const t2 = await tier2Click(card);
      if (t2) return t2;
    }

    const t3 = await tier3Tab(card);
    if (t3) return t3;

    return { description: null, tier: "none" };
  };
})();
