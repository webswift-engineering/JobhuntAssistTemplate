import { describe, it, expect } from "vitest";
import { classifyEmployment, type EmploymentType } from "../src/employmentType.js";

describe("classifyEmployment", () => {
  const cases: Array<{
    name: string;
    input: { structured?: string | null; title: string; description?: string | null };
    expected: EmploymentType;
  }> = [
    // Structured field wins, any source casing
    { name: "JSearch FULLTIME", input: { structured: "FULLTIME", title: "SWE" }, expected: "full_time" },
    { name: "JSearch CONTRACTOR", input: { structured: "CONTRACTOR", title: "SWE" }, expected: "contract" },
    { name: "JSearch PARTTIME", input: { structured: "PARTTIME", title: "SWE" }, expected: "part_time" },
    { name: "Adzuna permanent", input: { structured: "permanent", title: "SWE" }, expected: "full_time" },
    { name: "Adzuna contract", input: { structured: "contract", title: "SWE" }, expected: "contract" },
    { name: "Adzuna full_time (contract_time fallback)", input: { structured: "full_time", title: "SWE" }, expected: "full_time" },
    { name: "Lever commitment Full-time", input: { structured: "Full-time", title: "SWE" }, expected: "full_time" },
    { name: "Ashby Temporary", input: { structured: "Temporary", title: "SWE" }, expected: "contract" },
    { name: "Ashby Intern", input: { structured: "Intern", title: "SWE" }, expected: "intern" },
    {
      name: "structured beats contradicting text",
      input: { structured: "FULLTIME", title: "SWE (6 month contract)" },
      expected: "full_time",
    },
    {
      name: "unrecognized structured value falls through to regex",
      input: { structured: "Regular", title: "Java Developer — 6 month contract" },
      expected: "contract",
    },

    // Title regex — decisive
    { name: "title (6 month contract)", input: { title: "Senior SWE (6 Month Contract)" }, expected: "contract" },
    { name: "title Contractor", input: { title: "Java Contractor" }, expected: "contract" },
    { name: "title intern", input: { title: "Software Engineering Intern" }, expected: "intern" },
    { name: "title co-op", input: { title: "Developer Co-op (Fall 2026)" }, expected: "intern" },
    { name: "title part-time", input: { title: "Part-Time Backend Developer" }, expected: "part_time" },

    // Description regex
    {
      name: "W2 hourly in description",
      input: { title: "Java Developer", description: "Compensation: $70/hr W2 hourly. Benefits not included." },
      expected: "contract",
    },
    {
      name: "corp-to-corp in description",
      input: { title: "Backend Engineer", description: "Open to C2C and corp to corp arrangements." },
      expected: "contract",
    },
    {
      name: "explicit contract role sentence",
      input: { title: "Backend Engineer", description: "This role is a 12-month contract with possible extension." },
      expected: "contract",
    },
    {
      name: "contract-to-hire",
      input: { title: "Backend Engineer", description: "This is a contract-to-hire opportunity." },
      expected: "contract",
    },
    {
      name: "strong contract marker beats full-time mention",
      input: { title: "Java Developer", description: "Full-time hours, W2 hourly through our staffing agency." },
      expected: "contract",
    },
    {
      name: "plain full-time JD",
      input: { title: "Senior Software Engineer", description: "This is a full-time position with benefits." },
      expected: "full_time",
    },
    {
      name: "permanent placement",
      input: { title: "Software Engineer", description: "Permanent role, hybrid in Toronto." },
      expected: "full_time",
    },
    {
      name: "incidental 'contract with vendors' is not a knockout",
      input: {
        title: "Senior Software Engineer",
        description: "You will negotiate contract terms with vendors. Full-time, remote.",
      },
      expected: "full_time",
    },

    // No signal
    { name: "no signal at all", input: { title: "Software Engineer", description: "We build cool things." }, expected: "unknown" },
    { name: "empty description", input: { title: "Backend Developer" }, expected: "unknown" },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(classifyEmployment(c.input)).toBe(c.expected);
    });
  }
});
