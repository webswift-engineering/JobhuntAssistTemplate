/** Parse public ATS board slug from an apply / job URL (for discovery suggestions). */
export function atsBoardFromUrl(url: string): { ats: string; boardToken: string; name?: string } | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes("greenhouse.io")) {
      const m = u.pathname.match(/\/([^/]+)\/jobs\/(\d+)/);
      if (m) return { ats: "greenhouse", boardToken: m[1] };
      const m2 = u.pathname.match(/^\/([^/]+)/);
      if (m2 && m2[1] !== "embed") return { ats: "greenhouse", boardToken: m2[1] };
    }
    if (host.includes("lever.co")) {
      const m = u.pathname.match(/^\/([^/]+)/);
      if (m) return { ats: "lever", boardToken: m[1] };
    }
    if (host.includes("ashbyhq.com")) {
      const m = u.pathname.match(/^\/([^/]+)/);
      if (m) return { ats: "ashby", boardToken: m[1] };
    }
  } catch {
    /* ignore */
  }
  return null;
}
