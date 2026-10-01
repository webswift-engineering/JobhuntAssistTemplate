import { describe, it, expect } from "vitest";
import {
  triageDeterministic,
  triageJobs,
  extractDomainRequirements,
  mentionsTech,
  TECH_VOCAB,
  DOMAIN_GAP_CAP,
} from "../src/llm/triageJob.js";
import type { LlmClient } from "../src/llm/client.js";
import {
  computeMatchFacts,
  relevantYearsFromTitles,
  totalYearsExperience,
  type MatchFacts,
} from "../src/profile/matchFacts.js";
import type { MasterProfile } from "../src/profile/masterProfile.js";
import type { Preferences } from "../src/types.js";

const NOW = new Date("2026-07-01");

/** Career-changer: ~7.5y total history, but only the analyst-adjacent slice is relevant. */
const careerChanger: MasterProfile = {
  contact: { name: "Pat" },
  skills: {
    "Data & Analytics": ["SQL", "BigQuery", "Power BI", "Excel", "Google Analytics", "Dashboards"],
  },
  experience: [
    {
      company: "Retail Chain",
      title: "Store Manager",
      start: "2018-09",
      end: "2024-06",
      bullets: [{ id: "t-1", text: "Managed a store.", tags: ["database"] }],
    },
    {
      company: "SaaS Startup",
      title: "Marketing Intern",
      start: "2024-12",
      end: "2025-05",
      bullets: [{ id: "m-1", text: "Analyzed traffic in Google Analytics.", tags: ["Google Analytics"] }],
    },
  ],
};

const analystPrefs: Preferences = {
  titles: ["Data Analyst", "Marketing Analyst", "Business Intelligence Analyst"],
  allowedRegions: ["CA"],
};

const engineer: MasterProfile = {
  contact: { name: "Sam" },
  skills: { Languages: ["Java", "TypeScript"] },
  experience: [
    {
      company: "BigCo",
      title: "Software Engineer",
      start: "2021-03",
      end: "2026-06",
      bullets: [{ id: "e-1", text: "Built services.", tags: ["java"] }],
    },
    {
      company: "Lab",
      title: "Software Developer",
      start: "2019-01",
      end: "2020-10",
      bullets: [{ id: "e-2", text: "Built more services.", tags: ["java"] }],
    },
  ],
};

describe("relevant vs total years", () => {
  it("counts only roles whose titles overlap the target titles", () => {
    expect(totalYearsExperience(careerChanger, NOW)).toBeGreaterThan(6);
    // Only "Marketing Intern" overlaps ("marketing"); "Teacher" does not.
    const rel = relevantYearsFromTitles(careerChanger, analystPrefs.titles!, NOW);
    expect(rel).toBeLessThan(1);
    expect(rel).toBeGreaterThan(0);
  });

  it("keeps full history for a candidate whose roles all match the targets", () => {
    const titles = ["Backend Software Engineer", "Senior Software Engineer"];
    expect(relevantYearsFromTitles(engineer, titles, NOW)).toBe(
      totalYearsExperience(engineer, NOW)
    );
  });

  it("seniority words in target titles are not treated as field signal", () => {
    // "Lead"/"Senior" must not make "Orchestra Section Lead" relevant.
    const withLead: MasterProfile = {
      ...careerChanger,
      experience: [
        {
          company: "Orchestra",
          title: "Orchestra Section Lead",
          start: "2019-09",
          end: "2024-04",
          bullets: [{ id: "o-1", text: "Led the section.", tags: [] }],
        },
      ],
    };
    expect(relevantYearsFromTitles(withLead, ["Senior Data Analyst", "Lead Analyst"], NOW)).toBe(0);
  });

  it("computeMatchFacts prefers the profile's explicit relevantYears override", () => {
    const facts = computeMatchFacts({ ...careerChanger, relevantYears: 1.5 }, analystPrefs, NOW);
    expect(facts.relevantYearsExperience).toBe(1.5);
    expect(facts.yearsExperience).toBeGreaterThan(6);
  });

  it("years knockout uses relevant years, not total", () => {
    const facts = computeMatchFacts({ ...careerChanger, relevantYears: 1.5 }, analystPrefs, NOW);
    const r = triageDeterministic(
      {
        title: "Senior Data Analyst",
        location: "Toronto, ON",
        description:
          "Requires 6+ years of professional experience in analytics engineering with SQL and Power BI dashboards for reporting." +
          " You will own KPI reporting end to end across the organization and mentor junior analysts on the team.",
      },
      facts,
      analystPrefs
    );
    expect(r.verdict).toBe("disqualified");
    expect(r.disqualifiers.join(" ")).toContain("1.5 relevant");
  });
});

const pad = " Responsibilities include partnering with stakeholders and producing reporting.".repeat(3);

const WEALTH_JD =
  "You will support advisor-facing reporting with SQL, Excel and Power BI dashboards. " +
  "Required Qualifications: 2-4 years of relevant experience in Canadian retail wealth distribution, " +
  "sales enablement, business intelligence, sales operations, marketing, CRM, campaign support, " +
  "or a related investment distribution support role." +
  pad;

describe("domain must-have downgrade", () => {
  const facts: MatchFacts = {
    yearsExperience: 7.5,
    relevantYearsExperience: 1.5,
    languages: ["sql"],
    skills: ["sql", "excel", "power bi", "dashboards", "kpi reporting"],
    titles: ["Data Analyst", "Business Intelligence Analyst"],
    dealbreakers: [],
    allowedRegions: ["CA"],
  };
  const prefs: Preferences = { allowedRegions: ["CA"] };

  it("extracts the OR'd domain alternatives as one group, skipping generic escape hatches", () => {
    const groups = extractDomainRequirements(WEALTH_JD);
    expect(groups).toHaveLength(1);
    const domains = groups[0]!;
    expect(domains).toContain("canadian retail wealth distribution");
    expect(domains).toContain("sales enablement");
    // "a related investment distribution support role" is an escape hatch, not a domain.
    expect(domains.join("|")).not.toContain("related");
  });

  it("does not treat tech or profession-generic years phrases as domains", () => {
    expect(extractDomainRequirements("5+ years of experience in Java and Spring Boot")).toEqual([]);
    expect(extractDomainRequirements("8+ years of experience in software development")).toEqual([]);
    // Engineering deliverables are stack/practice fit, not an industry domain.
    expect(
      extractDomainRequirements("6+ years of experience in building cloud-native services like APIs")
    ).toEqual([]);
    expect(extractDomainRequirements("4+ years of experience in distributed systems")).toEqual([]);
  });

  it("caps tool-overlap scores when no domain alternative is matched", () => {
    const r = triageDeterministic(
      { title: "Business Intelligence Relationship Consultant", location: "Toronto, ON", description: WEALTH_JD },
      facts,
      prefs
    );
    expect(r.score).toBeLessThanOrEqual(DOMAIN_GAP_CAP);
    expect(r.verdict).toBe("maybe");
    expect(r.reason).toContain("domain gap");
    expect(r.domainGaps).toContain("canadian retail wealth distribution");
  });

  it("does not cap when the candidate's skills cover one of the alternatives", () => {
    const finFacts: MatchFacts = { ...facts, skills: [...facts.skills, "sales operations"] };
    const r = triageDeterministic(
      { title: "BI Consultant", location: "Toronto, ON", description: WEALTH_JD },
      finFacts,
      prefs
    );
    expect(r.domainGaps).toEqual([]);
    expect(r.reason).not.toContain("domain gap");
  });

  it("holds the cap even when LLM arbitration scores the job high", async () => {
    const llm: LlmClient = {
      enabled: true,
      completeJson: async () =>
        ({ results: [{ i: 0, score: 0.9, reason: "Strong BI fit" }] }) as never,
    };
    const [r] = await triageJobs(
      llm,
      [{ title: "BI Relationship Consultant", location: "Toronto, ON", description: WEALTH_JD }],
      facts,
      prefs
    );
    expect(r!.score).toBeLessThanOrEqual(DOMAIN_GAP_CAP);
    expect(r!.verdict).toBe("maybe");
    expect(r!.reason).toContain("domain gap");
  });

  it("sends the honest relevant-years line to the LLM, not the inflated total", async () => {
    let prompt = "";
    const llm: LlmClient = {
      enabled: true,
      completeJson: async (messages: { role: string; content: string }[]) => {
        prompt = messages.map((m) => m.content).join("\n");
        return { results: [] } as never;
      },
    } as LlmClient;
    await triageJobs(
      llm,
      [{ title: "BI Relationship Consultant", location: "Toronto, ON", description: WEALTH_JD }],
      facts,
      prefs
    );
    expect(prompt).toContain("~1.5 relevant to target roles (7.5 total");
  });
});

describe("years-anchored tool/domain must-haves (Camunda/Banking phrasings)", () => {
  // Owner-like facts: Java/Spring backend dev, no banking, no Camunda.
  const devFacts: MatchFacts = {
    yearsExperience: 7,
    relevantYearsExperience: 7,
    languages: ["java", "typescript"],
    skills: ["java", "spring boot", "hibernate", "kafka", "aws", "kubernetes", "sql", "oauth"],
    titles: ["Backend Software Engineer", "Senior Software Engineer"],
    dealbreakers: [],
    allowedRegions: ["US", "CA"],
  };
  const prefs: Preferences = { allowedRegions: ["US", "CA"] };

  const CAMUNDA_JD =
    "We use Java, Spring Boot, Kafka, AWS and Kubernetes daily. Must have: " +
    "• 3+ years of work experience with Camunda BPM\n" +
    "• 3+ years of Banking experience\n" +
    "• 6+ years of work experience with Java\n" +
    "• 6+ years of work experience with Spring Boot\n" +
    pad;

  it('extracts "years of work experience with <tool>" and "years of <Domain> experience" forms', () => {
    const groups = extractDomainRequirements(CAMUNDA_JD);
    expect(groups).toContainEqual(["camunda bpm"]);
    expect(groups).toContainEqual(["banking"]);
  });

  it('extracts "<Domain> experience (N+ years)"', () => {
    expect(extractDomainRequirements("Banking experience (3+ years) is required")).toContainEqual([
      "banking",
    ]);
  });

  it("a satisfied Java group must not mask the unmet Banking/Camunda groups (AND semantics)", () => {
    const r = triageDeterministic(
      { title: "Senior Java Backend Developer", location: "Toronto, ON", description: CAMUNDA_JD },
      devFacts,
      prefs
    );
    expect(r.score).toBeLessThanOrEqual(DOMAIN_GAP_CAP);
    expect(r.verdict).toBe("maybe");
    expect(r.domainGaps).toContain("camunda bpm");
    expect(r.domainGaps).toContain("banking");
    expect(r.reason).toContain("domain gap");
  });

  it("control: years-anchored vocab tech the candidate covers never caps", () => {
    const r = triageDeterministic(
      {
        title: "Senior Java Backend Developer",
        location: "Toronto, ON",
        description:
          "Requirements: 6+ years of work experience with Java. 5+ years of work experience with Spring Boot. Kafka and AWS daily." +
          pad,
      },
      devFacts,
      prefs
    );
    expect(r.domainGaps).toEqual([]);
    expect(r.score).toBeGreaterThanOrEqual(0.6);
    expect(r.verdict).toBe("strong");
  });

  it("preference wording is not a must-have: no cap on 'banking experience preferred'", () => {
    expect(
      extractDomainRequirements("5+ years of Banking experience preferred." + pad)
    ).toEqual([]);
    expect(
      extractDomainRequirements("3+ years of experience in capital markets is an asset")
    ).toEqual([]);
  });

  it("caps when the title names a tool the profile shows nothing for", () => {
    const r = triageDeterministic(
      {
        title: "Senior Java Backend Developer with Camunda",
        location: "Toronto, ON",
        description: `We use Java, Spring Boot, Kafka, AWS, Kubernetes, SQL and OAuth in production.${pad}`,
      },
      devFacts,
      prefs
    );
    expect(r.domainGaps).toContain("camunda");
    expect(r.score).toBeLessThanOrEqual(DOMAIN_GAP_CAP);
    expect(r.verdict).toBe("maybe");
  });

  it("does not cap when the title-named tool is in the candidate's stack", () => {
    const r = triageDeterministic(
      {
        title: "Backend Developer with Java",
        location: "Toronto, ON",
        description: `We use Java, Spring Boot, Kafka, AWS, Kubernetes, SQL and OAuth in production.${pad}`,
      },
      devFacts,
      prefs
    );
    expect(r.domainGaps).toEqual([]);
    expect(r.verdict).toBe("strong");
  });
});

describe("TECH_VOCAB ambiguity guards", () => {
  it("ignores everyday-English 'go', 'vue', 'spring', 'excel'", () => {
    expect(mentionsTech("we go the extra mile for clients", "go")).toBe(false);
    expect(mentionsTech("une vue d'ensemble du programme", "vue")).toBe(false);
    expect(mentionsTech("start date: spring 2026", "spring")).toBe(false);
    expect(mentionsTech("you excel in a fast-paced environment", "excel")).toBe(false);
    expect(mentionsTech("the rest of the team", "rest")).toBe(false);
  });

  it("still matches the qualified/tech-context forms", () => {
    expect(mentionsTech("services written in golang", "go")).toBe(true);
    expect(mentionsTech("experience with go, python and kafka", "go")).toBe(true);
    expect(mentionsTech("frontend in vue.js", "vue")).toBe(true);
    expect(mentionsTech("react or vue experience", "vue")).toBe(true);
    expect(mentionsTech("java with spring boot", "spring")).toBe(true);
    expect(mentionsTech("proficiency in microsoft excel", "excel")).toBe(true);
    expect(mentionsTech("advanced excel, sql and power bi", "excel")).toBe(true);
    expect(mentionsTech("build restful apis", "rest")).toBe(true);
  });

  it("recognizes data-analyst tooling in a JD", () => {
    const jd = "we need excel, power bi, tableau, looker studio, ga4 and bigquery skills".toLowerCase();
    for (const term of ["power bi", "tableau", "looker studio", "ga4", "bigquery", "excel"]) {
      expect(TECH_VOCAB).toContain(term);
      expect(mentionsTech(jd, term)).toBe(true);
    }
  });

  it("a French/marketing JD with 'vue' no longer zeroes the stack fit", () => {
    const facts: MatchFacts = {
      yearsExperience: 2,
      relevantYearsExperience: 2,
      languages: ["sql"],
      skills: ["sql", "excel", "power bi"],
      titles: ["Data Analyst"],
      dealbreakers: [],
      allowedRegions: ["CA"],
    };
    const r = triageDeterministic(
      {
        title: "Analyste de données",
        location: "Toronto, ON",
        description:
          "Vous avez une vue d'ensemble des données. Requirements: SQL, Excel and Power BI reporting." +
          pad,
      },
      facts,
      { allowedRegions: ["CA"] }
    );
    expect(r.missingRequired).not.toContain("vue");
    expect(r.coveredTech).toContain("power bi");
  });
});
