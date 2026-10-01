import { describe, it, expect } from "vitest";
import { requiredYears, triageDeterministic, triageJobs } from "../src/llm/triageJob.js";
import type { LlmClient } from "../src/llm/client.js";
import type { MatchFacts } from "../src/profile/matchFacts.js";
import type { Preferences } from "../src/types.js";

const facts: MatchFacts = {
  yearsExperience: 7,
  languages: ["java", "typescript"],
  skills: ["java", "spring boot", "aws", "typescript"],
  titles: ["backend engineer", "java developer"],
  dealbreakers: [],
  allowedRegions: ["US", "CA"],
};
const prefs: Preferences = { allowedRegions: ["US", "CA"] };

const pad = " Responsibilities include designing, building and operating production services.".repeat(3);

describe("triage with thin/missing JD", () => {
  it("caps a title-only job in the maybe band instead of scoring it 100", () => {
    const r = triageDeterministic(
      { title: "Lead Java Developer", company: "Iris", location: "Toronto, ON (Hybrid)", description: null },
      facts,
      prefs
    );
    expect(r.score).toBeLessThanOrEqual(0.55);
    expect(r.verdict).toBe("maybe");
    expect(r.reason).toContain("no JD — unverified");
  });

  it("does not cap when a real JD is present and fully covered", () => {
    const r = triageDeterministic(
      {
        title: "Lead Java Developer",
        location: "Toronto, ON",
        description: `We use Java, Spring Boot, AWS and TypeScript.${pad}`,
      },
      facts,
      prefs
    );
    expect(r.verdict).toBe("strong");
    expect(r.score).toBeGreaterThanOrEqual(0.6);
    expect(r.reason).not.toContain("unverified");
  });

  it("surfaces uncovered stack from a real JD and scores below strong", () => {
    const r = triageDeterministic(
      {
        title: "Lead Java Developer",
        location: "Toronto, ON",
        description: `Requires 7+ years of work experience with Angular, plus React and Vue on the frontend, and Java services.${pad}`,
      },
      facts,
      prefs
    );
    expect(r.missingRequired).toContain("angular");
    expect(r.score).toBeLessThan(0.6);
    expect(r.verdict).toBe("maybe");
  });

  it("still zeroes disqualified jobs regardless of JD length", () => {
    const r = triageDeterministic(
      { title: "Lead Java Developer", location: "London, United Kingdom", description: null },
      facts,
      prefs
    );
    expect(r.verdict).toBe("disqualified");
    expect(r.score).toBe(0);
  });
});

describe("requiredYears — candidate requirements only", () => {
  it("reads real experience requirements", () => {
    expect(requiredYears("8+ years of professional software development experience")).toBe(8);
    expect(requiredYears("Minimum 5-7 years relevant experience in banking")).toBe(5);
  });

  it("ignores company-tenure boilerplate", () => {
    expect(
      requiredYears("clients rely on our 30+ years of technical and domain expertise to future-proof their enterprise")
    ).toBeNull();
    expect(requiredYears("We have 25 years of experience delivering solutions to Fortune 500s")).toBeNull();
  });

  it("ignores years figures unrelated to experience", () => {
    expect(requiredYears("All hardware ships with a 5 year warranty and support plan")).toBeNull();
  });

  it("takes the highest requirement when several are stated", () => {
    expect(
      requiredYears("3+ years with Kubernetes experience and 10+ years of software engineering work overall")
    ).toBe(10);
  });
});

describe("low-evidence coverage ratio", () => {
  it("never gives a perfect score from 1-3 recognized terms", () => {
    const hrisFacts: MatchFacts = { ...facts, skills: ["sql", "rest"] };
    const r = triageDeterministic(
      {
        title: "Senior Application Developer (HRIS)",
        location: "Toronto, ON",
        description: `You will write SQL reports and build REST integrations for our HRIS platform.${pad}`,
      },
      hrisFacts,
      prefs
    );
    expect(r.score).toBeLessThanOrEqual(0.75);
    expect(r.coveredTech).toEqual(["sql", "rest"]);
  });
});

describe("LLM arbitration of low-evidence strongs", () => {
  function fakeLlm(score: number, calls: { n: number }): LlmClient {
    return {
      enabled: true,
      completeJson: async () => {
        calls.n++;
        return { results: [{ i: 0, score, reason: "LLM verdict" }] } as never;
      },
    };
  }

  it("sends a 2-term coverage 'strong' to the LLM instead of trusting the ratio", async () => {
    const calls = { n: 0 };
    const hrisFacts: MatchFacts = { ...facts, skills: ["sql", "rest"] };
    const [r] = await triageJobs(
      fakeLlm(0.45, calls),
      [
        {
          title: "Senior Application Developer (HRIS)",
          location: "Toronto, ON",
          description: `You will write SQL reports and build REST integrations for our HRIS platform.${pad}`,
        },
      ],
      hrisFacts,
      prefs
    );
    expect(calls.n).toBe(1);
    expect(r!.score).toBe(0.45);
    expect(r!.verdict).toBe("maybe");
    expect(r!.reason).toBe("LLM verdict");
  });

  it("keeps a well-evidenced strong without an LLM call", async () => {
    const calls = { n: 0 };
    const [r] = await triageJobs(
      fakeLlm(0.1, calls),
      [
        {
          title: "Lead Java Developer",
          location: "Toronto, ON",
          description: `We use Java, Spring Boot, AWS and TypeScript daily.${pad}`,
        },
      ],
      facts,
      prefs
    );
    expect(calls.n).toBe(0);
    expect(r!.verdict).toBe("strong");
  });
});
