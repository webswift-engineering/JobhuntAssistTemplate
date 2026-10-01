import { describe, it, expect } from "vitest";
import {
  tailorFromProfile,
  jdOverlapScore,
  topUpRank,
  isBugFixBullet,
  isCompiledVariant,
  finalExperienceBulletIds,
} from "../src/profile/tailorFromProfile.js";
import { DisabledLlm, MockLlm } from "./helpers.js";
import type { MasterProfile } from "../src/profile/masterProfile.js";

const profile: MasterProfile = {
  contact: { name: "Test" },
  summary: "Backend engineer with Node.js experience.",
  skills: { Backend: ["Node.js", "PostgreSQL"], Cloud: ["AWS", "Kubernetes"] },
  experience: [
    {
      company: "Acme",
      title: "Engineer",
      start: "2020-01",
      end: "Present",
      bullets: [
        { id: "acme-1", text: "Built REST services in Node.js and TypeScript.", tags: ["node"] },
        { id: "acme-2", text: "Managed PostgreSQL databases.", tags: ["postgresql"] },
        { id: "acme-3", text: "Fixed critical production bug in payment API.", tags: ["debugging"] },
        { id: "acme-x1", text: "Built REST services in Node.js with TypeScript for high traffic.", tags: ["node"] },
      ],
    },
  ],
};

describe("tailorFromProfile helpers", () => {
  it("scores JD overlap higher for relevant bullets", () => {
    const jdLc = "senior node.js backend engineer with kubernetes on aws";
    expect(jdOverlapScore("Built REST services in Node.js and TypeScript.", jdLc)).toBeGreaterThan(
      jdOverlapScore("Managed PostgreSQL databases.", jdLc)
    );
  });

  it("deprioritizes bug-fix bullets in top-up ranking", () => {
    const jd = "node.js backend engineer";
    const jdLc = jd.toLowerCase();
    const good = topUpRank({ id: "acme-1", text: "Built REST services in Node.js." }, jdLc);
    const bad = topUpRank({ id: "acme-3", text: "Fixed critical production bug in payment API." }, jdLc);
    expect(good).toBeGreaterThan(bad);
  });

  it("detects compiled variants and bug-fix framing", () => {
    expect(isCompiledVariant("acme-x1")).toBe(true);
    expect(isCompiledVariant("acme-1")).toBe(false);
    expect(isBugFixBullet("Fixed critical production bug")).toBe(true);
    expect(isBugFixBullet("Built REST services")).toBe(false);
  });
});

describe("tailorFromProfile", () => {
  it("selects bullets without fabricating missing JD keywords", async () => {
    const jd = "Need Node.js and Kafka experience.";
    const r = await tailorFromProfile(new DisabledLlm(), profile, jd);
    const body = r.sections.flatMap((s) => s.items).join(" ").toLowerCase();
    expect(body).toContain("node");
    expect(r.keyword_coverage.missing).toEqual(expect.arrayContaining(["kafka"]));
    expect(body).not.toContain("kafka");
  });

  it("applies LLM summary, skills, and bullet rewrites", async () => {
    const mock = new MockLlm()
      .push({
        selected_bullet_ids: ["acme-1"],
        summary: "Node.js backend engineer focused on scalable APIs.",
        skill_groups: { Backend: ["Node.js"], Cloud: ["Kubernetes"] },
        bullet_rewrites: {
          "acme-1": "Delivered scalable REST services in Node.js and TypeScript.",
        },
        cover_letter: "Dear Hiring Manager,\n\nI apply.\n\nBest",
        changes_summary: "Tailored for Node/K8s role with grounded rewrites.",
      })
      .push({ bullet_rewrites: {} });
    const r = await tailorFromProfile(mock, profile, "Node.js and Kubernetes backend role.");
    expect(r.doc?.summary).toBe("Node.js backend engineer focused on scalable APIs.");
    expect(r.doc?.skills?.[0]).toEqual({ label: "Backend", value: "Node.js" });
    expect(r.doc?.experience?.[0]?.bullets[0]).toBe(
      "Delivered scalable REST services in Node.js and TypeScript."
    );
  });

  it("top-up uses curated bullets only, not compiled variants", () => {
    const jdLc = "node.js backend engineer".toLowerCase();
    const ids = finalExperienceBulletIds(profile, ["acme-1"], jdLc);
    expect(ids).toContain("acme-1");
    expect(ids).not.toContain("acme-x1");
  });

  it("polishes top-up bullets via a second LLM pass", async () => {
    const mock = new MockLlm()
      .push({
        selected_bullet_ids: ["acme-1"],
        summary: "Backend engineer.",
        skill_groups: { Backend: ["Node.js"] },
        bullet_rewrites: {
          "acme-1": "Delivered REST services in Node.js and TypeScript.",
        },
        cover_letter: "Dear Hiring Manager,\n\nI apply.\n\nBest",
        changes_summary: "Selected acme-1.",
      })
      .push({
        bullet_rewrites: {
          "acme-2": "Managed PostgreSQL databases supporting high-traffic services.",
        },
      });
    const r = await tailorFromProfile(mock, profile, "Node.js and PostgreSQL backend role.");
    expect(mock.calls.length).toBe(2);
    const bullets = r.doc?.experience?.[0]?.bullets ?? [];
    expect(bullets.some((b) => b.includes("PostgreSQL"))).toBe(true);
    expect(bullets.some((b) => b.includes("acme-x1"))).toBe(false);
  });

  it("JD-ranks top-up bullets in offline mode", async () => {
    const jd = "PostgreSQL database administrator with Node.js";
    const r = await tailorFromProfile(new DisabledLlm(), profile, jd);
    const bullets = r.doc?.experience?.[0]?.bullets ?? [];
    // acme-2 (PostgreSQL) should rank above acme-3 (bug fix) when topping up.
    const pgIdx = bullets.findIndex((b) => b.toLowerCase().includes("postgresql"));
    const fixIdx = bullets.findIndex((b) => b.toLowerCase().includes("fixed"));
    if (pgIdx >= 0 && fixIdx >= 0) expect(pgIdx).toBeLessThan(fixIdx);
  });
});

// Profile where Kafka is proven inside a bullet but NOT hoisted into the skills section.
const kafkaProfile: MasterProfile = {
  contact: { name: "Test" },
  summary: "Backend engineer.",
  skills: { Backend: ["Java", "Spring Boot"] },
  experience: [
    {
      company: "Acme",
      title: "Engineer",
      start: "2020-01",
      end: "Present",
      bullets: [
        { id: "k-1", text: "Built a Kafka streaming pipeline for real-time event processing.", tags: ["kafka"] },
        { id: "k-2", text: "Developed Spring Boot REST APIs.", tags: ["java"] },
      ],
    },
  ],
};

describe("tailorFromProfile — full utilization improvements", () => {
  it("surfaces a JD skill that is only proven inside a bullet (Kafka)", async () => {
    const mock = new MockLlm()
      .push({
        selected_bullet_ids: ["k-1", "k-2"],
        summary: "Backend engineer with Kafka streaming experience.",
        skill_groups: {
          "Event Streaming": ["Kafka"], // not in profile.skills, but proven in k-1
          Backend: ["Java", "Spring Boot"],
        },
        bullet_rewrites: {},
        cover_letter: "Dear Hiring Manager,\n\nI build Kafka pipelines.\n\nBest",
        changes_summary: "Surfaced Kafka.",
      })
      .push({ bullet_rewrites: {} });
    const r = await tailorFromProfile(mock, kafkaProfile, "Java and Kafka streaming role.");
    const kafkaGroup = r.doc?.skills?.find((s) => s.value.includes("Kafka"));
    expect(kafkaGroup).toBeTruthy();
  });

  it("does NOT surface a skill the profile cannot prove", async () => {
    const mock = new MockLlm()
      .push({
        selected_bullet_ids: ["k-2"],
        summary: "Backend engineer.",
        skill_groups: { Backend: ["Java", "Rust"] }, // Rust is nowhere in the profile
        bullet_rewrites: {},
        cover_letter: "Dear Hiring Manager,\n\nI apply.\n\nBest",
        changes_summary: "x",
      })
      .push({ bullet_rewrites: {} });
    const r = await tailorFromProfile(mock, kafkaProfile, "Java backend role.");
    const skillsText = (r.doc?.skills ?? []).map((s) => s.value).join(" ");
    expect(skillsText).toContain("Java");
    expect(skillsText).not.toContain("Rust");
  });

  it("scrubs cover-letter sentences that claim an unprovable JD keyword", async () => {
    const mock = new MockLlm()
      .push({
        selected_bullet_ids: ["k-2"],
        summary: "Backend engineer.",
        skill_groups: { Backend: ["Java"] },
        bullet_rewrites: {},
        cover_letter:
          "I am a backend engineer with several years of experience building production services in Java and Spring Boot. I am also an expert in Terraform for infrastructure automation. My work has centered on designing reliable REST APIs and event-driven systems that scale, and I take pride in writing well-tested, maintainable code. I would love to join your team and contribute immediately.",
        changes_summary: "x",
      })
      .push({ bullet_rewrites: {} });
    const r = await tailorFromProfile(mock, kafkaProfile, "Java role using Terraform and Kubernetes.");
    // Terraform is unprovable → the sentence mentioning it is removed.
    expect(r.cover_letter.toLowerCase()).not.toContain("terraform");
    expect(r.cover_letter.toLowerCase()).toContain("java");
  });

  it("drops an LLM summary that fabricates an unprovable keyword", async () => {
    const mock = new MockLlm()
      .push({
        selected_bullet_ids: ["k-2"],
        summary: "Backend engineer with deep Terraform expertise.", // Terraform unprovable
        skill_groups: { Backend: ["Java"] },
        bullet_rewrites: {},
        cover_letter: "Dear Hiring Manager,\n\nI apply.\n\nBest",
        changes_summary: "x",
      })
      .push({ bullet_rewrites: {} });
    const r = await tailorFromProfile(mock, kafkaProfile, "Java role using Terraform.");
    expect(r.doc?.summary?.toLowerCase()).not.toContain("terraform");
    expect(r.doc?.summary).toBe("Backend engineer."); // fell back to master summary
  });

  it("tags LLM output as tailoredMode 'llm'", async () => {
    const mock = new MockLlm()
      .push({
        selected_bullet_ids: ["k-2"],
        summary: "Backend engineer.",
        skill_groups: { Backend: ["Java"] },
        bullet_rewrites: {},
        cover_letter: "Dear Hiring Manager,\n\nI apply.\n\nBest",
        changes_summary: "x",
      })
      .push({ bullet_rewrites: {} });
    const r = await tailorFromProfile(mock, kafkaProfile, "Java backend role.");
    expect(r.tailoredMode).toBe("llm");
  });

  it("tags offline fallback as tailoredMode 'offline'", async () => {
    const r = await tailorFromProfile(new DisabledLlm(), kafkaProfile, "Java backend role.");
    expect(r.tailoredMode).toBe("offline");
  });

  it("omits projects when the experience section already fills the page", async () => {
    const fullProfile: MasterProfile = {
      contact: { name: "Test" },
      summary: "Engineer.",
      skills: { Backend: ["Java"] },
      experience: [
        {
          company: "A",
          title: "Engineer",
          start: "2022-01",
          end: "Present",
          bullets: [
            { id: "a-1", text: "Designed a payments API in Java and Spring Boot." },
            { id: "a-2", text: "Migrated the billing datastore to PostgreSQL with zero downtime." },
            { id: "a-3", text: "Built a Kafka consumer for real-time order events." },
            { id: "a-4", text: "Automated deployments with Jenkins and Kubernetes manifests." },
          ],
        },
        {
          company: "B",
          title: "Engineer",
          start: "2019-01",
          end: "2021-12",
          bullets: [
            { id: "b-1", text: "Implemented OAuth2 login for the customer portal." },
            { id: "b-2", text: "Optimized report generation, cutting runtime substantially." },
            { id: "b-3", text: "Wrote integration tests raising coverage across services." },
            { id: "b-4", text: "Containerized legacy apps with Docker for CI pipelines." },
          ],
        },
      ],
      projects: [{ name: "Proj", context: "A", stack: "Java", bullets: ["Did a Java thing."] }],
    };
    const r = await tailorFromProfile(new DisabledLlm(), fullProfile, "Java backend engineer with Spring Boot.");
    expect((r.doc?.projects ?? []).length).toBe(0);
  });

  it("includes a project when the experience section is thin", async () => {
    const sparseProfile: MasterProfile = {
      contact: { name: "Test" },
      summary: "Engineer.",
      skills: { Backend: ["Java"] },
      experience: [
        {
          company: "A",
          title: "Engineer",
          start: "2022-01",
          end: "Present",
          bullets: [{ id: "a-1", text: "Built a Java service." }],
        },
      ],
      projects: [{ name: "Proj", context: "A", stack: "Java", bullets: ["Did a Java thing."] }],
    };
    const r = await tailorFromProfile(new DisabledLlm(), sparseProfile, "Java backend role.");
    expect((r.doc?.projects ?? []).length).toBeGreaterThan(0);
  });

  it("coverage repair force-selects the evidence bullet for an uncovered must-have", async () => {
    const evidence = [
      // Kafka provable via k-1, NOT in skills section — LLM below fails to select k-1.
      { requirement: "Kafka", kind: "must" as const, provable: true, bulletIds: ["k-1"], inSkillsSection: false },
      { requirement: "Java", kind: "must" as const, provable: true, bulletIds: ["k-2"], inSkillsSection: true },
      { requirement: "Terraform", kind: "must" as const, provable: false, bulletIds: [], inSkillsSection: false },
    ];
    const mock = new MockLlm()
      .push({
        selected_bullet_ids: ["k-2"], // ignores the Kafka instruction
        summary: "Backend engineer.",
        skill_groups: { Backend: ["Java"] },
        bullet_rewrites: {},
        cover_letter: "Dear Hiring Manager,\n\nI apply.\n\nBest",
        changes_summary: "x",
      })
      .push({ bullet_rewrites: {} });
    const r = await tailorFromProfile(mock, kafkaProfile, "Java and Kafka streaming role.", { evidence });

    // The prompt carried the coverage-directed block.
    const firstCall = mock.calls[0]!.map((m) => m.content).join("\n");
    expect(firstCall).toContain("MUST be covered");
    expect(firstCall).toContain("Kafka");
    expect(firstCall).toContain("NEVER claim");
    expect(firstCall).toContain("Terraform");

    // Repair selected k-1 despite the LLM's omission → Kafka bullet in the doc.
    const bullets = r.doc?.experience?.[0]?.bullets ?? [];
    expect(bullets.some((b) => b.toLowerCase().includes("kafka"))).toBe(true);

    // Coverage report: Kafka covered via k-1, Terraform an honest unprovable gap.
    const cov = r.requirement_coverage!;
    expect(cov.find((c) => c.requirement === "Kafka")).toMatchObject({ status: "covered", bulletIds: ["k-1"] });
    expect(cov.find((c) => c.requirement === "Terraform")).toMatchObject({ status: "unprovable" });
    // And the unprovable keyword never leaks into the output.
    const body = r.sections.flatMap((s) => s.items).join(" ").toLowerCase();
    expect(body).not.toContain("terraform");
  });

  it("retries the LLM once before degrading to the offline fallback", async () => {
    const mock = new MockLlm(1) // first call throws
      .push({
        selected_bullet_ids: ["k-2"],
        summary: "Backend engineer with Java experience.",
        skill_groups: { Backend: ["Java"] },
        bullet_rewrites: {},
        cover_letter: "Dear Hiring Manager,\n\nI apply.\n\nBest",
        changes_summary: "Recovered on retry.",
      })
      .push({ bullet_rewrites: {} });
    const r = await tailorFromProfile(mock, kafkaProfile, "Java backend role.");
    expect(r.changes_summary).toBe("Recovered on retry.");
  });
});
