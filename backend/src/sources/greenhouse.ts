import type { RawJob } from "../types.js";
import { type AtsAdapter, type CompanyRef, fetchJson } from "./AtsAdapter.js";
import { freshRawJobsForPoll } from "./fetchFreshness.js";

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  content?: string; // HTML-encoded
  updated_at?: string;
  first_published?: string;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeGreenhouse(json: unknown, company: CompanyRef): RawJob[] {
  const jobs = (json as { jobs?: GhJob[] })?.jobs ?? [];
  return jobs.map((j) => ({
    source: "greenhouse",
    sourceKind: "ats" as const,
    company: company.name,
    title: j.title,
    location: j.location?.name ?? null,
    url: j.absolute_url,
    externalId: String(j.id),
    description: j.content ? decodeHtml(j.content) : null,
    postedAt: j.first_published
      ? Date.parse(j.first_published)
      : j.updated_at
        ? Date.parse(j.updated_at)
        : null,
  }));
}

export const greenhouseAdapter: AtsAdapter = {
  ats: "greenhouse",
  async fetchJobs(company: CompanyRef): Promise<RawJob[]> {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(
      company.boardToken
    )}/jobs?content=true`;
    const json = await fetchJson(url);
    return freshRawJobsForPoll(normalizeGreenhouse(json, company));
  },
};
