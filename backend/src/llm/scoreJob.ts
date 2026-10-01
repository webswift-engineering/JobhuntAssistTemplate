import { z } from "zod";
import type { LlmClient } from "./client.js";
import { LlmUnavailableError } from "./client.js";
import type { Preferences } from "../types.js";
import { checkJobRegion, regionPolicyFromPrefs } from "../regionFilter.js";
import { mentions } from "./triageJob.js";

export interface ScoreInput {
  title: string;
  company?: string | null;
  location?: string | null;
  description?: string | null;
}

/** How a score was produced — persisted so the dashboard can flag degraded scoring. */
export type ScoreMethod = "llm" | "heuristic" | "region" | "dealbreaker";

export interface ScoreResult {
  /**
   * Relevance: 0..1 for scored jobs. A special sentinel of REGION_BLOCKED_SCORE (-1)
   * marks jobs rejected purely for being out of the allowed regions — kept distinct
   * from a genuine 0 (in-region but irrelevant) so the queue math stays honest. All
   * queue/notify filters treat "≤ 0" as hidden, so both stay out of the queue.
   */
  score: number;
  reason: string; // <=160 chars
  method: ScoreMethod;
}

/** Sentinel score for out-of-region jobs (distinct from an in-region 0 = irrelevant). */
export const REGION_BLOCKED_SCORE = -1;

/** True if a stored score marks an out-of-region rejection rather than a real 0..1 score. */
export function isRegionBlockedScore(score: number | null | undefined): boolean {
  return typeof score === "number" && score < 0;
}

// NOTE: do NOT cap `reason` length here. Models routinely return longer rationales,
// and rejecting them forces a failed retry + heuristic fallback on every job (slow +
// lower quality). We truncate the reason ourselves after a successful parse.
//
// The component sub-scores (0–100) are optional but requested: forcing the model to
// score each rubric dimension first makes it COMPUTE the final score instead of
// reaching for a round habit number (0.5/0.7/1.0), which is what collapses ranking.
const ScoreSchema = z.object({
  title_fit: z.number().min(0).max(100).optional(),
  skills_fit: z.number().min(0).max(100).optional(),
  domain_fit: z.number().min(0).max(100).optional(),
  score: z.number().min(0).max(1),
  reason: z.string(),
});

export interface ScoreOptions {
  /** Candidate's actual proven skills (from master profile) for grounded scoring. */
  candidateSkills?: string[];
}

/**
 * Relevance scorer (§8.1). Uses the LLM when configured; otherwise falls back to a
 * transparent keyword/title heuristic so the queue still ranks without an API key.
 * Fail soft: never throws — worst case returns a low-confidence heuristic score.
 */
export async function scoreJob(
  llm: LlmClient,
  job: ScoreInput,
  prefs: Preferences,
  opts: ScoreOptions = {}
): Promise<ScoreResult> {
  const region = checkJobRegion(job.location, job.description, regionPolicyFromPrefs(prefs));
  if (!region.allowed) {
    return {
      score: REGION_BLOCKED_SCORE,
      reason: `Out of region: ${region.reason}`.slice(0, 160),
      method: "region",
    };
  }

  // Dealbreaker knockout — mirrors triageJob's; runs before the LLM call so it
  // works identically when the LLM is down and saves a call per knocked-out job.
  // Score 0 (not the -1 region sentinel): dealbreaker rows stay visible/filterable.
  const hayLc = `${job.title} ${job.company ?? ""} ${job.description ?? ""}`.toLowerCase();
  for (const d of prefs.dealbreakers ?? []) {
    const term = d.trim();
    if (term && mentions(hayLc, term.toLowerCase())) {
      return {
        score: 0,
        reason: `Dealbreaker present: ${term}`.slice(0, 160),
        method: "dealbreaker",
      };
    }
  }

  if (llm.enabled) {
    try {
      const result = await llm.completeJson(
        [
          {
            role: "user",
            content: buildPrompt(job, prefs, opts),
          },
        ],
        ScoreSchema
      );
      return { score: result.score, reason: result.reason.slice(0, 160), method: "llm" };
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) {
        console.warn("[scoreJob] LLM failed, using heuristic:", (err as Error).message);
      }
    }
  }
  return heuristicScore(job, prefs);
}

/**
 * Weighted rubric so relevance scores SPREAD OUT and mean something, instead of the
 * model defaulting to round numbers. Three dimensions (title/seniority, skills, domain)
 * are scored 0–100, combined with fixed weights, then normalized to 0..1.
 */
function buildPrompt(job: ScoreInput, prefs: Preferences, opts: ScoreOptions): string {
  const skills = (opts.candidateSkills ?? []).filter(Boolean);
  return [
    "You are ranking software jobs for ONE candidate. Score how well THIS job fits.",
    "",
    "Score three dimensions from 0 to 100, then combine:",
    "  • title_fit (weight 30): does the role title + seniority match the candidate's",
    "    target titles/seniority? Penalize a mismatch (too junior OR too senior, or a",
    "    different discipline e.g. data-science/QA/manager when they want SWE).",
    "  • skills_fit (weight 45): overlap between the JD's required tech and the",
    "    candidate's ACTUAL skills below. Reward must-have overlap; penalize when the",
    "    JD centers on tech the candidate does not have.",
    "  • domain_fit (weight 25): do the day-to-day responsibilities match what the",
    "    candidate does (backend/full-stack/platform/etc.)?",
    "",
    "final score = (title_fit*0.30 + skills_fit*0.45 + domain_fit*0.25) / 100, rounded to 2 decimals.",
    "",
    "CALIBRATION — use the FULL range; do NOT snap to 0.5/0.6/0.7/1.0:",
    "  0.85–1.00 = near-ideal (title, stack, and domain all strongly match)",
    "  0.65–0.84 = strong fit with minor gaps",
    "  0.45–0.64 = plausible stretch (some overlap, notable gaps)",
    "  0.20–0.44 = weak (mostly mismatched)",
    "  0.00–0.19 = irrelevant / wrong discipline",
    "Reserve >0.90 for genuinely excellent matches — most good jobs land 0.6–0.85.",
    "",
    'Return strict JSON: { "title_fit":0-100, "skills_fit":0-100, "domain_fit":0-100,',
    '"score":0..1, "reason": string (<=160 chars, name the top matched skill(s) and the biggest gap) }.',
    "",
    "HARD RULE: candidate only accepts jobs in these countries:",
    JSON.stringify(regionPolicyFromPrefs(prefs).allowedRegions),
    "Onsite and remote within those countries are both fine. Score 0 if clearly outside them.",
    "",
    "CANDIDATE TARGET (titles / seniority / keywords):",
    JSON.stringify({
      titles: prefs.titles ?? [],
      seniority: prefs.seniority ?? "",
      keywords: prefs.keywords ?? [],
    }),
    ...(skills.length
      ? ["", "CANDIDATE ACTUAL SKILLS (ground skills_fit in these):", JSON.stringify(skills)]
      : []),
    "",
    "JOB:",
    `Title: ${job.title}`,
    `Company: ${job.company ?? "unknown"}`,
    `Location: ${job.location ?? "unknown"}`,
    `Description: ${(job.description ?? "").slice(0, 4000)}`,
  ].join("\n");
}

/** Deterministic fallback: overlap of preference keywords/titles with job text. */
export function heuristicScore(job: ScoreInput, prefs: Preferences): ScoreResult {
  const hay = `${job.title} ${job.company ?? ""} ${job.description ?? ""}`.toLowerCase();
  const terms = [
    ...(prefs.titles ?? []),
    ...(prefs.keywords ?? []),
  ]
    .map((t) => t.toLowerCase().trim())
    .filter(Boolean);

  if (terms.length === 0) {
    return { score: 0.5, reason: "No preferences set — neutral default score.", method: "heuristic" };
  }

  const hits = terms.filter((t) => hay.includes(t));
  const titleHits = (prefs.titles ?? []).filter((t) =>
    job.title.toLowerCase().includes(t.toLowerCase())
  );

  let score = hits.length / terms.length;
  if (titleHits.length > 0) score = Math.min(1, score + 0.25); // title match is a strong signal
  score = Math.round(score * 100) / 100;

  const reason =
    hits.length > 0
      ? `Matched ${hits.length}/${terms.length} terms${
          titleHits.length ? " incl. title" : ""
        }: ${hits.slice(0, 4).join(", ")}.`
      : "No preference terms found in posting.";
  return { score, reason: reason.slice(0, 160), method: "heuristic" };
}
