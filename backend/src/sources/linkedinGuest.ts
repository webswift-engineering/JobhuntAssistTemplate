/**
 * LinkedIn public "guest" job search — no login. Lets a device without the browser
 * extension (iPad / phone) scan a whole search result list: paste the LinkedIn Jobs
 * search URL, we re-run it against the guest API and return the job cards.
 *
 * The desktop extension scrapes the live DOM; this does the equivalent server-side so
 * it works from any device on the tailnet.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface LinkedInCard {
  title: string;
  company: string | null;
  location: string | null;
  url: string;
  externalId: string;
}

export interface LinkedInSearchParams {
  keywords: string;
  geoId: string;
  location: string;
  fTPR: string; // recency filter, e.g. r86400 = last 24h
  fWT: string; // work type (remote etc.)
}

/** Pull the search parameters out of a pasted LinkedIn Jobs search URL. */
export function parseLinkedInSearch(rawUrl: string): LinkedInSearchParams | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!u.hostname.toLowerCase().includes("linkedin.com")) return null;
  const p = u.searchParams;
  return {
    keywords: p.get("keywords") ?? "",
    geoId: p.get("geoId") ?? "",
    location: p.get("location") ?? "",
    fTPR: p.get("f_TPR") ?? "",
    fWT: p.get("f_WT") ?? "",
  };
}

async function fetchText(url: string, timeoutMs = 12_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch up to `maxJobs` job cards from the guest search API (paginates by 10). */
export async function linkedinGuestSearch(
  params: LinkedInSearchParams,
  maxJobs = 25
): Promise<LinkedInCard[]> {
  const cards: LinkedInCard[] = [];
  const seen = new Set<string>();
  for (let start = 0; start < maxJobs && start < 100; start += 10) {
    const qs = new URLSearchParams();
    if (params.keywords) qs.set("keywords", params.keywords);
    if (params.geoId) qs.set("geoId", params.geoId);
    if (params.location) qs.set("location", params.location);
    if (params.fTPR) qs.set("f_TPR", params.fTPR);
    if (params.fWT) qs.set("f_WT", params.fWT);
    qs.set("start", String(start));
    const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${qs.toString()}`;
    let html: string;
    try {
      html = await fetchText(url);
    } catch {
      break; // rate-limited or end of results
    }
    const page = parseCards(html);
    if (!page.length) break;
    for (const c of page) {
      if (!seen.has(c.externalId)) {
        seen.add(c.externalId);
        cards.push(c);
      }
    }
    if (cards.length >= maxJobs) break;
  }
  return cards.slice(0, maxJobs);
}

function parseCards(html: string): LinkedInCard[] {
  const out: LinkedInCard[] = [];
  // Each result is a <li> containing a base-card.
  const items = html.split(/<li[\s>]/i).slice(1);
  for (const item of items) {
    const link =
      item.match(/base-card__full-link[^>]*href=["']([^"']+)["']/i)?.[1] ??
      item.match(/href=["'](https:\/\/[^"']*\/jobs\/view\/\d+[^"']*)["']/i)?.[1] ??
      null;
    const externalId =
      link?.match(/\/jobs\/view\/(\d+)/)?.[1] ??
      item.match(/urn:li:jobPosting:(\d+)/)?.[1] ??
      item.match(/data-entity-urn=["']urn:li:jobPosting:(\d+)/i)?.[1] ??
      null;
    if (!externalId) continue;
    const title = textOfClass(item, "base-search-card__title");
    const company = textOfClass(item, "base-search-card__subtitle");
    const location = textOfClass(item, "job-search-card__location");
    out.push({
      title: title ?? "(untitled)",
      company: company || null,
      location: location || null,
      url: link ? link.split("?")[0]! : `https://www.linkedin.com/jobs/view/${externalId}`,
      externalId,
    });
  }
  return out;
}

/** Inner text of the first element carrying `cls`, closing on the same tag it opened. */
function textOfClass(html: string, cls: string): string | null {
  const re = new RegExp(
    `<(div|span|a|h[1-6]|p)\\b[^>]*class=["'][^"']*${escapeRe(cls)}[^"']*["'][^>]*>([\\s\\S]*?)</\\1>`,
    "i"
  );
  const m = html.match(re);
  if (!m?.[2]) return null;
  const text = decodeEntities(m[2].replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => {
      try {
        return String.fromCodePoint(Number(d));
      } catch {
        return "";
      }
    });
}
