import type { RawJob } from "../types.js";
import { config } from "../config.js";
import { freshnessMs } from "../freshness.js";
import { type AtsAdapter, type CompanyRef, fetchJson } from "./AtsAdapter.js";
import { freshRawJobsForPoll } from "./fetchFreshness.js";

/**
 * Oracle Recruiting Cloud (Fusion HCM "Candidate Experience" sites) — where Dell
 * moved after leaving Workday. boardToken is packed as `host|siteNumber`, e.g.
 *   "https://enterpriseplatform.dell.com|CX_1001"
 * The siteNumber is in the career site's own API calls (`siteNumber=CX_...`).
 */
interface OraRequisition {
  Id: string | number;
  Title: string;
  PostedDate?: string | null;
  PrimaryLocation?: string | null;
  WorkplaceType?: string | null;
  ShortDescriptionStr?: string | null;
  JobType?: string | null;
  ContractType?: string | null;
}

interface OraDetail {
  ExternalDescriptionStr?: string | null;
  ExternalResponsibilitiesStr?: string | null;
  ExternalQualificationsStr?: string | null;
}

const DETAIL_CONCURRENCY = 3;

export function parseOracleBoardToken(boardToken: string): { host: string; siteNumber: string } {
  const [host, siteNumber] = boardToken.split("|").map((s) => s.trim());
  if (!host || !siteNumber) {
    throw new Error(`Oracle boardToken must be 'host|siteNumber', got: ${boardToken}`);
  }
  return { host: host.replace(/\/$/, ""), siteNumber };
}

export function buildOracleJobUrl(host: string, siteNumber: string, id: string | number): string {
  return `${host.replace(/\/$/, "")}/hcmUI/CandidateExperience/en/sites/${siteNumber}/job/${id}`;
}

/**
 * Oracle gives a date with no time ("2026-09-21"). Reading it as midnight would age a
 * posting by up to a day and push same-day jobs out of the 24h freshness window, so
 * treat it as the end of that day, never later than now.
 */
export function parseOraclePostedDate(text: string | null | undefined, now = Date.now()): number | null {
  if (!text) return null;
  const dayStart = Date.parse(`${text.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(dayStart)) return null;
  return Math.min(now, dayStart + 86_400_000 - 1);
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeOracle(
  json: unknown,
  company: CompanyRef,
  host: string,
  siteNumber: string,
  now = Date.now()
): RawJob[] {
  const items = (json as { items?: { requisitionList?: OraRequisition[] }[] })?.items ?? [];
  const reqs = items[0]?.requisitionList ?? [];
  return reqs.map((r) => {
    const location = [r.PrimaryLocation, r.WorkplaceType].filter(Boolean).join(" · ");
    return {
      source: "oracle",
      sourceKind: "ats" as const,
      company: company.name,
      title: r.Title,
      location: location || null,
      url: buildOracleJobUrl(host, siteNumber, r.Id),
      externalId: String(r.Id),
      description: r.ShortDescriptionStr ? stripHtml(r.ShortDescriptionStr) : null,
      postedAt: parseOraclePostedDate(r.PostedDate, now),
      postedText: r.PostedDate ?? null,
      employmentType: r.JobType ?? r.ContractType ?? null,
    };
  });
}

export function oracleDescription(json: unknown): string | null {
  const d = (json as { items?: OraDetail[] })?.items?.[0];
  if (!d) return null;
  const text = [d.ExternalDescriptionStr, d.ExternalResponsibilitiesStr, d.ExternalQualificationsStr]
    .filter((s): s is string => !!s)
    .map(stripHtml)
    .filter(Boolean)
    .join("\n\n");
  return text || null;
}

export const oracleAdapter: AtsAdapter = {
  ats: "oracle",
  async fetchJobs(company: CompanyRef): Promise<RawJob[]> {
    const { host, siteNumber } = parseOracleBoardToken(company.boardToken);
    const api = `${host}/hcmRestApi/resources/latest`;
    // Same keyword + caps as Workday: both are whole-enterprise boards, not eng-only.
    const keyword = config.workday.searchText;
    const pageSize = 25;
    const maxPages = config.workday.maxPages;
    const maxJobs = config.workday.maxJobs;
    const maxAge = freshnessMs();
    const now = Date.now();
    const out: RawJob[] = [];

    for (let page = 0; page < maxPages; page++) {
      const finder = [
        `siteNumber=${siteNumber}`,
        `limit=${pageSize}`,
        `offset=${page * pageSize}`,
        ...(keyword ? [`keyword=${encodeURIComponent(`"${keyword}"`)}`] : []),
        "sortBy=POSTING_DATES_DESC",
      ].join(",");
      // Without expand=requisitionList the API answers with the count but no jobs.
      const json = await fetchJson(
        `${api}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;${finder}`
      );
      const batch = normalizeOracle(json, company, host, siteNumber, now);
      if (!batch.length) break;
      out.push(...batch);

      // Sorted newest-first: once a whole page is stale, nothing after it is fresh.
      if (batch.every((j) => j.postedAt != null && now - j.postedAt > maxAge)) break;

      const total =
        (json as { items?: { TotalJobsCount?: number }[] })?.items?.[0]?.TotalJobsCount ?? out.length;
      if (out.length >= total) break;
    }

    const fresh = freshRawJobsForPoll(out, { maxAgeMs: maxAge, now, limit: maxJobs });

    // The list has no JD; pull it per fresh job so scoring sees real requirements.
    // Fail soft — a missing description must not drop the job.
    for (let i = 0; i < fresh.length; i += DETAIL_CONCURRENCY) {
      await Promise.all(
        fresh.slice(i, i + DETAIL_CONCURRENCY).map(async (job) => {
          try {
            const detail = await fetchJson(
              `${api}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${job.externalId}%22,siteNumber=${siteNumber}`
            );
            job.description = oracleDescription(detail) ?? job.description;
          } catch {
            /* keep the title-only job */
          }
        })
      );
    }
    return fresh;
  },
};
