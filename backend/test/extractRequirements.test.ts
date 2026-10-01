import { describe, it, expect } from "vitest";
import { createTestDb, MockLlm, DisabledLlm } from "./helpers.js";
import { getJdRequirements, heuristicRequirements } from "../src/llm/extractRequirements.js";
import {
  mapRequirementsToEvidence,
  computeRequirementCoverage,
  decomposeRequirement,
} from "../src/profile/requirementEvidence.js";
import { jdHash } from "../src/triageStore.js";
import type { MasterProfile } from "../src/profile/masterProfile.js";

const JD =
  "Senior Java Developer. Required: 5+ years of experience in Java, Spring Boot, and Kafka pipelines. Nice to have: Terraform. You will build payment APIs.";

const LLM_REQS = {
  mustHave: [
    { skill: "Java", kind: "tech" },
    { skill: "Spring Boot", kind: "tech" },
    { skill: "Kafka", kind: "tech" },
  ],
  niceToHave: [{ skill: "Terraform", evidenceTerms: [] }],
  responsibilities: ["build payment APIs"],
  keywords: ["payments"],
  seniority: "senior",
  yearsRequired: 5,
};

const profile: MasterProfile = {
  contact: { name: "T" },
  summary: "Backend engineer.",
  skills: { Backend: ["Java", "Spring Boot"] },
  experience: [
    {
      company: "Acme",
      title: "Engineer",
      start: "2020-01",
      end: "Present",
      bullets: [
        { id: "k-1", text: "Built a Kafka streaming pipeline.", tags: ["kafka"] },
        { id: "k-2", text: "Developed Spring Boot REST APIs in Java.", tags: ["java"] },
        { id: "k-3", text: "Modeled data in PostgreSQL and delivered in Scrum sprints.", tags: [] },
      ],
    },
  ],
};

describe("getJdRequirements", () => {
  it("extracts via LLM and caches by jd_hash", async () => {
    const db = createTestDb();
    const llm = new MockLlm().push(LLM_REQS);
    const first = await getJdRequirements(db, llm, JD);
    expect(first.method).toBe("llm");
    expect(first.cached).toBe(false);
    expect(first.reqs.mustHave.map((m) => m.skill)).toContain("Kafka");

    // Second call: cache hit — no LLM call (queue is empty, would throw).
    const second = await getJdRequirements(db, llm, JD);
    expect(second.cached).toBe(true);
    expect(second.reqs.yearsRequired).toBe(5);
  });

  it("falls back to the heuristic when the LLM is down, without caching it", async () => {
    const db = createTestDb();
    const down = await getJdRequirements(db, new DisabledLlm(), JD);
    expect(down.method).toBe("heuristic");
    expect(down.reqs.mustHave.map((m) => m.skill)).toEqual(
      expect.arrayContaining(["java", "spring boot", "kafka"])
    );
    expect(down.reqs.yearsRequired).toBe(5);

    // Once the LLM recovers, the better extraction replaces the (uncached) heuristic.
    const up = await getJdRequirements(db, new MockLlm().push(LLM_REQS), JD);
    expect(up.method).toBe("llm");
    expect(up.cached).toBe(false);
  });

  it("heuristicRequirements ignores company-tenure years", () => {
    const r = heuristicRequirements("Building on our 30 years of history. Java required. 3+ years of coding experience.");
    expect(r.yearsRequired).toBe(3);
  });

  it("ignores cached rows from an older extraction schema version", async () => {
    const db = createTestDb();
    // Legacy (unversioned) cache row, as written before evidenceTerms existed.
    await db.prepare(
      "INSERT INTO jd_requirements (jd_hash, extracted, method, created_at) VALUES (?, ?, 'llm', ?)"
    ).run(
      jdHash(JD),
      JSON.stringify({ ...LLM_REQS, mustHave: [{ skill: "Old", kind: "tech" }] }),
      Date.now()
    );
    const r = await getJdRequirements(db, new MockLlm().push(LLM_REQS), JD);
    expect(r.cached).toBe(false); // legacy row not used — re-extracted with the LLM
    expect(r.reqs.mustHave.map((m) => m.skill)).toContain("Kafka");
  });
});

describe("decomposeRequirement", () => {
  it("splits parenthetical example lists", () => {
    const terms = decomposeRequirement("Relational databases (e.g., MySQL, PostgreSQL)");
    expect(terms).toEqual(expect.arrayContaining(["MySQL", "PostgreSQL", "Relational databases"]));
    expect(terms).not.toContain("e.g.");
  });

  it("splits or/and alternatives", () => {
    expect(decomposeRequirement("Agile or Scrum")).toEqual(
      expect.arrayContaining(["Agile", "Scrum"])
    );
  });

  it("strips filler tails like 'development' and 'experience'", () => {
    expect(decomposeRequirement("RESTful API development")).toContain("RESTful API");
    expect(decomposeRequirement("Kubernetes experience")).toContain("Kubernetes");
  });

  it("strips filler lead-ins like 'Exposure to' and 'Knowledge of'", () => {
    expect(decomposeRequirement("Exposure to web security")).toContain("web security");
    expect(decomposeRequirement("Strong hands-on experience with Terraform")).toContain("Terraform");
    // Compound: split on "/" leaves "Knowledge of CI" — the lead-in must go too.
    expect(decomposeRequirement("Experience/Knowledge of CI/CD pipelines and workflows")).toContain(
      "CI"
    );
  });

  it("keeps slash compounds like CI/CD whole", () => {
    expect(decomposeRequirement("Experience/Knowledge of CI/CD pipelines and workflows")).toContain(
      "CI/CD"
    );
  });

  it("never emits bare filler words or generic verbs as probes", () => {
    const terms = decomposeRequirement("Experience/Knowledge of CI/CD pipelines and workflows");
    expect(terms).not.toContain("Experience");
    expect(terms).not.toContain("workflows");
    const ability = decomposeRequirement("Ability to integrate or adopt AI tools in day-to-day tasks");
    expect(ability).not.toContain("integrate");
  });
});

describe("requirement evidence + coverage", () => {
  it("maps requirements to proving bullets and flags unprovable ones", () => {
    const evidence = mapRequirementsToEvidence(profile, {
      ...LLM_REQS,
      mustHave: [...LLM_REQS.mustHave, { skill: "Rust", kind: "tech" }],
    } as any);
    const kafka = evidence.find((e) => e.requirement === "Kafka")!;
    expect(kafka.provable).toBe(true);
    expect(kafka.bulletIds).toEqual(["k-1"]);
    expect(kafka.inSkillsSection).toBe(false);

    const java = evidence.find((e) => e.requirement === "Java")!;
    expect(java.inSkillsSection).toBe(true);

    const rust = evidence.find((e) => e.requirement === "Rust")!;
    expect(rust.provable).toBe(false);
    expect(rust.bulletIds).toEqual([]);

    const terraform = evidence.find((e) => e.requirement === "Terraform")!;
    expect(terraform.kind).toBe("nice");
  });

  it("computeRequirementCoverage: covered via bullet or skills, gap when dropped", () => {
    const evidence = mapRequirementsToEvidence(profile, {
      ...LLM_REQS,
      mustHave: [...LLM_REQS.mustHave, { skill: "Rust", kind: "tech" }],
    } as any);
    // Final doc kept only k-2 → Kafka's bullet dropped and not in skills → gap.
    const cov = computeRequirementCoverage(evidence, ["k-2"]);
    expect(cov.find((c) => c.requirement === "Kafka")!.status).toBe("gap");
    expect(cov.find((c) => c.requirement === "Java")!.status).toBe("covered");
    expect(cov.find((c) => c.requirement === "Rust")!.status).toBe("unprovable");
  });

  it("proves compound requirements via decomposed sub-terms", () => {
    const evidence = mapRequirementsToEvidence(profile, {
      ...LLM_REQS,
      mustHave: [
        { skill: "Relational databases (e.g., MySQL, PostgreSQL)", kind: "tech", evidenceTerms: [] },
        { skill: "Agile or Scrum", kind: "practice", evidenceTerms: [] },
      ],
    } as any);
    const rdb = evidence.find((e) => e.requirement.startsWith("Relational"))!;
    expect(rdb.provable).toBe(true); // via PostgreSQL in bullet k-3
    expect(rdb.bulletIds).toContain("k-3");
    const agile = evidence.find((e) => e.requirement === "Agile or Scrum")!;
    expect(agile.provable).toBe(true); // via Scrum in bullet k-3
    expect(agile.bulletIds).toContain("k-3");
  });

  it("proves requirements via LLM evidenceTerms, verified against the corpus", () => {
    const evidence = mapRequirementsToEvidence(profile, {
      ...LLM_REQS,
      mustHave: [
        // "RESTful API development" appears nowhere verbatim; the probe "REST" does (k-2).
        { skill: "RESTful API development", kind: "tech", evidenceTerms: ["REST", "RESTful"] },
        // Probe terms absent from the profile can never create a match.
        { skill: "Golang services", kind: "tech", evidenceTerms: ["Go", "Golang"] },
      ],
    } as any);
    const rest = evidence.find((e) => e.requirement === "RESTful API development")!;
    expect(rest.provable).toBe(true);
    expect(rest.bulletIds).toContain("k-2");
    const go = evidence.find((e) => e.requirement === "Golang services")!;
    expect(go.provable).toBe(false);
    expect(go.bulletIds).toEqual([]);
  });

  it("satisfies degree requirements from the education section (master ≥ bachelor)", () => {
    const withEducation: MasterProfile = {
      ...profile,
      education: [
        { school: "State University", degree: "Master of Computer Science", year: "2022" },
      ],
    };
    const reqs = {
      ...LLM_REQS,
      mustHave: [
        { skill: "Bachelor's degree in a related field", kind: "domain", evidenceTerms: [] },
      ],
    } as any;

    const evidence = mapRequirementsToEvidence(withEducation, reqs);
    const degree = evidence.find((e) => e.requirement.startsWith("Bachelor"))!;
    expect(degree.provable).toBe(true);
    expect(degree.provenByEducation).toBe(true);
    // Education always renders, so the requirement is covered without any bullet.
    const cov = computeRequirementCoverage(evidence, []);
    expect(cov.find((c) => c.requirement.startsWith("Bachelor"))!.status).toBe("covered");

    // No education section → honest unprovable, as before.
    const without = mapRequirementsToEvidence(profile, reqs);
    expect(without.find((e) => e.requirement.startsWith("Bachelor"))!.provable).toBe(false);
  });

  it("rejects degree requirements above the profile's level", () => {
    const bachelorOnly: MasterProfile = {
      ...profile,
      education: [{ school: "U", degree: "Bachelor of Science", year: "2018" }],
    };
    const evidence = mapRequirementsToEvidence(bachelorOnly, {
      ...LLM_REQS,
      mustHave: [{ skill: "PhD in Computer Science", kind: "domain", evidenceTerms: [] }],
    } as any);
    expect(evidence.find((e) => e.requirement.startsWith("PhD"))!.provable).toBe(false);
  });

  it("proves umbrella requirements via built-in aliases, corpus-verified", () => {
    const devProfile: MasterProfile = {
      contact: { name: "T" },
      skills: { Infrastructure: ["Jenkins"] },
      experience: [
        {
          company: "Acme",
          title: "Engineer",
          start: "2020-01",
          end: "Present",
          bullets: [
            {
              id: "a-1",
              text: "Automated regression testing in Kubernetes/Jenkins CI.",
              tags: ["jenkins"],
            },
            {
              id: "a-2",
              text: "Diagnosed a production misfire during on-call response.",
              tags: ["debugging"],
            },
          ],
        },
      ],
    };
    const evidence = mapRequirementsToEvidence(devProfile, {
      ...LLM_REQS,
      mustHave: [{ skill: "Debugging and problem-solving", kind: "practice", evidenceTerms: [] }],
      niceToHave: [{ skill: "Experience/Knowledge of CI/CD pipelines and workflows", evidenceTerms: [] }],
    } as any);

    const debug = evidence.find((e) => e.requirement.startsWith("Debugging"))!;
    expect(debug.provable).toBe(true);
    expect(debug.bulletIds).toContain("a-2");

    const cicd = evidence.find((e) => e.requirement.includes("CI/CD"))!;
    expect(cicd.provable).toBe(true); // "CI" probe hits "Jenkins CI"; alias "Jenkins" hits skills
    expect(cicd.bulletIds).toContain("a-1");
  });

  it("aliases never fabricate: umbrella terms stay unprovable without corpus evidence", () => {
    const evidence = mapRequirementsToEvidence(profile, {
      ...LLM_REQS,
      mustHave: [{ skill: "Exposure to web security", kind: "tech", evidenceTerms: [] }],
    } as any);
    expect(evidence.find((e) => e.requirement.includes("web security"))!.provable).toBe(false);
  });

  it("proves nice-to-haves via their LLM evidenceTerms", () => {
    const evidence = mapRequirementsToEvidence(profile, {
      ...LLM_REQS,
      niceToHave: [
        { skill: "Streaming data platforms", evidenceTerms: ["Kafka", "Kinesis"] },
      ],
    } as any);
    const streaming = evidence.find((e) => e.requirement === "Streaming data platforms")!;
    expect(streaming.kind).toBe("nice");
    expect(streaming.provable).toBe(true); // via Kafka bullet k-1
    expect(streaming.bulletIds).toContain("k-1");
  });

  it("accepts legacy string nice-to-haves through the schema", async () => {
    const db = createTestDb();
    const llm = new MockLlm().push({ ...LLM_REQS, niceToHave: ["Terraform"] });
    const r = await getJdRequirements(db, llm, JD);
    expect(r.reqs.niceToHave).toEqual([{ skill: "Terraform", evidenceTerms: [] }]);
  });

  it("soft requirements report as 'soft', never 'unprovable'", () => {
    const evidence = mapRequirementsToEvidence(profile, {
      ...LLM_REQS,
      mustHave: [
        { skill: "Excellent written and communication skills", kind: "soft", evidenceTerms: [] },
        { skill: "Rust", kind: "tech", evidenceTerms: [] },
      ],
    } as any);
    const cov = computeRequirementCoverage(evidence, ["k-2"]);
    expect(cov.find((c) => c.requirement.startsWith("Excellent"))!.status).toBe("soft");
    expect(cov.find((c) => c.requirement === "Rust")!.status).toBe("unprovable");
  });
});
