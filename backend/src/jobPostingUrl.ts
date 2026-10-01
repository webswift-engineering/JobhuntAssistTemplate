import { buildWorkdayJobUrl, parseBoardToken } from "./sources/workday.js";
import type { CompanyRow, JobRow } from "./types.js";

const GH_OLD = "https://boards.greenhouse.io/";
const GH_NEW = "https://job-boards.greenhouse.io/";
/** Missing `/en-US/{site}/` before `/job/...` → 404 on Workday career sites. */
const WD_BAD = /^https:\/\/[^/]+\/job\//;

export function canonicalPostingUrl(job: JobRow, companies: CompanyRow[] = []): string {
  let url = (job.url ?? "").trim();
  if (!url.startsWith("http")) return url;

  if (job.source === "greenhouse" && url.startsWith(GH_OLD)) {
    url = GH_NEW + url.slice(GH_OLD.length);
  }

  // Company-branded Greenhouse embeds (okta.com/...?gh_jid=8041376, careerpuck,
  // etc.) — rewrite to the hosted board so the apply assist can drive the real
  // form. 168 of 169 non-ATS-host jobs in the queue are this pattern.
  if (job.source === "greenhouse" && !/greenhouse\.io/.test(url)) {
    const ghJid = url.match(/[?&]gh_jid=(\d+)/)?.[1] ?? (job.external_id || "").match(/^\d+$/)?.[0];
    const co = companies.find((c) => c.name === job.company && c.ats === "greenhouse");
    if (ghJid && co?.board_token) {
      url = `${GH_NEW}${encodeURIComponent(co.board_token)}/jobs/${ghJid}`;
    }
  }

  if (job.source === "workday" && job.external_id && WD_BAD.test(url)) {
    const co = companies.find((c) => c.name === job.company && c.ats === "workday");
    if (co) {
      try {
        const { host, site } = parseBoardToken(co.board_token);
        url = buildWorkdayJobUrl(host, site, job.external_id);
      } catch {
        /* keep stored url */
      }
    }
  }

  return url;
}
