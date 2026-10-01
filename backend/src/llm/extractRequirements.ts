import { z } from "zod";
import type { DB } from "../db/client.js";
import type { LlmClient } from "./client.js";
import { LlmUnavailableError } from "./client.js";
import { TECH_VOCAB, mentionsTech, requiredYears } from "./triageJob.js";
import { jdHash } from "../triageStore.js";

/**
 * Multi-stage tailoring, stage 1: extract the JD's structured requirements once
 * per unique JD (cached by jd_hash) so stage 2 can map them to profile evidence
 * and stage 3 can direct bullet selection to cover them explicitly.
 */

export const JdRequirementsSchema = z.object({
  mustHave: z.array(
    z.object({
      skill: z.string(),
      kind: z.enum(["tech", "domain", "practice", "soft"]),
      /**
       * Short probe terms that would prove this requirement if found in the
       * profile (synonyms, canonical names, concrete examples). They are search
       * hypotheses only — a term counts solely when it literally appears in the
       * candidate's profile corpus, so the LLM cannot fabricate a match.
       */
      evidenceTerms: z.array(z.string()).default([]),
    })
  ),
  /**
   * Nice-to-haves carry the same evidenceTerms probes as must-haves so umbrella
   * phrases ("exposure to web security") can map to their canonical résumé
   * terms. Bare strings (older shape) are accepted and upgraded.
   */
  niceToHave: z.array(
    z
      .union([
        z.string(),
        z.object({ skill: z.string(), evidenceTerms: z.array(z.string()).default([]) }),
      ])
      .transform((v) => (typeof v === "string" ? { skill: v, evidenceTerms: [] as string[] } : v))
  ),
  /** Top responsibilities, near-verbatim (used for context, never copied into the résumé). */
  responsibilities: z.array(z.string()),
  /** ATS keywords worth surfacing when provable. */
  keywords: z.array(z.string()),
  seniority: z.string().nullable(),
  yearsRequired: z.number().nullable(),
});

export type JdRequirements = z.infer<typeof JdRequirementsSchema>;

const MAX_JD = 16000;
const MAX_ITEMS = 12;

function buildPrompt(jd: string): string {
  return [
    "Extract this job description's requirements as structured data.",
    "",
    "  • mustHave: the requirements the JD treats as required — each with kind:",
    '    "tech" (a technology), "domain" (industry/problem space), "practice"',
    '    (a way of working, e.g. CI/CD, on-call, system design), or "soft"',
    "    (interpersonal/self-management, e.g. communication, working independently,",
    "    prioritizing multiple projects). Max 10, most important first. Use the",
    "    JD's own terms.",
    "  • For each mustHave, evidenceTerms: 2–6 short terms that, if present on a",
    "    résumé, would prove the requirement — canonical names, common synonyms,",
    '    and concrete examples. E.g. "RESTful API development" → ["REST", "REST API",',
    '    "RESTful"]; "Relational databases (e.g., MySQL, PostgreSQL)" → ["MySQL",',
    '    "PostgreSQL", "SQL"]; "Agile or Scrum" → ["Agile", "Scrum", "Kanban"].',
    '    These are search probes, NOT claims. Use [] for "soft" items.',
    "  • niceToHave: explicitly optional/preferred items, each with the same",
    '    evidenceTerms probes. E.g. "Exposure to web security" → ["OWASP", "TLS",',
    '    "OAuth", "penetration testing"]. Max 8.',
    "  • responsibilities: the top day-to-day responsibilities, near-verbatim. Max 5.",
    "  • keywords: extra ATS-relevant terms not already listed above. Max 10.",
    "  • seniority: the role's level in the JD's words (null if unstated).",
    "  • yearsRequired: minimum years of experience the JD demands (null if unstated).",
    "",
    'Return strict JSON: { "mustHave":[{"skill","kind","evidenceTerms":[string]}],',
    '"niceToHave":[{"skill","evidenceTerms":[string]}], "responsibilities":[string],',
    '"keywords":[string], "seniority":string|null, "yearsRequired":number|null }',
    "",
    "JOB DESCRIPTION:",
    jd.slice(0, MAX_JD),
  ].join("\n");
}

/** Deterministic fallback: TECH_VOCAB scan + years regex — never blocks generation. */
export function heuristicRequirements(jd: string): JdRequirements {
  const jdLc = jd.toLowerCase();
  const found = TECH_VOCAB.filter((t) => mentionsTech(jdLc, t)).slice(0, MAX_ITEMS);
  return {
    mustHave: found.map((skill) => ({ skill, kind: "tech" as const, evidenceTerms: [] })),
    niceToHave: [],
    responsibilities: [],
    keywords: found,
    seniority: null,
    yearsRequired: requiredYears(jd),
  };
}

/** Pre-parse shape: `.default()`/transform fields may still be in raw form. */
type RawJdRequirements = z.input<typeof JdRequirementsSchema>;

function capLists(reqs: RawJdRequirements): JdRequirements {
  return {
    ...reqs,
    mustHave: reqs.mustHave
      .slice(0, MAX_ITEMS)
      .map((m) => ({ ...m, evidenceTerms: (m.evidenceTerms ?? []).slice(0, 8) })),
    niceToHave: reqs.niceToHave.slice(0, MAX_ITEMS).map((n) =>
      typeof n === "string"
        ? { skill: n, evidenceTerms: [] }
        : { skill: n.skill, evidenceTerms: (n.evidenceTerms ?? []).slice(0, 8) }
    ),
    responsibilities: reqs.responsibilities.slice(0, 5),
    keywords: reqs.keywords.slice(0, MAX_ITEMS),
  };
}

/**
 * Extraction schema/prompt version, baked into the cache key. Bumping it makes
 * previously cached rows unreachable so JDs are re-extracted with the new shape
 * (v2: added evidenceTerms + "soft" kind; v3: evidenceTerms on niceToHave).
 */
const CACHE_VERSION = 3;

export async function getJdRequirements(
  db: DB,
  llm: LlmClient,
  jd: string
): Promise<{ reqs: JdRequirements; method: "llm" | "heuristic"; cached: boolean }> {
  const rawHash = jdHash(jd);
  const hash = rawHash ? `${rawHash}:v${CACHE_VERSION}` : null;

  if (hash) {
    const row = (await db
      .prepare("SELECT extracted, method FROM jd_requirements WHERE jd_hash = ?")
      .get(hash)) as { extracted: string; method: "llm" | "heuristic" } | undefined;
    if (row) {
      try {
        return {
          reqs: JdRequirementsSchema.parse(JSON.parse(row.extracted)),
          method: row.method,
          cached: true,
        };
      } catch {
        /* malformed cache row — re-extract below */
      }
    }
  }

  if (llm.enabled) {
    try {
      const reqs = capLists(
        await llm.completeJson([{ role: "user", content: buildPrompt(jd) }], JdRequirementsSchema)
      );
      // Only LLM extractions are cached: a heuristic result would otherwise stick
      // forever and block the better extraction once the LLM recovers.
      if (hash) {
        await db.prepare(
          `INSERT INTO jd_requirements (jd_hash, extracted, method, created_at)
           VALUES (?, ?, 'llm', ?)
           ON CONFLICT(jd_hash) DO UPDATE SET
             extracted = excluded.extracted, method = excluded.method, created_at = excluded.created_at`
        ).run(hash, JSON.stringify(reqs), Date.now());
      }
      return { reqs, method: "llm", cached: false };
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) {
        console.warn("[extractRequirements] LLM failed, using heuristic:", (err as Error).message);
      }
    }
  }
  return { reqs: heuristicRequirements(jd), method: "heuristic", cached: false };
}
