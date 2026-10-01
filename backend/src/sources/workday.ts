import type { RawJob } from "../types.js";
import { config } from "../config.js";
import { freshnessMs } from "../freshness.js";
import { type AtsAdapter, type CompanyRef, fetchJson } from "./AtsAdapter.js";
import { filterFreshRawJobs, sortRawJobsByRecency } from "./fetchFreshness.js";

/**
 * Workday is the brittle one (spec hard flag #1) — implemented last, expect maintenance.
 * boardToken is packed as `host|tenant|site`, e.g.
 *   "https://acme.wd1.myworkdayjobs.com|acme|External"
 */
interface WdPosting {
  title: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}

export function parseBoardToken(boardToken: string): { host: string; tenant: string; site: string } {
  const [host, tenant, site] = boardToken.split("|").map((s) => s.trim());
  if (!host || !tenant || !site) {
    throw new Error(`Workday boardToken must be 'host|tenant|site', got: ${boardToken}`);
  }
  return { host: host.replace(/\/$/, ""), tenant, site };
}

/**
 * Workday list API returns `externalPath` like `/job/City/Title_JR123` — the public
 * career page needs `{host}/{locale}/{site}/job/...` (missing site → 404).
 */
export function buildWorkdayJobUrl(
  host: string,
  site: string,
  externalPath: string | undefined,
  locale = "en-US"
): string {
  const base = host.replace(/\/$/, "");
  if (!externalPath) return `${base}/${locale}/${site}`;
  const path = externalPath.startsWith("/") ? externalPath : `/${externalPath}`;
  // Already includes locale prefix (e.g. /en-US/External/job/...)
  if (/^\/[a-z]{2}-[A-Z]{2}\//.test(path)) return `${base}${path}`;
  if (path.includes(`/${site}/`)) return `${base}${path}`;
  if (path.startsWith("/job/")) return `${base}/${locale}/${site}${path}`;
  return `${base}${path}`;
}

/**
 * Workday gives recency as text ("Posted Today", "Posted Yesterday",
 * "Posted 3 Days Ago", "Posted 30+ Days Ago") instead of a date. Parse it to an
 * approximate epoch so the freshness/24h filter can exclude stale postings.
 */
export function parseWorkdayPostedOn(text: string | undefined, now = Date.now()): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  const day = 86_400_000;
  if (t.includes("today") || t.includes("just posted")) return now;
  if (t.includes("yesterday")) return now - day;
  const m = t.match(/(\d+)\+?\s*day/);
  if (m) return now - Number(m[1]) * day;
  const mh = t.match(/(\d+)\+?\s*hour/);
  if (mh) return now - Number(mh[1]) * 3_600_000;
  return null;
}

export function normalizeWorkday(
  json: unknown,
  company: CompanyRef,
  host: string,
  site: string
): RawJob[] {
  const postings = (json as { jobPostings?: WdPosting[] })?.jobPostings ?? [];
  return postings.map((p) => ({
    source: "workday",
    sourceKind: "ats" as const,
    company: company.name,
    title: p.title,
    location: p.locationsText ?? null,
    url: buildWorkdayJobUrl(host, site, p.externalPath),
    externalId: p.externalPath ?? null,
    description: p.bulletFields?.join(" · ") ?? null,
    postedAt: parseWorkdayPostedOn(p.postedOn),
    postedText: p.postedOn ?? null,
  }));
}

export const workdayAdapter: AtsAdapter = {
  ats: "workday",
  async fetchJobs(company: CompanyRef): Promise<RawJob[]> {
    const { host, tenant, site } = parseBoardToken(company.boardToken);
    const url = `${host}/wday/cxs/${tenant}/${site}/jobs`;
    const searchText = config.workday.searchText;
    const pageSize = 20;
    const maxPages = config.workday.maxPages;
    const maxJobs = config.workday.maxJobs;
    const maxAge = freshnessMs();
    const now = Date.now();
    const out: RawJob[] = [];

    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageSize;
      const json = await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: pageSize, offset, searchText, appliedFacets: {} }),
      });
      const batch = normalizeWorkday(json, company, host, site);
      if (!batch.length) break;
      out.push(...batch);

      // API order is not guaranteed newest-first; stop scanning once a full page is stale.
      const dated = batch.filter((j) => j.postedAt != null);
      if (dated.length > 0 && dated.every((j) => now - j.postedAt! > maxAge)) break;

      const total = (json as { total?: number })?.total ?? out.length;
      if (out.length >= total) break;
    }

    const fresh = filterFreshRawJobs(sortRawJobsByRecency(out), { maxAgeMs: maxAge, now });
    return fresh.slice(0, maxJobs);
  },
};
