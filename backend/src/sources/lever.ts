import type { RawJob } from "../types.js";
import { type AtsAdapter, type CompanyRef, fetchJson } from "./AtsAdapter.js";
import { freshRawJobsForPoll } from "./fetchFreshness.js";

interface LeverPosting {
  id: string;
  text: string; // title
  categories?: { location?: string; team?: string; commitment?: string };
  hostedUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  description?: string;
  createdAt?: number; // epoch ms
}

export function normalizeLever(json: unknown, company: CompanyRef): RawJob[] {
  const postings = (json as LeverPosting[]) ?? [];
  if (!Array.isArray(postings)) return [];
  return postings.map((p) => ({
    source: "lever",
    sourceKind: "ats" as const,
    company: company.name,
    title: p.text,
    location: p.categories?.location ?? null,
    url: p.hostedUrl ?? p.applyUrl ?? "",
    externalId: p.id,
    description: p.descriptionPlain ?? (p.description ? stripHtml(p.description) : null),
    postedAt: typeof p.createdAt === "number" ? p.createdAt : null,
    employmentType: p.categories?.commitment ?? null,
  }));
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export const leverAdapter: AtsAdapter = {
  ats: "lever",
  async fetchJobs(company: CompanyRef): Promise<RawJob[]> {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(
      company.boardToken
    )}?mode=json`;
    const json = await fetchJson(url);
    return freshRawJobsForPoll(normalizeLever(json, company));
  },
};
