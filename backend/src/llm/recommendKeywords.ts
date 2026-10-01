import { z } from "zod";
import type { LlmClient } from "./client.js";
import { LlmUnavailableError } from "./client.js";

export const KeywordSuggestionSchema = z.object({
  term: z.string(),
  rationale: z.string().max(200),
});
export type KeywordSuggestion = z.infer<typeof KeywordSuggestionSchema>;

const OutputSchema = z.object({
  suggestions: z.array(KeywordSuggestionSchema),
});

export interface RecommendInput {
  seedKeywords: string[];
  likedTitles: string[]; // relevant / applied
  skippedTitles: string[];
}

/**
 * Keyword recommender (§8.2). Proposes new search terms. Does NOT auto-search.
 * Fail soft: returns [] if it can't suggest anything.
 */
export async function recommendKeywords(
  llm: LlmClient,
  input: RecommendInput
): Promise<KeywordSuggestion[]> {
  if (llm.enabled) {
    try {
      const out = await llm.completeJson(
        [
          {
            role: "user",
            content: [
              "Suggest up to 8 NEW job-search keywords/titles to try next.",
              "Base them on what the candidate liked vs skipped. Don't repeat seeds.",
              'JSON: { "suggestions":[{"term":string,"rationale":string}] }',
              "",
              `Seeds: ${JSON.stringify(input.seedKeywords)}`,
              `Liked titles: ${JSON.stringify(input.likedTitles.slice(0, 40))}`,
              `Skipped titles: ${JSON.stringify(input.skippedTitles.slice(0, 40))}`,
            ].join("\n"),
          },
        ],
        OutputSchema
      );
      return out.suggestions;
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) {
        console.warn("[recommendKeywords] LLM failed:", (err as Error).message);
      }
    }
  }
  return heuristicKeywords(input);
}

/** Offline fallback: surface frequent words from liked titles not already seeds. */
export function heuristicKeywords(input: RecommendInput): KeywordSuggestion[] {
  const seeds = new Set(input.seedKeywords.map((s) => s.toLowerCase()));
  const freq = new Map<string, number>();
  for (const t of input.likedTitles) {
    for (const w of t.toLowerCase().match(/[a-z][a-z0-9+#.\-]{2,}/g) ?? []) {
      if (seeds.has(w)) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([term, n]) => ({
      term,
      rationale: `Appears in ${n} of your liked titles but not in your seeds.`,
    }));
}
