// Indeed listings parser. Selectors are brittle (hard flag) — fail soft per card.
(function () {
  const JC = window.__JOBCAPTURE;
  const txt = (root, sel) => root.querySelector(sel)?.textContent?.trim() || null;

  JC.register({
    source: "indeed",
    kind: "listings",
    matches: (url) => /:\/\/[^/]*indeed\.com\/(jobs|q-|viewjob)/.test(url),

    parseListings(root) {
      const cards = root.querySelectorAll(
        '.job_seen_beacon, [data-jk], .cardOutline, .jobsearch-ResultsList > li'
      );
      const out = [];
      cards.forEach((card) => {
        try {
          const jk =
            card.getAttribute("data-jk") ||
            card.querySelector("[data-jk]")?.getAttribute("data-jk") ||
            new URLSearchParams(card.querySelector("a[href*='jk=']")?.search || "").get("jk");
          const title =
            txt(card, "h2.jobTitle span[title]") ||
            txt(card, "h2.jobTitle") ||
            txt(card, ".jcs-JobTitle");
          if (!title) return;
          out.push({
            source: "indeed",
            sourceKind: "extension",
            company: txt(card, "[data-testid='company-name']") || txt(card, ".companyName"),
            title,
            location: txt(card, "[data-testid='text-location']") || txt(card, ".companyLocation"),
            url: jk ? `https://www.indeed.com/viewjob?jk=${jk}` : location.href,
            externalId: jk || null,
            postedText: txt(card, ".date") || txt(card, "[data-testid='myJobsStateDate']"),
          });
        } catch (e) {
          /* fail soft */
        }
      });
      return out;
    },

    badgeAnchor: (card) => card.querySelector("h2.jobTitle") || card.querySelector(".jcs-JobTitle"),

    cardKey(card) {
      const jk =
        card.getAttribute("data-jk") ||
        card.querySelector("[data-jk]")?.getAttribute("data-jk") ||
        new URLSearchParams(card.querySelector("a[href*='jk=']")?.search || "").get("jk");
      if (!jk) return null;
      return JC.dedupKey({ source: "indeed", externalId: jk });
    },

    cardSelector: ".job_seen_beacon, [data-jk], .cardOutline, .jobsearch-ResultsList > li",

    viewedTarget(root) {
      const jk = new URLSearchParams(location.search).get("jk");
      if (!jk) return null;
      return { url: location.href, cardKey: JC.dedupKey({ source: "indeed", externalId: jk }) };
    },

    isApplyPage: (url) => /smartapply\.indeed\.com|\/applystart|indeed\.com\/apply/.test(url),
    applyContext(root) {
      return { url: location.href, rawText: (root.body?.innerText || "").slice(0, 12000) };
    },
  });
})();
