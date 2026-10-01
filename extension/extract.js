// Self-contained page extractor — injected via chrome.scripting.executeScript on any tab.
(function () {
  const MAX_JD = 50000;

  function stripHtml(html) {
    const d = document.createElement("div");
    d.innerHTML = html || "";
    return (d.textContent || d.innerText || "").replace(/\s+/g, " ").trim();
  }

  function meta(name) {
    return document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.getAttribute("content")?.trim() || null;
  }

  function canonicalUrl() {
    return document.querySelector('link[rel="canonical"]')?.href || location.href;
  }

  function hostSource(host) {
    const h = host.toLowerCase();
    if (h.includes("linkedin.com")) return "linkedin";
    if (h.includes("indeed.com")) return "indeed";
    if (h.includes("greenhouse.io")) return "greenhouse";
    if (h.includes("lever.co")) return "lever";
    if (h.includes("myworkdayjobs.com") || h.includes("workday.com")) return "workday";
    if (h.includes("ashbyhq.com")) return "ashby";
    return host.replace(/^www\./, "");
  }

  function atsExternalId(url, source) {
    try {
      const u = new URL(url);
      if (source === "greenhouse") {
        const m = u.pathname.match(/\/([^/]+)\/jobs\/(\d+)/);
        return m ? `${m[1]}:${m[2]}` : null;
      }
      if (source === "lever") {
        const m = u.pathname.match(/\/([^/]+)\/([^/?#]+)/);
        return m ? `${m[1]}:${m[2]}` : null;
      }
      if (source === "ashby") {
        const m = u.pathname.match(/\/([^/]+)\/([^/?#]+)/);
        return m ? m[2] : null;
      }
      if (source === "workday") {
        // Match the ATS poll's externalPath shape ("/job/<City>/<Title_Req>") so
        // page captures dedup against polled rows; drop any /apply/... suffix.
        const m = u.pathname.match(/\/job\/[^?#]+/);
        return m ? m[0].replace(/\/apply(\/.*)?$/, "") : null;
      }
      if (source === "indeed") {
        // vjk = open pane on a search page; jk = /viewjob detail page (query, not path).
        return u.searchParams.get("vjk") || u.searchParams.get("jk") || null;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /** Strip LinkedIn chrome; keep full JD from "About the job" through compensation. */
  function cleanLinkedInJd(text) {
    if (!text) return "";
    const start = text.search(/\bAbout the job\b/i);
    const slice = start >= 0 ? text.slice(start) : text;
    const endPatterns = [
      /\bSimilar jobs\b/i,
      /\bSee more jobs\b/i,
      /\bPeople also viewed\b/i,
      /\bSet job alert\b/i,
      /\bJoin now\b.*Sign in/i,
    ];
    let end = slice.length;
    for (const re of endPatterns) {
      const i = slice.search(re);
      if (i > 400 && i < end) end = i;
    }
    return slice.slice(0, end).trim().slice(0, MAX_JD);
  }

  function extractSalary(text) {
    if (!text) return null;
    const patterns = [
      /British Columbia\/Ontario\s+(\$[\d,]+(?:\.\d+)?\s*(?:to|–|-)\s*\$[\d,]+(?:\.\d+)?)/i,
      /Role Location[^\n]*Annual Salary Range[\s\S]{0,200}?(\$[\d,]+(?:\.\d+)?\s*(?:to|–|-)\s*\$[\d,]+(?:\.\d+)?)/i,
      /(\$[\d,]+(?:\.\d+)?\s*(?:to|–|-)\s*\$[\d,]+(?:\.\d+)?(?:\s*(?:CAD|USD))?)/i,
      /([\d.]+\s*[Kk]\s*(?:CAD|USD)\/yr(?:\s*-\s*[\d.]+\s*[Kk]\s*(?:CAD|USD)\/yr)?)/,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return m[1].replace(/\s+/g, " ").trim();
    }
    return null;
  }

  function linkedInJobPanel() {
    const candidates = [
      ".jobs-search__job-details",
      ".jobs-search__job-details--container",
      ".jobs-details",
      ".jobs-details__main-content",
      ".scaffold-layout__detail",
      "[data-job-details]",
      ".jobs-search__right-column",
      ".job-view-layout",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /** Find the richest JD block on LinkedIn split-view / detail pages. */
  function findLinkedInJdText() {
    const selectors = [
      ".jobs-description__content",
      ".jobs-box__html-content",
      ".jobs-description-content__text",
      ".jobs-description-content__text--stretch",
      "#job-details",
      ".jobs-description",
      ".jobs-search__job-details",
      ".jobs-details",
      ".scaffold-layout__detail",
    ];
    let best = "";
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.innerText || el.textContent || "").trim();
        if (/About the job/i.test(t) && t.length > best.length) best = t;
      }
    }
    if (best) return cleanLinkedInJd(best);

    const panel = linkedInJobPanel();
    if (panel) {
      const t = (panel.innerText || "").trim();
      if (/About the job/i.test(t)) return cleanLinkedInJd(t);
    }

    const body = document.body?.innerText || "";
    if (/About the job/i.test(body)) return cleanLinkedInJd(body);

    return "";
  }

  function linkedInExtract() {
    const panel = linkedInJobPanel();
    const id =
      new URLSearchParams(location.search).get("currentJobId") ||
      location.href.match(/\/jobs\/view\/(\d+)/)?.[1] ||
      null;
    const scope = panel || document;
    const title =
      scope.querySelector(".job-details-jobs-unified-top-card__job-title")?.textContent?.trim() ||
      scope.querySelector(".jobs-unified-top-card__job-title")?.textContent?.trim() ||
      scope.querySelector("h1")?.textContent?.trim() ||
      document.querySelector("h1")?.textContent?.trim() ||
      null;
    const company =
      scope.querySelector(".job-details-jobs-unified-top-card__company-name a")?.textContent?.trim() ||
      scope.querySelector(".jobs-unified-top-card__company-name a")?.textContent?.trim() ||
      scope.querySelector(".job-details-jobs-unified-top-card__primary-description-without-tagline a")?.textContent?.trim() ||
      scope.querySelector(".job-details-jobs-unified-top-card__primary-description a")?.textContent?.trim() ||
      scope.querySelector("a[href*='/company/']")?.textContent?.trim() ||
      null;
    const locEl =
      scope.querySelector(".job-details-jobs-unified-top-card__bullet") ||
      scope.querySelector(".jobs-unified-top-card__bullet") ||
      scope.querySelector(".job-details-jobs-unified-top-card__primary-description-without-tagline");
    const locationText = locEl?.textContent?.trim() || null;
    const rawText = findLinkedInJdText();
    const salaryText = extractSalary(rawText);
    const jobUrl = id ? `https://www.linkedin.com/jobs/view/${id}/` : location.href;
    return { id, title, company, location: locationText, rawText, salaryText, jobUrl };
  }

  // ---- Indeed ---------------------------------------------------------------

  /** Top document plus same-origin iframes (Indeed's detail pane lives in one on some layouts). */
  function indeedDocs() {
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

  function indeedQuery(selector) {
    for (const doc of indeedDocs()) {
      const el = doc.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  /** JD text from #jobDescriptionText (or the viewjob pane as fallback), iframe-aware. */
  function indeedJdText() {
    const selectors = [
      "#jobDescriptionText",
      ".jobsearch-JobComponent-description",
      "[data-testid='jobsearch-JobComponent-description']",
    ];
    let best = "";
    for (const doc of indeedDocs()) {
      for (const sel of selectors) {
        for (const el of doc.querySelectorAll(sel)) {
          const t = (el.innerText || el.textContent || "").trim();
          if (t.length > best.length) best = t;
        }
      }
    }
    if (best) return best.slice(0, MAX_JD);

    // Fall back to the whole detail pane, minus the similar-jobs rail.
    const pane = indeedQuery("#jobsearch-ViewjobPaneWrapper, .jobsearch-JobComponent, #viewJobSSRRoot, #mosaic-vjJobDetails");
    if (pane) {
      let t = (pane.innerText || "").trim();
      const cut = t.search(/\bSimilar jobs\b|\bJobs based on your (search|activity)\b/i);
      if (cut > 400) t = t.slice(0, cut);
      return t.slice(0, MAX_JD);
    }
    return "";
  }

  /**
   * Indeed viewjob pages and serp detail panes. Header selectors only exist inside
   * the pane / viewjob body, so on a search page this naturally scopes to the open
   * job rather than the result cards.
   */
  function indeedExtract() {
    const params = new URLSearchParams(location.search);
    const id = params.get("vjk") || params.get("jk") || null;

    let title =
      indeedQuery("[data-testid='jobsearch-JobInfoHeader-title'], h1.jobsearch-JobInfoHeader-title, .jobsearch-JobInfoHeader-title")
        ?.textContent?.trim() || null;
    if (title) title = title.replace(/\s*-\s*job post\s*$/i, "").trim();

    const company =
      indeedQuery("[data-testid='inlineHeader-companyName']")?.textContent?.trim() ||
      indeedQuery("div[data-company-name='true']")?.textContent?.trim() ||
      indeedQuery("[data-testid='jobsearch-CompanyInfoContainer'] a")?.textContent?.trim() ||
      null;

    const locationText =
      indeedQuery("[data-testid='inlineHeader-companyLocation']")?.textContent?.trim() ||
      indeedQuery("[data-testid='jobsearch-JobInfoHeader-companyLocation']")?.textContent?.trim() ||
      indeedQuery("[data-testid='job-location']")?.textContent?.trim() ||
      null;

    const rawText = indeedJdText();
    const salaryText =
      indeedQuery("#salaryInfoAndJobType")?.textContent?.trim() || extractSalary(rawText);
    const jobUrl = id ? `${location.origin}/viewjob?jk=${id}` : location.href;
    return { id, title, company, location: locationText, rawText, salaryText, jobUrl };
  }

  // ---------------------------------------------------------------------------

  function jsonLdJobPosting() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent || "");
        const nodes = Array.isArray(data) ? data : [data];
        for (const node of nodes) {
          const type = node["@type"];
          const types = Array.isArray(type) ? type : [type];
          if (!types.some((t) => t === "JobPosting")) continue;
          const org = node.hiringOrganization;
          const company = (typeof org === "string" ? org : org?.name) || null;
          let loc = null;
          const jl = node.jobLocation;
          if (jl) {
            const addr = Array.isArray(jl) ? jl[0]?.address : jl.address;
            if (typeof addr === "string") loc = addr;
            else if (addr) loc = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(", ");
          }
          let externalId = null;
          const ident = node.identifier;
          if (ident?.value) externalId = String(ident.value);
          const description = stripHtml(node.description || "");
          return {
            title: node.title || null,
            company,
            location: loc,
            description,
            url: node.url || null,
            externalId,
            salaryText: extractSalary(description),
          };
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function __jcExtractJob() {
    const url = canonicalUrl();
    const host = location.hostname;
    const source = hostSource(host);
    const ld = jsonLdJobPosting();
    let title = ld?.title || null;
    let company = ld?.company || null;
    let locationText = ld?.location || null;
    let externalId = ld?.externalId || null;
    let rawText = ld?.description || "";
    let salaryText = ld?.salaryText || null;
    let pageUrl = ld?.url || url;

    if (source === "linkedin") {
      const li = linkedInExtract();
      title = title || li.title;
      company = company || li.company;
      locationText = locationText || li.location;
      externalId = externalId || li.id;
      if (li.rawText.length > rawText.length) rawText = li.rawText;
      salaryText = salaryText || li.salaryText || extractSalary(rawText);
      pageUrl = li.jobUrl || pageUrl;
    }

    if (source === "indeed") {
      const ind = indeedExtract();
      // Prefer the pane DOM: on a serp the page-level JSON-LD (if any) doesn't
      // describe the job that's open in the vjk pane.
      title = ind.title || title;
      company = ind.company || company;
      locationText = ind.location || locationText;
      externalId = ind.id || externalId;
      if (ind.rawText.length > rawText.length) rawText = ind.rawText;
      salaryText = salaryText || ind.salaryText || extractSalary(rawText);
      pageUrl = ind.jobUrl || pageUrl;
    }

    if (!title) {
      title = document.querySelector("h1")?.textContent?.trim() || document.title?.split("|")[0]?.trim() || null;
    }
    if (!company) {
      company = meta("og:site_name") || null;
    }
    if (!externalId) {
      externalId = atsExternalId(url, source);
    }

    if (!rawText || rawText.length < 80) {
      const sel = window.getSelection?.()?.toString?.()?.trim();
      if (sel && sel.length > 80) {
        rawText = sel;
      } else if (source === "indeed") {
        // Body dump only makes sense on a detail view — on a serp without an open
        // pane it would just be the result-card list.
        if (/\/viewjob/i.test(location.pathname) || new URLSearchParams(location.search).get("vjk")) {
          rawText = (document.body?.innerText || "").slice(0, MAX_JD);
        }
      } else if (source !== "linkedin") {
        rawText = (document.body?.innerText || "").slice(0, MAX_JD);
      }
    }

    if (source === "linkedin") {
      rawText = cleanLinkedInJd(rawText);
    }

    if (!salaryText) {
      salaryText = extractSalary(rawText);
    }

    const payload = {
      source,
      title,
      company,
      location: locationText,
      url: pageUrl,
      externalId,
      rawText: rawText.slice(0, MAX_JD),
      salaryText,
      captureKind: "right_click",
    };

    if (source === "linkedin" && externalId) {
      console.debug("[jobcapture] dedup key:", `linkedin:${String(externalId).trim()}`, "jd chars:", payload.rawText.length);
    }

    return payload;
  }

  window.__jcExtractJob = __jcExtractJob;
  return __jcExtractJob();
})();
