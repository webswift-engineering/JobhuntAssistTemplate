import type { RawJob } from "../types.js";
import { type AtsAdapter, type CompanyRef, fetchJson } from "./AtsAdapter.js";
import { freshRawJobsForPoll } from "./fetchFreshness.js";

interface AshbyJob {
  id?: string;
  title: string;
  location?: string;
  department?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  publishedAt?: string;
  /** FullTime | PartTime | Intern | Contract | Temporary (Ashby posting-api). */
  employmentType?: string;
}

export function normalizeAshby(json: unknown, company: CompanyRef): RawJob[] {
  const jobs = (json as { jobs?: AshbyJob[] })?.jobs ?? [];
  return jobs.map((j) => ({
    source: "ashby",
    sourceKind: "ats" as const,
    company: company.name,
    title: j.title,
    location: j.location ?? null,
    url: j.jobUrl ?? j.applyUrl ?? "",
    externalId: j.id ?? null,
    description:
      j.descriptionPlain ??
      (j.descriptionHtml ? j.descriptionHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null),
    postedAt: j.publishedAt ? Date.parse(j.publishedAt) : null,
    employmentType: j.employmentType ?? null,
  }));
}

export const ashbyAdapter: AtsAdapter = {
  ats: "ashby",
  async fetchJobs(company: CompanyRef): Promise<RawJob[]> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(
      company.boardToken
    )}?includeCompensation=true`;
    const json = await fetchJson(url);
    return freshRawJobsForPoll(normalizeAshby(json, company));
  },
};
