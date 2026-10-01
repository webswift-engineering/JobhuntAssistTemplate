import type { RawJob } from "../types.js";

export interface AdzunaJob {
  id?: string | number;
  title?: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  redirect_url?: string;
  description?: string;
  created?: string;
  /** 'permanent' | 'contract' — Adzuna's employment-basis field. */
  contract_type?: string;
  /** 'full_time' | 'part_time' — Adzuna's hours field. */
  contract_time?: string;
}

export function normalizeAdzuna(jobs: AdzunaJob[], countryCode: string): RawJob[] {
  const out: RawJob[] = [];
  for (const j of jobs) {
    const title = j.title?.trim();
    const url = j.redirect_url?.trim();
    if (!title || !url) continue;
    const postedAt = j.created ? Date.parse(j.created) : null;
    out.push({
      source: "adzuna",
      sourceKind: "discovery",
      company: j.company?.display_name ?? null,
      title,
      location: j.location?.display_name ?? countryCode,
      url,
      externalId: j.id != null ? String(j.id) : null,
      description: j.description?.slice(0, 50000) ?? null,
      postedAt: Number.isFinite(postedAt) ? postedAt : null,
      // contract_type (permanent/contract) is the stronger signal; contract_time
      // (full_time/part_time) is the fallback when the basis is unstated.
      employmentType: j.contract_type ?? j.contract_time ?? null,
    });
  }
  return out;
}

export async function fetchAdzunaPage(
  appId: string,
  appKey: string,
  opts: {
    country: string;
    what: string;
    page: number;
    maxDaysOld: number;
    resultsPerPage: number;
  }
): Promise<{ jobs: RawJob[]; total: number }> {
  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    what: opts.what,
    results_per_page: String(opts.resultsPerPage),
    max_days_old: String(opts.maxDaysOld),
    sort_by: "date",
  });
  const url = `https://api.adzuna.com/v1/api/jobs/${opts.country}/search/${opts.page}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Adzuna HTTP ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
  }
  const body = (await res.json()) as { results?: AdzunaJob[]; count?: number };
  return {
    jobs: normalizeAdzuna(body.results ?? [], opts.country),
    total: body.count ?? 0,
  };
}

export async function fetchAdzuna(
  appId: string,
  appKey: string,
  opts: {
    country: string;
    what: string;
    maxDaysOld: number;
    maxPages: number;
    resultsPerPage: number;
  }
): Promise<RawJob[]> {
  const all: RawJob[] = [];
  for (let page = 1; page <= opts.maxPages; page++) {
    const { jobs, total } = await fetchAdzunaPage(appId, appKey, {
      country: opts.country,
      what: opts.what,
      page,
      maxDaysOld: opts.maxDaysOld,
      resultsPerPage: opts.resultsPerPage,
    });
    all.push(...jobs);
    if (jobs.length === 0 || page * opts.resultsPerPage >= total) break;
  }
  return all;
}
