import { describe, it, expect } from "vitest";
import { createTestDb, MockLlm, DisabledLlm } from "./helpers.js";
import { extractJobFromText } from "../src/llm/extractJobFromText.js";
import { recordPageCapture, listCaptures, latestPageCapture } from "../src/captures.js";

const RECRUITER_EMAIL = [
  "Hi Colin,",
  "",
  "I came across your profile and think you'd be a great fit for a role I'm hiring for:",
  "",
  "Senior Java Developer at FinTechCo (Toronto, Hybrid)",
  "We're looking for 5+ years of Java, Spring Boot, Kafka, and AWS.",
  "You'd be building the payments platform used by 2M customers.",
  "Comp is CA$140k-160k + bonus.",
  "Apply here: https://jobs.fintechco.com/senior-java-dev-123",
  "",
  "Best,",
  "Sam the Recruiter",
].join("\n");

describe("extractJobFromText", () => {
  it("uses the LLM extraction when available", async () => {
    const llm = new MockLlm().push({
      title: "Senior Java Developer",
      company: "FinTechCo",
      location: "Toronto, Hybrid",
      salaryText: "CA$140k-160k + bonus",
      description: "5+ years of Java, Spring Boot, Kafka, and AWS. Building the payments platform.",
      applyUrl: "https://jobs.fintechco.com/senior-java-dev-123",
      confidence: 0.9,
    });
    const { extracted, method } = await extractJobFromText(llm, RECRUITER_EMAIL);
    expect(method).toBe("llm");
    expect(extracted.title).toBe("Senior Java Developer");
    expect(extracted.applyUrl).toContain("fintechco.com");
  });

  it("falls back deterministically when the LLM is down (confidence 0)", async () => {
    const { extracted, method } = await extractJobFromText(new DisabledLlm(), RECRUITER_EMAIL);
    expect(method).toBe("fallback");
    expect(extracted.confidence).toBe(0);
    expect(extracted.title).toBe("Hi Colin,");
    expect(extracted.description).toContain("Senior Java Developer");
    expect(extracted.applyUrl).toBe("https://jobs.fintechco.com/senior-java-dev-123");
  });

  it("an LLM error (not just disabled) also falls back instead of throwing", async () => {
    const llm = new MockLlm(5); // force failures
    const { method } = await extractJobFromText(llm, RECRUITER_EMAIL);
    expect(method).toBe("fallback");
  });

  it("extracted job flows through recordPageCapture and feeds resume generation", async () => {
    const db = createTestDb();
    const llm = new MockLlm().push({
      title: "Senior Java Developer",
      company: "FinTechCo",
      location: "Toronto, ON",
      salaryText: null,
      description: "Java, Spring Boot, Kafka, AWS. Payments platform.",
      applyUrl: null,
      confidence: 0.9,
    });
    const { extracted } = await extractJobFromText(llm, RECRUITER_EMAIL);
    const result = await recordPageCapture(db, 1, {
      url: "pasted://abc123",
      source: "manual-paste",
      rawText: extracted.description,
      title: extracted.title!,
      company: extracted.company ?? undefined,
      location: extracted.location ?? undefined,
      captureKind: "right_click",
      meta: { pasted: true },
    });
    expect(result.jobId).toBeTruthy();
    expect(await listCaptures(db, 1)).toHaveLength(1);
    // generate-resume uses the latest capture text as the JD:
    expect((await latestPageCapture(db, 1, result.jobId!))!.raw_text).toContain("Spring Boot");

    // Double-paste re-runs the same extraction → identical fields → same fuzzy
    // dedup key (company|title|location) → same job, refreshed capture row.
    const again = await recordPageCapture(db, 1, {
      url: "pasted://abc123",
      source: "manual-paste",
      rawText: extracted.description,
      title: extracted.title!,
      company: extracted.company ?? undefined,
      location: extracted.location ?? undefined,
      captureKind: "right_click",
    });
    expect(again.jobId).toBe(result.jobId);
    expect(await listCaptures(db, 1)).toHaveLength(1);
  });
});
