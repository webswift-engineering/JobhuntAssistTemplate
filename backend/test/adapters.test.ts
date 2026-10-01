import { describe, it, expect } from "vitest";
import { normalizeGreenhouse } from "../src/sources/greenhouse.js";
import { normalizeLever } from "../src/sources/lever.js";
import { normalizeAshby } from "../src/sources/ashby.js";
import { normalizeWorkday, parseBoardToken, buildWorkdayJobUrl } from "../src/sources/workday.js";
import {
  normalizeOracle,
  oracleDescription,
  parseOracleBoardToken,
  parseOraclePostedDate,
} from "../src/sources/oracle.js";

const company = { name: "Acme", boardToken: "acme" };

describe("Greenhouse adapter", () => {
  it("normalizes board JSON to RawJob[]", () => {
    const json = {
      jobs: [
        {
          id: 42,
          title: "Senior Engineer",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/42",
          location: { name: "Remote - US" },
          content: "&lt;p&gt;Build &amp; ship things&lt;/p&gt;",
          first_published: "2026-06-01T10:00:00Z",
        },
      ],
    };
    const out = normalizeGreenhouse(json, company);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "greenhouse",
      sourceKind: "ats",
      company: "Acme",
      title: "Senior Engineer",
      location: "Remote - US",
      externalId: "42",
    });
    expect(out[0]!.description).toBe("Build & ship things");
    expect(out[0]!.postedAt).toBe(Date.parse("2026-06-01T10:00:00Z"));
  });
});

describe("Lever adapter", () => {
  it("normalizes postings array to RawJob[]", () => {
    const json = [
      {
        id: "abc-1",
        text: "Backend Engineer",
        categories: { location: "NYC", team: "Platform" },
        hostedUrl: "https://jobs.lever.co/acme/abc-1",
        descriptionPlain: "Work on APIs.",
        createdAt: 1717230000000,
      },
    ];
    const out = normalizeLever(json, company);
    expect(out[0]).toMatchObject({
      source: "lever",
      title: "Backend Engineer",
      location: "NYC",
      externalId: "abc-1",
      description: "Work on APIs.",
      postedAt: 1717230000000,
    });
  });

  it("returns [] for non-array input (fail soft)", () => {
    expect(normalizeLever({ error: "nope" }, company)).toEqual([]);
  });
});

describe("Ashby adapter", () => {
  it("normalizes job board JSON", () => {
    const json = {
      jobs: [
        {
          id: "x1",
          title: "Data Scientist",
          location: "San Francisco",
          jobUrl: "https://jobs.ashbyhq.com/acme/x1",
          descriptionPlain: "ML work",
          publishedAt: "2026-05-20T00:00:00Z",
        },
      ],
    };
    const out = normalizeAshby(json, company);
    expect(out[0]).toMatchObject({
      source: "ashby",
      title: "Data Scientist",
      location: "San Francisco",
      externalId: "x1",
    });
  });
});

describe("Workday adapter", () => {
  it("parses host|tenant|site board token", () => {
    expect(parseBoardToken("https://acme.wd1.myworkdayjobs.com|acme|External")).toEqual({
      host: "https://acme.wd1.myworkdayjobs.com",
      tenant: "acme",
      site: "External",
    });
  });

  it("normalizes job postings", () => {
    const json = {
      total: 1,
      jobPostings: [
        { title: "PM", externalPath: "/job/PM_R1", locationsText: "Seattle", postedOn: "Posted 3 Days Ago" },
      ],
    };
    const out = normalizeWorkday(json, company, "https://acme.wd1.myworkdayjobs.com", "External");
    expect(out[0]).toMatchObject({
      source: "workday",
      title: "PM",
      location: "Seattle",
      url: "https://acme.wd1.myworkdayjobs.com/en-US/External/job/PM_R1",
      postedText: "Posted 3 Days Ago",
    });
  });

  it("buildWorkdayJobUrl adds locale and site when API path is /job/...", () => {
    expect(
      buildWorkdayJobUrl(
        "https://nvidia.wd5.myworkdayjobs.com",
        "NVIDIAExternalCareerSite",
        "/job/US-CA-Santa-Clara/Engineer_JR1"
      )
    ).toBe(
      "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Engineer_JR1"
    );
  });
});

describe("Oracle Recruiting Cloud adapter", () => {
  const host = "https://careers.acme.com";

  it("parses host|siteNumber board token", () => {
    expect(parseOracleBoardToken("https://careers.acme.com/|CX_1001")).toEqual({
      host,
      siteNumber: "CX_1001",
    });
    expect(() => parseOracleBoardToken("https://careers.acme.com")).toThrow(/host\|siteNumber/);
  });

  it("normalizes the requisition list", () => {
    const now = Date.parse("2026-09-21T03:00:00Z");
    const json = {
      items: [
        {
          TotalJobsCount: 1,
          requisitionList: [
            {
              Id: "298905",
              Title: "Senior Software Engineer",
              PostedDate: "2026-09-20",
              PrimaryLocation: "Round Rock, TX, United States",
              WorkplaceType: "Hybrid",
              ShortDescriptionStr: "",
            },
          ],
        },
      ],
    };
    const out = normalizeOracle(json, company, host, "CX_1001", now);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "oracle",
      sourceKind: "ats",
      company: "Acme",
      title: "Senior Software Engineer",
      location: "Round Rock, TX, United States · Hybrid",
      url: "https://careers.acme.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/298905",
      externalId: "298905",
      description: null,
      postedText: "2026-09-20",
    });
  });

  it("returns [] for an unexpected payload (fail soft)", () => {
    expect(normalizeOracle({}, company, host, "CX_1001")).toEqual([]);
    expect(normalizeOracle({ items: [] }, company, host, "CX_1001")).toEqual([]);
  });

  it("reads a date-only PostedDate as end of that day, never in the future", () => {
    const now = Date.parse("2026-09-21T03:00:00Z");
    // Yesterday's posting stays inside a 24h window for the whole following day.
    expect(parseOraclePostedDate("2026-09-20", now)).toBe(Date.parse("2026-09-20T23:59:59.999Z"));
    expect(parseOraclePostedDate("2026-09-21", now)).toBe(now);
    expect(parseOraclePostedDate(null, now)).toBeNull();
    expect(parseOraclePostedDate("soon", now)).toBeNull();
  });

  it("joins the detail sections into a plain-text JD", () => {
    const detail = {
      items: [
        {
          ExternalDescriptionStr: "<p>Build &amp; ship <b>storage</b> software.</p>",
          ExternalResponsibilitiesStr: "<ul><li>Own services</li></ul>",
          ExternalQualificationsStr: null,
        },
      ],
    };
    expect(oracleDescription(detail)).toBe("Build & ship storage software.\n\nOwn services");
    expect(oracleDescription({ items: [] })).toBeNull();
  });
});
