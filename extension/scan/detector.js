// Finds job cards in a search-results list. Tries, in order: a registered site
// parser (LinkedIn/Indeed via window.__JOBCAPTURE), a LinkedIn-specific strategy
// keyed on stable attributes, then a generic depth-agnostic sibling detector.
(function () {
  const JCS = (window.__JCSCAN = window.__JCSCAN || {});

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  function hash(str) {
    let h = 5381;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  function dedupKeyFor(card, sourceHint) {
    const JC = window.__JOBCAPTURE;
    if (JC && card.externalId && sourceHint) {
      try {
        return JC.dedupKey({ source: sourceHint, externalId: card.externalId });
      } catch {
        /* fall through */
      }
    }
    const composite = `${clean(card.company).toLowerCase()}|${clean(card.title).toLowerCase()}|${clean(
      card.location
    ).toLowerCase()}`;
    return "scan:" + hash(composite);
  }

  const JOB_HREF_RE = /\/(jobs?|careers?|positions?|opening|viewjob|vacanc)/i;

  function safeParam(href, name) {
    try {
      return new URL(href, location.href).searchParams.get(name);
    } catch {
      return null;
    }
  }

  function pickHref(el) {
    const anchors = Array.from(el.querySelectorAll("a[href]"));
    if (!anchors.length) return null;
    const job = anchors.find((a) => JOB_HREF_RE.test(a.getAttribute("href") || ""));
    const a = job || anchors[0];
    try {
      return new URL(a.getAttribute("href"), location.href).href;
    } catch {
      return null;
    }
  }

  function pickText(el, selectors) {
    for (const sel of selectors) {
      const node = el.querySelector(sel);
      const t = clean(node?.textContent);
      if (t) return t;
    }
    return null;
  }

  /** Extract a card's fields from its DOM element. Returns null if no usable title. */
  function extractCard(el, sourceHint) {
    const href = pickHref(el);
    let title =
      pickText(el, [
        "h2 a", "h3 a", "a[class*='title' i]", "[class*='title' i] a",
        "[class*='JobTitle' i]", "h2", "h3", "strong",
      ]) ||
      clean(el.querySelector("a[aria-label]")?.getAttribute("aria-label")) ||
      clean(el.querySelector("a[href*='/jobs/view/']")?.textContent) ||
      clean(el.querySelector("a[href]")?.getAttribute("aria-label")) ||
      clean(el.querySelector("a[href]")?.textContent);
    if (title && title.length > 160) title = title.slice(0, 160);
    if (!title || title.length < 3) return null;

    const company = pickText(el, [
      "[data-testid='company-name']",
      "[class*='company' i]",
      "[class*='employer' i]",
      "[class*='subtitle' i]",
    ]);
    const locationText = pickText(el, [
      "[data-testid='text-location']",
      "[class*='location' i]",
      "[class*='caption' i]",
      "[class*='metadata' i]",
    ]);

    const externalId =
      el.getAttribute("data-job-id") ||
      el.getAttribute("data-occludable-job-id") ||
      el.querySelector("[data-job-id]")?.getAttribute("data-job-id") ||
      el.getAttribute("data-jk") ||
      el.querySelector("[data-jk]")?.getAttribute("data-jk") ||
      el.querySelector("a[id^='job_']")?.id?.replace(/^job_/, "") ||
      (href && (href.match(/\/jobs\/view\/(\d+)/)?.[1] || safeParam(href, "jk") || safeParam(href, "currentJobId"))) ||
      null;

    const card = { el, title: clean(title), company, location: locationText, href, externalId };
    card.dedupKey = dedupKeyFor(card, sourceHint);
    return card;
  }

  function collect(cards, el, sourceHint, seen, titleAnchor) {
    const card = extractCard(el, sourceHint);
    if (!card) return;
    if (seen.has(card.dedupKey)) return;
    seen.add(card.dedupKey);
    if (titleAnchor) card.badgeAnchor = titleAnchor;
    cards.push(card);
  }

  /** Registered-parser path: iterate the parser's card selector. */
  function detectViaParser() {
    const JC = window.__JOBCAPTURE;
    if (!JC || !JC.pick) return null;
    const parser = JC.pick(location.href);
    if (!parser || !parser.cardSelector) return null;
    const els = Array.from(document.querySelectorAll(parser.cardSelector));
    if (!els.length) return null;
    const cards = [];
    const seen = new Set();
    for (const el of els) {
      const card = extractCard(el, parser.source);
      if (!card) continue;
      try {
        const k = parser.cardKey?.(el);
        if (k) card.dedupKey = k;
      } catch {
        /* keep generic key */
      }
      if (seen.has(card.dedupKey)) continue;
      seen.add(card.dedupKey);
      card.badgeAnchor = parser.badgeAnchor?.(el) || null;
      cards.push(card);
    }
    return cards.length >= 3 ? { source: parser.source, cards } : null;
  }

  const LI_WRAPPER_SEL = [
    "li[data-occludable-job-id]",
    "[data-job-id]",
    "li.scaffold-layout__list-item",
    "div.job-card-container",
    ".job-card-job-posting-card-wrapper",
    "[data-view-name='job-card']",
  ].join(",");

  const LOCATION_RE = /remote|hybrid|on-?site|,|\bcanada\b|\bunited states\b|\bontario\b|\bquebec\b|\bbritish columbia\b|\balberta\b|\b[A-Z]{2}\b/;

  /** Build a LinkedIn card from its SDUI wrapper element + job id. */
  function linkedInCard(el, id) {
    const lines = (el.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);

    let title = null;
    const dismiss = el.querySelector("[aria-label^='Dismiss' i]");
    const dm = dismiss?.getAttribute("aria-label")?.match(/^Dismiss\s+(.+?)\s+job$/i);
    if (dm) title = dm[1];
    if (!title) title = lines[0] || null;
    if (!title) return null;

    const rest = lines.filter((l) => l !== title);
    const company = rest[0] || null;
    const location = rest.slice(1).find((l) => LOCATION_RE.test(l)) || rest[1] || null;

    const href = `https://www.linkedin.com/jobs/view/${id}/`;
    const card = {
      el,
      title: clean(title),
      company: clean(company),
      location: clean(location),
      href,
      externalId: id,
    };
    card.dedupKey = dedupKeyFor(card, "linkedin");
    return card;
  }

  /**
   * LinkedIn-specific detection. The current /jobs/search-results/ layout uses fully
   * hashed class names and no data-job-id; job cards are identified by
   * componentkey="job-card-component-ref-<id>". Card ids live only in that attribute
   * (the list links use currentJobId inside embedded JSON, not hrefs).
   */
  function detectLinkedIn() {
    if (!/linkedin\.com/i.test(location.hostname)) return null;

    // Strategy A: SDUI componentkey job cards (current layout).
    const byId = new Map();
    for (const el of document.querySelectorAll("[componentkey*='job-card-component-ref-']")) {
      const m = (el.getAttribute("componentkey") || "").match(/job-card-component-ref-(\d+)/);
      if (!m) continue;
      const id = m[1];
      const prev = byId.get(id);
      // Multiple nested nodes share the id; keep the role=button (outermost) card.
      const isButton = el.getAttribute("role") === "button";
      if (!prev) byId.set(id, el);
      else if (isButton && prev.getAttribute("role") !== "button") byId.set(id, el);
    }
    if (byId.size >= 3) {
      const cards = [];
      const seen = new Set();
      for (const [id, el] of byId) {
        const card = linkedInCard(el, id);
        if (!card || seen.has(card.dedupKey)) continue;
        seen.add(card.dedupKey);
        cards.push(card);
      }
      if (cards.length >= 3) return { source: "linkedin", cards };
    }

    // Strategy B (older layouts): /jobs/view/ or currentJobId links + wrapper.
    const links = Array.from(
      document.querySelectorAll("a[href*='/jobs/view/'], a[href*='currentJobId='], a[data-job-id]")
    );
    const cards = [];
    const seen = new Set();
    for (const link of links) {
      const wrapper = link.closest(LI_WRAPPER_SEL) || link.parentElement;
      if (!wrapper) continue;
      collect(cards, wrapper, "linkedin", seen, link);
    }
    if (cards.length >= 3) return { source: "linkedin", cards };

    const wrappers = Array.from(document.querySelectorAll(LI_WRAPPER_SEL));
    for (const w of wrappers) collect(cards, w, "linkedin", seen, null);
    return cards.length >= 3 ? { source: "linkedin", cards } : null;
  }

  /**
   * Indeed-specific. Cards are [data-testid="slider_item"] (or legacy .job_seen_beacon);
   * title links use /rc/clk?jk=... (not matched by the generic job-link regex), and the
   * jk id lives in the anchor href / id / data-jk. Company & location use data-testid.
   */
  function detectIndeed() {
    if (!/indeed\./i.test(location.hostname)) return null;
    const els = Array.from(
      document.querySelectorAll(
        '[data-testid="slider_item"], .job_seen_beacon, .cardOutline, [data-jk]'
      )
    );
    const cards = [];
    const seen = new Set();
    for (const el of els) {
      const card = extractCard(el, "indeed");
      if (!card) continue;
      // Prefer a clean viewjob URL built from the jk id.
      if (card.externalId) card.href = `${location.origin}/viewjob?jk=${card.externalId}`;
      if (seen.has(card.dedupKey)) continue;
      seen.add(card.dedupKey);
      cards.push(card);
    }
    return cards.length >= 3 ? { source: "indeed", cards } : null;
  }

  function hasJobAnchor(el) {
    if (!el || !el.querySelectorAll) return false;
    for (const a of el.querySelectorAll("a[href]")) {
      if (JOB_HREF_RE.test(a.getAttribute("href") || "")) return true;
    }
    return false;
  }

  /**
   * Generic path: for each job link, climb until we find the ancestor whose PARENT
   * holds several sibling cards (>=3 job-anchor children). Depth-agnostic.
   */
  function detectGeneric() {
    const anchors = Array.from(document.querySelectorAll("a[href]")).filter((a) =>
      JOB_HREF_RE.test(a.getAttribute("href") || "")
    );
    const roots = new Set();
    for (const a of anchors) {
      let node = a;
      let hops = 0;
      while (node && node.parentElement && hops < 15) {
        const parent = node.parentElement;
        if (parent === document.body) break;
        const siblingCards = Array.from(parent.children).filter(
          (c) => c !== node && hasJobAnchor(c)
        );
        if (siblingCards.length >= 2) {
          roots.add(node);
          break;
        }
        node = parent;
        hops++;
      }
    }
    const cards = [];
    const seen = new Set();
    for (const el of roots) collect(cards, el, null, seen, null);
    return cards.length >= 3 ? { source: "generic", cards } : null;
  }

  /** Snapshot of what's on the page, surfaced when detection fails (debugging aid). */
  function diagnostics() {
    const q = (sel) => {
      try {
        return document.querySelectorAll(sel).length;
      } catch {
        return -1;
      }
    };
    return {
      jobHrefAnchors: Array.from(document.querySelectorAll("a[href]")).filter((a) =>
        JOB_HREF_RE.test(a.getAttribute("href") || "")
      ).length,
      componentKeyCards: q("[componentkey*='job-card-component-ref-']"),
      viewLinks: q("a[href*='/jobs/view/']"),
      currentJobIdLinks: q("a[href*='currentJobId=']"),
      dataJobId: q("[data-job-id],[data-occludable-job-id]"),
      sliderItems: q("[data-testid='slider_item']"),
      dataJk: q("[data-jk]"),
      liItems: q("li.scaffold-layout__list-item"),
      jcRegistry: !!window.__JOBCAPTURE,
    };
  }

  // Shared helpers for the AI adapter applier (scan/adapter.js).
  JCS._clean = clean;
  JCS._dedupKeyFor = dedupKeyFor;

  /** Detect job cards on the current page. Returns { source, cards[] } or null. */
  JCS.detectCards = function () {
    const result = detectViaParser() || detectLinkedIn() || detectIndeed() || detectGeneric();
    JCS.lastDiag = diagnostics();
    try {
      console.debug("[jc-scan] detect:", result ? `${result.source} ${result.cards.length} cards` : "none", JCS.lastDiag);
    } catch {
      /* ignore */
    }
    return result;
  };
})();
