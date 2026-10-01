import { describe, it, expect } from "vitest";
import { scoreJob, heuristicScore } from "../src/llm/scoreJob.js";
import { MockLlm, DisabledLlm } from "./helpers.js";

const prefs = { titles: ["Frontend Engineer"], keywords: ["react", "typescript"] };

describe("scoreJob (§8.1)", () => {
  it("uses LLM result when available + valid", async () => {
    const llm = new MockLlm().push({ score: 0.91, reason: "Strong match" });
    const r = await scoreJob(llm, { title: "Frontend Engineer", description: "react" }, prefs);
    expect(r.score).toBe(0.91);
    expect(r.reason).toBe("Strong match");
  });

  it("accepts rubric component sub-scores and feeds candidate skills into the prompt", async () => {
    const llm = new MockLlm().push({
      title_fit: 80,
      skills_fit: 90,
      domain_fit: 70,
      score: 0.81,
      reason: "React + TS match",
    });
    const r = await scoreJob(
      llm,
      { title: "Frontend Engineer", description: "react" },
      prefs,
      { candidateSkills: ["React", "Kafka"] }
    );
    expect(r.score).toBe(0.81);
    const prompt = llm.calls[0]![0]!.content;
    expect(prompt).toContain("Kafka"); // candidate skills reach the model
    expect(prompt.toLowerCase()).toContain("skills_fit"); // rubric present
  });

  it("retries once then fails soft to heuristic", async () => {
    const llm = new MockLlm(2); // fails both attempts
    const r = await scoreJob(
      llm,
      { title: "Frontend Engineer", description: "we use react and typescript" },
      prefs
    );
    expect(r.score).toBeGreaterThan(0); // heuristic kicked in
  });

  it("heuristic falls back when LLM disabled", async () => {
    const r = await scoreJob(
      new DisabledLlm(),
      { title: "Frontend Engineer", description: "react typescript role" },
      prefs
    );
    expect(r.score).toBeGreaterThan(0.5);
  });

  it("heuristic rewards title match", () => {
    const hit = heuristicScore({ title: "Frontend Engineer", description: "react" }, prefs);
    const miss = heuristicScore({ title: "Janitor", description: "mopping" }, prefs);
    expect(hit.score).toBeGreaterThan(miss.score);
  });

  it("neutral 0.5 when no preferences set", () => {
    expect(heuristicScore({ title: "Anything" }, {}).score).toBe(0.5);
  });
});

describe("dealbreaker knockout (runs before the LLM, works when it is down)", () => {
  const dbPrefs = { ...prefs, dealbreakers: ["contract", "clearance"] };

  it("scores 0 with method 'dealbreaker' and never calls the LLM", async () => {
    const llm = new MockLlm().push({ score: 0.95, reason: "would have been great" });
    const r = await scoreJob(
      llm,
      { title: "Frontend Engineer (Contract)", description: "react typescript" },
      dbPrefs
    );
    expect(r.score).toBe(0);
    expect(r.method).toBe("dealbreaker");
    expect(r.reason).toContain("contract");
    expect(llm.calls).toHaveLength(0);
  });

  it("matches whole words only — 'contractual' is not 'contract'", async () => {
    const llm = new MockLlm().push({ score: 0.8, reason: "fine" });
    const r = await scoreJob(
      llm,
      { title: "Frontend Engineer", description: "contractual obligations of the platform, react" },
      dbPrefs
    );
    expect(r.method).toBe("llm");
    expect(r.score).toBe(0.8);
  });

  it("applies in heuristic (LLM-down) mode too", async () => {
    const r = await scoreJob(
      new DisabledLlm(),
      { title: "Frontend Engineer", description: "requires security clearance, react" },
      dbPrefs
    );
    expect(r.score).toBe(0);
    expect(r.method).toBe("dealbreaker");
  });
});
