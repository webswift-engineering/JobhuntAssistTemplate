import { describe, it, expect } from "vitest";
import { normalizeJSearch } from "../src/sources/jsearch.js";
import { normalizeAdzuna } from "../src/sources/adzuna.js";
import { atsBoardFromUrl } from "../src/sources/atsSlugFromUrl.js";

describe("discovery normalizers", () => {
  it("normalizes JSearch rows", () => {
    const jobs = normalizeJSearch(
      [
        {
          job_id: "abc",
          job_title: "Software Engineer",
          employer_name: "Acme",
          job_city: "Toronto",
          job_country: "CA",
          job_apply_link: "https://boards.greenhouse.io/acme/jobs/123",
          job_posted_at_datetime_utc: "2026-06-23T10:00:00.000Z",
        },
      ],
      "ca"
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.source).toBe("jsearch");
    expect(jobs[0]!.sourceKind).toBe("discovery");
    expect(jobs[0]!.externalId).toBe("abc");
  });

  it("normalizes Adzuna rows", () => {
    const jobs = normalizeAdzuna(
      [
        {
          id: 42,
          title: "Backend Engineer",
          company: { display_name: "Beta" },
          location: { display_name: "Vancouver" },
          redirect_url: "https://example.com/job",
          created: "2026-06-23",
        },
      ],
      "ca"
    );
    expect(jobs[0]!.source).toBe("adzuna");
    expect(jobs[0]!.sourceKind).toBe("discovery");
  });

  it("extracts greenhouse slug from apply URL", () => {
    const slug = atsBoardFromUrl("https://boards.greenhouse.io/stripe/jobs/123");
    expect(slug).toEqual({ ats: "greenhouse", boardToken: "stripe" });
  });
});

describe("discovery normalizers carry employment-type fields", () => {
  it("JSearch job_employment_type reaches RawJob.employmentType", () => {
    const jobs = normalizeJSearch(
      [
        {
          job_title: "SWE",
          job_apply_link: "https://x/1",
          job_employment_type: "CONTRACTOR",
        },
      ],
      "us"
    );
    expect(jobs[0]!.employmentType).toBe("CONTRACTOR");
  });

  it("Adzuna contract_type wins over contract_time; contract_time is the fallback", () => {
    const both = normalizeAdzuna(
      [{ title: "SWE", redirect_url: "https://x/1", contract_type: "permanent", contract_time: "part_time" }],
      "ca"
    );
    expect(both[0]!.employmentType).toBe("permanent");
    const timeOnly = normalizeAdzuna(
      [{ title: "SWE", redirect_url: "https://x/2", contract_time: "full_time" }],
      "ca"
    );
    expect(timeOnly[0]!.employmentType).toBe("full_time");
  });
});
