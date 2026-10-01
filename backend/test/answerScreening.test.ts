import { describe, it, expect } from "vitest";
import { answerScreeningQuestions, SENSITIVE_QUESTION_RE } from "../src/llm/answerScreening.js";
import { MockLlm, DisabledLlm } from "./helpers.js";
import type { MasterProfile } from "../src/profile/masterProfile.js";

const profile = {
  contact: { name: "T" },
  relevantYears: 6,
  skills: { languages: ["Java", "Python"] },
  experience: [],
} as unknown as MasterProfile;

describe("answerScreeningQuestions", () => {
  it("never answers sensitive questions, even with the LLM up", async () => {
    const llm = new MockLlm().push({
      answers: [{ question: "What are your salary expectations?", answer: "100000" }],
    });
    const r = await answerScreeningQuestions(llm, profile, [
      "What are your salary expectations?",
      "Will you require visa sponsorship?",
    ]);
    expect(r.answers["What are your salary expectations?"]).toBeNull();
    expect(r.answers["Will you require visa sponsorship?"]).toBeNull();
    expect(llm.calls).toHaveLength(0); // guarded before any call
  });

  it("answers factual questions via the LLM and caps at 20 chars", async () => {
    const llm = new MockLlm().push({
      answers: [
        { question: "How many years of work experience do you have with Java?", answer: "6" },
        { question: "Unknown tech?", answer: null },
      ],
    });
    const r = await answerScreeningQuestions(llm, profile, [
      "How many years of work experience do you have with Java?",
      "Unknown tech?",
    ]);
    expect(r.method).toBe("llm");
    expect(r.answers["How many years of work experience do you have with Java?"]).toBe("6");
    expect(r.answers["Unknown tech?"]).toBeNull();
  });

  it("returns all-null when the LLM is disabled (human answers in the wizard)", async () => {
    const r = await answerScreeningQuestions(new DisabledLlm(), profile, ["Years with Java?"]);
    expect(r.method).toBe("unavailable");
    expect(r.answers["Years with Java?"]).toBeNull();
  });

  it("sensitive regex covers the categories that burned before", () => {
    for (const q of [
      "Salary expectations?",
      "Are you authorized to work in the US?",
      "Do you now or in the future require sponsorship?",
      "Are you willing to relocate?",
      "What are your preferred pronouns?",
    ]) {
      expect(SENSITIVE_QUESTION_RE.test(q)).toBe(true);
    }
    expect(SENSITIVE_QUESTION_RE.test("How many years with Java?")).toBe(false);
  });
});
