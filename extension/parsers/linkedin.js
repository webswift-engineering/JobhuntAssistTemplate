// LinkedIn listings parser + view signal. Brittle (hard flag) — fail soft.
(function () {
  const JC = window.__JOBCAPTURE;
  const txt = (root, sel) => root.querySelector(sel)?.textContent?.trim() || null;

  const idFromCard = (card) =>
    card.getAttribute("data-job-id") ||
    card.querySelector("[data-job-id]")?.getAttribute("data-job-id") ||
    (card.querySelector("a[href*='/jobs/view/']")?.getAttribute("href")?.match(/\/jobs\/view\/(\d+)/)?.[1]) ||
    null;

  JC.register({
    source: "linkedin",
    kind: "listings",
    matches: (url) => /:\/\/[^/]*linkedin\.com\/jobs\//.test(url),

    parseListings(root) {
      const cards = root.querySelectorAll(
        ".job-card-container, .jobs-search-results__list-item, li.scaffold-layout__list-item"
      );
      const out = [];
      cards.forEach((card) => {
        try {
          const id = idFromCard(card);
          const title =
            txt(card, ".job-card-list__title") ||
            txt(card, ".job-card-container__link") ||
            txt(card, "a.job-card-list__title--link") ||
            card.querySelector("a[href*='/jobs/view/']")?.getAttribute("aria-label");
          if (!title) return;
          out.push({
            source: "linkedin",
            sourceKind: "extension",
            company:
              txt(card, ".job-card-container__primary-description") ||
              txt(card, ".artdeco-entity-lockup__subtitle"),
            title: title.trim(),
            location: txt(card, ".job-card-container__metadata-item") || txt(card, ".artdeco-entity-lockup__caption"),
            url: id ? `https://www.linkedin.com/jobs/view/${id}/` : location.href,
            externalId: id,
          });
        } catch (e) {
          /* fail soft */
        }
      });
      return out;
    },

    badgeAnchor: (card) =>
      card.querySelector(".job-card-list__title") || card.querySelector(".artdeco-entity-lockup__title"),

    cardKey(card) {
      const id = idFromCard(card);
      return id ? JC.dedupKey({ source: "linkedin", externalId: id }) : null;
    },

    cardSelector: ".job-card-container, .jobs-search-results__list-item, li.scaffold-layout__list-item",

    viewedTarget(root) {
      const id =
        new URLSearchParams(location.search).get("currentJobId") ||
        location.href.match(/\/jobs\/view\/(\d+)/)?.[1];
      if (!id) return null;
      return { url: location.href, cardKey: JC.dedupKey({ source: "linkedin", externalId: id }) };
    },

    isApplyPage: (url, root) =>
      !!root.querySelector(".jobs-easy-apply-content, .jobs-easy-apply-modal") ||
      /\/jobs\/apply\//.test(url),
    applyContext(root) {
      return { url: location.href, rawText: (root.body?.innerText || "").slice(0, 12000) };
    },
  });
})();
