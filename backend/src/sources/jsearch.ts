import type { RawJob } from "../types.js";

export interface JSearchJob {
  job_id?: string;
  job_title?: string;
  employer_name?: string;
  job_city?: string;
  job_state?: string;
  job_country?: string;
  job_apply_link?: string;
  job_google_link?: string;
  job_description?: string;
  job_posted_at_datetime_utc?: string;
  /** FULLTIME | CONTRACTOR | PARTTIME | INTERN (JSearch's enum). */
  job_employment_type?: string;
}

export function normalizeJSearch(jobs: JSearchJob[], countryCode: string): RawJob[] {
  const out: RawJob[] = [];
  for (const j of jobs) {
    const title = j.job_title?.trim();
    const url = j.job_apply_link?.trim() || j.job_google_link?.trim();
    if (!title || !url) continue;
    const locParts = [j.job_city, j.job_state, j.job_country ?? countryCode].filter(Boolean);
    const postedAt = j.job_posted_at_datetime_utc ? Date.parse(j.job_posted_at_datetime_utc) : null;
    out.push({
      source: "jsearch",
      sourceKind: "discovery",
      company: j.employer_name ?? null,
      title,
      location: locParts.length ? locParts.join(", ") : countryCode,
      url,
      externalId: j.job_id ?? null,
      description: j.job_description?.slice(0, 50000) ?? null,
      postedAt: Number.isFinite(postedAt) ? postedAt : null,
      employmentType: j.job_employment_type ?? null,
    });
  }
  return out;
}

export async function fetchJSearch(
  apiKey: string,
  opts: {
    query: string;
    country: string;
    datePosted: string;
    numPages: number;
  }
): Promise<RawJob[]> {
  const params = new URLSearchParams({
    query: opts.query,
    country: opts.country,
    date_posted: opts.datePosted,
    num_pages: String(opts.numPages),
  });
  const url = `https://jsearch.p.rapidapi.com/search?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      "x-rapidapi-key": apiKey,
      "x-rapidapi-host": "jsearch.p.rapidapi.com",
    },
  });
  if (!res.ok) {
    throw new Error(`JSearch HTTP ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
  }
  const body = (await res.json()) as { data?: JSearchJob[] };
  return normalizeJSearch(body.data ?? [], opts.country);
}
