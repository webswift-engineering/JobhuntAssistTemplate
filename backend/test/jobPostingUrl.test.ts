import { describe, it, expect } from "vitest";
import { canonicalPostingUrl } from "../src/jobPostingUrl.js";
import type { JobRow } from "../src/types.js";

const base = (over: Partial<JobRow>): JobRow =>
  ({
    id: "x",
    dedup_key: "k",
    source: "workday",
    source_kind: "ats",
    company: "NVIDIA",
    title: "Eng",
    location: null,
    url: "https://nvidia.wd5.myworkdayjobs.com/job/US-CA-Santa-Clara/Eng_JR1",
    external_id: "/job/US-CA-Santa-Clara/Eng_JR1",
    description: null,
    relevance_score: null,
    relevance_reason: null,
    state: "discovered",
    posted_at: null,
    posted_text: null,
    first_seen_at: 0,
    last_seen_at: 0,
    viewed_at: null,
    notified_at: null,
    applied_at: null,
    notes: null,
    ...over,
  }) as JobRow;

describe("canonicalPostingUrl", () => {
  it("fixes Workday URLs missing locale/site", () => {
    const url = canonicalPostingUrl(base({}), [
      {
        id: 1,
        name: "NVIDIA",
        ats: "workday",
        board_token:
          "https://nvidia.wd5.myworkdayjobs.com|nvidia|NVIDIAExternalCareerSite",
        enabled: 1,
      },
    ]);
    expect(url).toBe(
      "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Eng_JR1"
    );
  });

  it("upgrades legacy Greenhouse host", () => {
    const url = canonicalPostingUrl(
      base({
        source: "greenhouse",
        company: "Acme",
        url: "https://boards.greenhouse.io/acme/jobs/123",
        external_id: "123",
      })
    );
    expect(url).toBe("https://job-boards.greenhouse.io/acme/jobs/123");
  });
});

describe("branded Greenhouse embeds", () => {
  const companies = [
    { id: 1, name: "Okta", ats: "greenhouse", board_token: "okta", enabled: 1 },
  ] as any;

  it("rewrites company-branded gh_jid URLs to the hosted board", () => {
    const url = canonicalPostingUrl(
      {
        url: "https://www.okta.com/company/careers/opportunity/8041376?gh_jid=8041376",
        source: "greenhouse",
        company: "Okta",
        external_id: "8041376",
      } as any,
      companies
    );
    expect(url).toBe("https://job-boards.greenhouse.io/okta/jobs/8041376");
  });

  it("leaves branded URLs alone when the board token is unknown", () => {
    const url = canonicalPostingUrl(
      {
        url: "https://careers.unknownco.com/jobs/1?gh_jid=1",
        source: "greenhouse",
        company: "UnknownCo",
        external_id: "1",
      } as any,
      companies
    );
    expect(url).toBe("https://careers.unknownco.com/jobs/1?gh_jid=1");
  });

  it("still upgrades the legacy boards.greenhouse.io host", () => {
    const url = canonicalPostingUrl(
      { url: "https://boards.greenhouse.io/acme/jobs/9", source: "greenhouse" } as any,
      companies
    );
    expect(url).toBe("https://job-boards.greenhouse.io/acme/jobs/9");
  });
});
