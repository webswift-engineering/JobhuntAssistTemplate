/**
 * Screening-question answering for the Easy Apply assist.
 *
 * Answers ONLY factual-from-profile questions (years of experience with X,
 * skill familiarity yes/no) — grounded in master-profile.json, conservative,
 * never above the profile's total relevant years. Sensitive categories
 * (salary, visa/authorization, relocation, legal, demographics) are NEVER
 * answered here regardless of what the model returns — they stay null so the
 * human answers them in the wizard.
 *
 * Every non-null answer is merged into profile.screeningAnswers by the route,
 * so each question costs at most one LLM call ever; subsequent applications
 * hit the bank via /profile/apply-fields.
 */

import { z } from "zod";
import type { LlmClient } from "./client.js";
import { LlmUnavailableError } from "./client.js";
import type { MasterProfile } from "../profile/masterProfile.js";

/** Questions the machine must never answer, even when the bank/model has a value. */
export const SENSITIVE_QUESTION_RE =
  /salar|compensation|\bpay\b|sponsor|visa|authoriz|citizen|clearance|relocat|notice period|start date|gender|race|ethnic|veteran|disabilit|pronoun/i;

const AnswerSchema = z.object({
  answers: z.array(
    z.object({
      question: z.string(),
      /** Short literal answer (<= 20 chars, LinkedIn's field cap) or null when
       *  the profile doesn't support a grounded answer. */
      answer: z.string().nullable(),
    })
  ),
});

export interface ScreeningAnswerResult {
  /** question -> answer; null = not answerable by the machine (human fills it). */
  answers: Record<string, string | null>;
  method: "llm" | "guarded" | "unavailable";
}

function profileFacts(profile: MasterProfile): string {
  const exp = (profile.experience ?? []).map((e) => ({
    company: e.company,
    title: e.title,
    start: e.start,
    end: e.end,
    tech: [...new Set(e.bullets.flatMap((b) => b.tags ?? []))].slice(0, 20),
    // Bullet text is the strongest grounding for what was actually used per role
    // (tags alone under-report, which produced false "0 years" answers).
    bullets: e.bullets.slice(0, 8).map((b) => b.text.slice(0, 160)),
  }));
  return JSON.stringify({
    relevantYears: profile.relevantYears ?? null,
    skills: profile.skills ?? {},
    experience: exp,
    summary: profile.summary ?? "",
  });
}

export async function answerScreeningQuestions(
  llm: LlmClient,
  profile: MasterProfile,
  questions: string[]
): Promise<ScreeningAnswerResult> {
  const out: Record<string, string | null> = {};
  const askable: string[] = [];
  for (const q of questions) {
    if (SENSITIVE_QUESTION_RE.test(q)) out[q] = null; // guarded — human-only
    else askable.push(q);
  }
  if (askable.length === 0) return { answers: out, method: "guarded" };

  if (!llm.enabled) {
    for (const q of askable) out[q] = null;
    return { answers: out, method: "unavailable" };
  }

  try {
    const result = await llm.completeJson(
      [
        {
          role: "user",
          content: [
            "You answer job-application screening questions for ONE candidate, strictly",
            "grounded in their profile below. Rules:",
            "- Answer ONLY what the profile supports. If it doesn't clearly support an",
            "  answer, return null for that question. NEVER guess or inflate.",
            '- "How many years with X": integer as a string (e.g. "4"). Derive from the',
            "  role date ranges whose bullets/skills actually show X; never exceed",
            "  relevantYears. Check the skills map AND bullet text before concluding a",
            '  technology is absent. NEVER answer "0" — a wrong zero auto-rejects the',
            "  candidate; if you cannot ground a positive number, return null and the",
            "  human will answer.",
            "- Yes/no familiarity questions: \"Yes\" only when the profile shows real use.",
            "- Every answer must be <= 20 characters. Plain values, no explanations.",
            "",
            "CANDIDATE PROFILE:",
            profileFacts(profile),
            "",
            "QUESTIONS (answer every one, in order):",
            JSON.stringify(askable),
            "",
            'Return strict JSON: { "answers": [ { "question": string, "answer": string|null } ] }',
          ].join("\n"),
        },
      ],
      AnswerSchema
    );
    const byQuestion = new Map(result.answers.map((a) => [a.question, a.answer]));
    for (const q of askable) {
      const a = byQuestion.get(q) ?? null;
      // Defense in depth: cap length, drop bare zeros (self-knockout answers),
      // re-apply the sensitive guard on the answer side.
      out[q] =
        a == null || SENSITIVE_QUESTION_RE.test(q) || /^0+$/.test(a.trim())
          ? null
          : a.slice(0, 20);
    }
    return { answers: out, method: "llm" };
  } catch (err) {
    if (!(err instanceof LlmUnavailableError)) {
      console.warn("[answerScreening] LLM failed:", (err as Error).message);
    }
    for (const q of askable) out[q] = null;
    return { answers: out, method: "unavailable" };
  }
}
