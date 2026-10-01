import { describe, it, expect } from "vitest";
import {
  tailorResume,
  keywordCoverage,
  enforceNoFabrication,
  FabricationError,
  structuralFallback,
  type TailoredResume,
} from "../src/llm/tailorResume.js";
import { renderResume, lintParserSafe, normalizeDates, ParserSafetyError } from "../src/llm/renderResume.js";
import { MockLlm, DisabledLlm } from "./helpers.js";

const master = `SUMMARY
Senior backend engineer with 6 years building APIs.

EXPERIENCE
- Built REST services in Node.js and TypeScript at Acme (2020-2024).
- Led migration to PostgreSQL.

SKILLS
- Node.js, TypeScript, PostgreSQL, Docker`;

const jd = "We need a backend engineer skilled in Node.js, Kafka, and Terraform.";

describe("tailorResume guardrail (§8.3, §16 — MANDATORY)", () => {
  it("structural fallback output maps to master content; nothing invented", async () => {
    const r = await tailorResume(new DisabledLlm(), master, jd);
    const body = r.sections.flatMap((s) => s.items).join(" ").toLowerCase();
    // Master content survives.
    expect(body).toContain("postgresql");
    // JD-only keywords (Kafka, Terraform) are reported missing, NOT injected.
    expect(r.keyword_coverage.missing).toEqual(expect.arrayContaining(["kafka", "terraform"]));
    expect(body).not.toContain("kafka");
    expect(body).not.toContain("terraform");
  });

  it("keywordCoverage splits present vs missing against the master resume", () => {
    const cov = keywordCoverage(master, jd);
    expect(cov.present).toContain("node.js");
    expect(cov.missing).toEqual(expect.arrayContaining(["kafka", "terraform"]));
  });

  it("rejects fabrication when a missing keyword appears in a section (LLM cheats)", async () => {
    const cheating: TailoredResume = {
      sections: [{ heading: "Skills", items: ["Expert in Kafka and Terraform"] }],
      cover_letter: "",
      keyword_coverage: { present: [], missing: ["kafka", "terraform"] },
      changes_summary: "added skills",
    };
    expect(() => enforceNoFabrication(cheating)).toThrow(FabricationError);
  });

  it("tailorResume degrades to a safe (non-fabricated) result if the LLM cheats", async () => {
    const llm = new MockLlm().push({
      sections: [{ heading: "Skills", items: ["Kafka guru"] }],
      cover_letter: "",
      keyword_coverage: { present: [], missing: ["kafka"] },
      changes_summary: "x",
    });
    // Instead of hard-failing generation, fall back to the structural (master-only) output.
    const r = await tailorResume(llm, master, jd);
    const body = r.sections.flatMap((s) => s.items).join(" ").toLowerCase();
    expect(body).not.toContain("kafka");
    expect(body).toContain("postgresql"); // real master content survives
    for (const kw of r.keyword_coverage.missing) {
      expect(body).not.toContain(kw.toLowerCase());
    }
  });

  it("generic seniority words are not treated as fabrication keywords", () => {
    const cov = keywordCoverage("Backend engineer building APIs.", "Senior backend engineer wanted.");
    expect(cov.missing).not.toContain("senior");
    expect(cov.present).not.toContain("senior");
  });
});

describe("renderResume parser-safety (§8.3)", () => {
  it("produces single-column plain text and passes the lint", () => {
    const r = structuralFallback(master, jd);
    const out = renderResume(r);
    expect(out).toContain("SUMMARY");
    expect(() => lintParserSafe(out)).not.toThrow();
  });

  it("lint rejects tables / pipes / images / html / multi-column", () => {
    expect(() => lintParserSafe("a\tb")).toThrow(ParserSafetyError);
    expect(() => lintParserSafe("| a | b |")).toThrow(ParserSafetyError);
    expect(() => lintParserSafe("![x](y.png)")).toThrow(ParserSafetyError);
    expect(() => lintParserSafe("<table>")).toThrow(ParserSafetyError);
    expect(() => lintParserSafe("left text         right column")).toThrow(ParserSafetyError);
  });

  it("normalizes dates", () => {
    expect(normalizeDates("January 2021 - 2022")).toBe("Jan 2021–2022");
    expect(normalizeDates("2020 to present")).toBe("2020–present");
  });

  it("never injects missing keywords into the rendered doc", () => {
    const r = structuralFallback(master, jd);
    const out = renderResume(r).toLowerCase();
    for (const kw of r.keyword_coverage.missing) {
      expect(out.includes(kw)).toBe(false);
    }
  });
});
