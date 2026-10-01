// URL → candidate backend dedup keys, no DOM needed. Loaded by the Copilot
// side panel (panel.html) to resolve "which backend job is this tab about"
// via GET /jobs/seen. Kept separate from registry.js/extract.js because those
// are content scripts; this must work in an extension page.
//
// Key shapes differ by ingestion path (page capture vs ATS poll), so we return
// EVERY plausible key and let /jobs/seen say which one exists:
//   greenhouse page-capture: greenhouse:<token>:<id>   ATS poll: greenhouse:<id>
//   lever      page-capture: lever:<co>:<slug>         ATS poll: lever:<slug>
//   ashby / workday / indeed / linkedin: single shape
(function (root) {
  function hostSource(host) {
    const h = (host || "").toLowerCase();
    if (h.includes("linkedin.com")) return "linkedin";
    if (h.includes("indeed.com")) return "indeed";
    if (h.includes("greenhouse.io")) return "greenhouse";
    if (h.includes("careerpuck.com")) return "greenhouse"; // branded GH wrapper
    if (h.includes("lever.co")) return "lever";
    if (h.includes("myworkdayjobs.com") || h.includes("workday.com")) return "workday";
    if (h.includes("ashbyhq.com")) return "ashby";
    return null;
  }

  /** Candidate dedup keys for a URL, most specific first; [] if unknown site. */
  function candidateKeys(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return [];
    }
    const source = hostSource(u.host);
    if (!source) return [];
    const keys = [];
    const add = (extId) => {
      if (extId) keys.push(`${source}:${String(extId).trim()}`);
    };

    if (source === "greenhouse") {
      // Hosted board path OR branded wrapper carrying ?gh_jid=<id>.
      const m = u.pathname.match(/\/([^/]+)\/jobs\/(\d+)/);
      const ghJid = u.searchParams.get("gh_jid");
      if (m) {
        add(`${m[1]}:${m[2]}`);
        add(m[2]);
      } else if (ghJid) {
        add(ghJid);
      }
    } else if (source === "lever") {
      const m = u.pathname.match(/\/([^/]+)\/([^/?#]+)/);
      if (m) {
        add(`${m[1]}:${m[2]}`);
        add(m[2]);
      }
    } else if (source === "ashby") {
      const m = u.pathname.match(/\/([^/]+)\/([^/?#]+)/);
      if (m) add(m[2]);
    } else if (source === "workday") {
      // ATS poll stores the CXS externalPath: "workday:/job/<City>/<Title_Req>".
      // Tab URLs prefix a locale/site and, mid-apply, append /apply/... — strip both.
      const m = u.pathname.match(/\/job\/[^?#]+/);
      if (m) {
        const path = m[0].replace(/\/apply(\/.*)?$/, "");
        add(path);
        add(path.split("/").filter(Boolean)[1]); // legacy page-capture shape: first segment only
      }
    } else if (source === "indeed") {
      add(u.searchParams.get("vjk") || u.searchParams.get("jk"));
    } else if (source === "linkedin") {
      add(u.searchParams.get("currentJobId") || (u.pathname.match(/\/jobs\/view\/(\d+)/) || [])[1]);
    }
    return keys;
  }

  root.JC_JOB_KEY = { candidateKeys, hostSource };
})(typeof window !== "undefined" ? window : self);
