import { z } from "zod";
import type { LlmClient } from "./client.js";
import { LlmUnavailableError } from "./client.js";

/**
 * Ad-hoc capture: turn ANY pasted text containing a job — a recruiter email, a
 * LinkedIn message, a Slack post — into structured job fields + a cleaned JD.
 * Fail-soft: with the LLM down, a low-confidence fallback still produces a
 * capture the human can fix up manually.
 */

export const ExtractedJobSchema = z.object({
  title: z.string().nullable(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  salaryText: z.string().nullable(),
  /** Cleaned JD body — recruiter chit-chat / signatures stripped, content kept verbatim. */
  description: z.string(),
  /** Application link if one appears in the text. */
  applyUrl: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export type ExtractedJob = z.infer<typeof ExtractedJobSchema>;

const MAX_INPUT = 50_000;

function buildPrompt(rawText: string): string {
  return [
    "Extract the job posting from this pasted text (it may be a recruiter email,",
    "LinkedIn message, or forum post — possibly with greetings, signatures, or",
    "unrelated chatter around the actual job).",
    "",
    "Rules:",
    "  • description: the job description content itself, with greetings/signatures/",
    "    tracking-links stripped. Keep the ACTUAL requirement and responsibility text",
    "    VERBATIM — do not summarize, do not invent.",
    "  • title/company/location/salaryText: null when genuinely not present.",
    "  • applyUrl: the application/job link if one appears in the text, else null.",
    "  • confidence: 0..1 — how confident you are this text actually contains one",
    "    specific job (0.2 = vague mention, 0.9 = full JD present).",
    "",
    'Return strict JSON: { "title", "company", "location", "salaryText",',
    '"description", "applyUrl", "confidence" }.',
    "",
    "TEXT:",
    rawText.slice(0, MAX_INPUT),
  ].join("\n");
}

/** Deterministic fallback when the LLM is unavailable: first line as title, full text as JD. */
function fallbackExtract(rawText: string): ExtractedJob {
  const firstLine =
    rawText
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && l.length <= 120) ?? null;
  const urlMatch = rawText.match(/https?:\/\/\S{10,}/);
  return {
    title: firstLine,
    company: null,
    location: null,
    salaryText: null,
    description: rawText.slice(0, MAX_INPUT),
    applyUrl: urlMatch ? urlMatch[0].replace(/[).,>\]]+$/, "") : null,
    confidence: 0,
  };
}

export async function extractJobFromText(
  llm: LlmClient,
  rawText: string
): Promise<{ extracted: ExtractedJob; method: "llm" | "fallback" }> {
  if (llm.enabled) {
    try {
      const extracted = await llm.completeJson(
        [{ role: "user", content: buildPrompt(rawText) }],
        ExtractedJobSchema
      );
      return { extracted, method: "llm" };
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) {
        console.warn("[extractJobFromText] LLM failed, using fallback:", (err as Error).message);
      }
    }
  }
  return { extracted: fallbackExtract(rawText), method: "fallback" };
}
