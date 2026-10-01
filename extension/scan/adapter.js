// Applies an LLM-generated site adapter (from POST /scan/site-adapter) to the live
// DOM, and orchestrates on-demand adaptation of unknown sites via the backend.
(function () {
  const JCS = (window.__JCSCAN = window.__JCSCAN || {});

  const clean = (s) => JCS._clean ? JCS._clean(s) : (s || "").replace(/\s+/g, " ").trim();

  function safeRe(src) {
    try {
      return new RegExp(src);
    } catch {
      return null;
    }
  }

  function safeQuery(el, sel) {
    try {
      return el.querySelector(sel);
    } catch {
      return null;
    }
  }

  function absUrl(href) {
    if (!href) return null;
    try {
      return new URL(href, location.href).href;
    } catch {
      return href;
    }
  }

  function makeResolver(el) {
    const lines = (el.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    return function resolve(spec, ctx) {
      if (!spec) return null;
      if (spec.template) return spec.template.replace(/\{id\}/g, ctx.id || "");
      let v = null;
      if (typeof spec.textLine === "number") {
        v = lines[spec.textLine] || null;
      } else {
        const target = spec.selector ? safeQuery(el, spec.selector) : el;
        if (!target) return null;
        const attr = spec.attr || "text";
        v = attr === "text" ? target.innerText || target.textContent || "" : target.getAttribute(attr);
      }
      v = v == null ? "" : String(v).replace(/\s+/g, " ").trim();
      if (spec.regex && v) {
        const re = safeRe(spec.regex);
        const m = re && v.match(re);
        if (m) v = m[1] != null ? m[1] : m[0];
      }
      return v || null;
    };
  }

  const LOCATION_RE = /remote|hybrid|on-?site|,|\bcanada\b|\bunited states\b|\b[A-Z]{2}\b/;

  function buildFromAdapter(el, fields) {
    const resolve = makeResolver(el);
    const lines = (el.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const id = resolve(fields.id, {});

    // Prefer the LLM's field spec, but fall back to text-line heuristics so an
    // imperfect selector doesn't drop an otherwise-valid card.
    let title = resolve(fields.title, { id }) || lines[0] || null;
    if (!title || title.length < 3) return null;
    const rest = lines.filter((l) => l !== title);
    const company = resolve(fields.company, { id }) || rest[0] || null;
    const location =
      resolve(fields.location, { id }) ||
      rest.slice(1).find((l) => LOCATION_RE.test(l)) ||
      rest[1] ||
      null;
    const href = absUrl(resolve(fields.href, { id }));

    const card = {
      el,
      title: clean(title).slice(0, 160),
      company: clean(company),
      location: clean(location),
      href,
      externalId: id || null,
    };
    card.dedupKey = JCS._dedupKeyFor ? JCS._dedupKeyFor(card, null) : title;
    return card;
  }

  /** Apply an adapter recipe to the page. Returns { source, cards[] } or null. */
  JCS.applyAdapter = function (adapter) {
    if (!adapter || !adapter.cardSelector) return null;
    let els;
    try {
      els = Array.from(document.querySelectorAll(adapter.cardSelector));
    } catch {
      return null;
    }
    const cards = [];
    const seen = new Set();
    for (const el of els) {
      const card = buildFromAdapter(el, adapter.fields || {});
      if (!card || seen.has(card.dedupKey)) continue;
      seen.add(card.dedupKey);
      cards.push(card);
    }
    return cards.length >= 3 ? { source: "ai:" + location.hostname, cards, adapter } : null;
  };

  /**
   * Ask the backend (DeepSeek) to adapt this site. Uses the cached adapter unless
   * `force`; sends a fresh DOM digest so the server can (re)generate when needed.
   */
  JCS.aiAdapt = async function (force) {
    const host = location.hostname;
    const digest = JCS.buildDigest ? JCS.buildDigest(22000) : "";
    const res = await JCS.send("SITE_ADAPTER", { host, digest, force: !!force });
    if (!res || !res.ok || !res.data || !res.data.adapter) return null;
    return JCS.applyAdapter(res.data.adapter);
  };
})();
