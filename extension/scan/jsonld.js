// DOM-free JSON-LD JobPosting parser, shared by the scan fetcher.
// Works on a raw HTML string (from fetch) so it runs without touching document,
// mirroring the DOM-based jsonLdJobPosting() in extract.js.
(function () {
  const JCS = (window.__JCSCAN = window.__JCSCAN || {});

  // --- shared scan utilities (this file is injected first) ---
  JCS.send = (type, payload) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) =>
          resolve(res ?? { ok: false, error: "no response" })
        );
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });

  JCS.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Resolve once test() is truthy (returns its value) or reject-ish with null on timeout. */
  JCS.waitFor = async (test, { timeout = 2500, interval = 120 } = {}) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const v = test();
      if (v) return v;
      if (Date.now() > deadline) return null;
      await JCS.sleep(interval);
    }
  };

  function stripTags(html) {
    return String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, " ")
      .trim();
  }

  function orgName(org) {
    if (!org) return null;
    if (typeof org === "string") return org;
    return org.name || null;
  }

  function locationText(jl) {
    if (!jl) return null;
    const node = Array.isArray(jl) ? jl[0] : jl;
    const addr = node?.address;
    if (typeof addr === "string") return addr;
    if (addr) {
      return [addr.addressLocality, addr.addressRegion, addr.addressCountry]
        .filter(Boolean)
        .join(", ");
    }
    return null;
  }

  function fromNode(node) {
    const type = node["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => t === "JobPosting")) return null;
    return {
      title: node.title || null,
      company: orgName(node.hiringOrganization),
      location: locationText(node.jobLocation),
      description: stripTags(node.description || ""),
    };
  }

  /** Parse the first schema.org JobPosting out of a raw HTML string. */
  JCS.extractJsonLdJob = function (html) {
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      let data;
      try {
        data = JSON.parse(m[1].trim());
      } catch {
        continue;
      }
      const nodes = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
      for (const node of nodes) {
        if (!node || typeof node !== "object") continue;
        const job = fromNode(node);
        if (job) return job;
      }
    }
    return null;
  };

  /** Last-resort readable text from an HTML string (used when no JSON-LD is present). */
  JCS.readableText = function (html, max = 20000) {
    return stripTags(html).slice(0, max);
  };
})();
