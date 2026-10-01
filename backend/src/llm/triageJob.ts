import { z } from "zod";
import type { LlmClient } from "./client.js";
import { LlmUnavailableError } from "./client.js";
import type { Preferences } from "../types.js";
import { checkJobRegion, regionPolicyFromPrefs } from "../regionFilter.js";
import type { MatchFacts } from "../profile/matchFacts.js";

export type TriageVerdict = "strong" | "maybe" | "weak" | "disqualified";

export interface TriageInput {
  title: string;
  company?: string | null;
  location?: string | null;
  description?: string | null;
}

export interface TriageResult {
  verdict: TriageVerdict;
  score: number; // 0..1 skill-fit
  matchedSkills: string[];
  /** Recognized JD tech the candidate covers — the evidence base of the fit ratio.
   *  Optional: cache entries written before this field exist without it. */
  coveredTech?: string[];
  missingRequired: string[];
  /** Domain/industry must-haves ("wealth distribution") the candidate shows no evidence for.
   *  When set, the score is capped at DOMAIN_GAP_CAP even after LLM arbitration.
   *  Optional: cache entries written before this field exist without it. */
  domainGaps?: string[];
  disqualifiers: string[]; // human-readable knockouts (dim, not necessarily hide)
  reason: string;
}

/**
 * Slack added to a JD's stated years requirement before we treat it as a knockout.
 * Postings routinely over-state; we would rather surface a winnable job than bury it.
 */
const YEARS_SLACK = 2;

/** Bands for the deterministic skill-fit score. The "maybe" gap is where the LLM arbitrates. */
const STRONG_SCORE = 0.6;
const WEAK_SCORE = 0.25;

/** Band a raw 0..1 score into a verdict (shared with stored-score reconstruction). */
export function verdictForScore(score: number): TriageVerdict {
  return score >= STRONG_SCORE ? "strong" : score < WEAK_SCORE ? "weak" : "maybe";
}

/**
 * Below this JD length the requirements are effectively unknown (title-only match),
 * so the score is capped inside the "maybe" band: a job we couldn't read can never
 * rank "strong", get Slack-notified as a top match, or trigger résumé generation.
 */
export const THIN_JD_CHARS = 200;
const THIN_JD_CAP = 0.55;

/**
 * A JD whose "N years of experience in <domain>" must-haves are all absent from
 * the candidate's profile can rank at most here — inside the "maybe" band, below
 * the notify threshold — no matter how well the tool overlap scores.
 */
export const DOMAIN_GAP_CAP = 0.55;

/**
 * Recognized tech terms. Used both to score fit (overlap with candidate skills)
 * and to surface JD stack the candidate does not cover (missingRequired). Multi-word
 * entries must appear before their sub-words are matched as word-boundary phrases.
 */
export const TECH_VOCAB = [
  // languages
  "java", "python", "typescript", "javascript", "golang", "go", "rust", "c++", "c#",
  "ruby", "php", "scala", "kotlin", "swift", "elixir", "clojure", "perl", "bash", "sql",
  "node.js", "node",
  // backend / web
  "spring boot", "spring", "django", "flask", "fastapi", "rails", "express", "nestjs",
  ".net", "hibernate", "graphql", "grpc", "rest",
  // frontend
  "react", "angular", "vue", "svelte", "next.js", "redux",
  // data / streaming
  "kafka", "flink", "spark", "hadoop", "hive", "cassandra", "airflow", "dbt", "snowflake",
  "databricks", "presto", "trino", "parquet", "protocol buffers", "kinesis",
  // analytics / BI (multi-word entries before their sub-words)
  "power bi", "power query", "looker studio", "data studio", "google analytics",
  "google sheets", "tableau", "looker", "bigquery", "ga4", "excel", "dax", "spreadsheets",
  "qlik", "spss",
  // datastores
  "postgresql", "postgres", "mysql", "mongodb", "dynamodb", "redis", "elasticsearch",
  // cloud / infra
  "aws", "gcp", "azure", "kubernetes", "docker", "terraform", "helm", "jenkins", "gitops",
  "lambda", "step functions", "serverless", "microservices",
  // auth / security
  "oauth", "oidc", "saml", "fhir",
];

function lc(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

/** Word-boundary-ish presence check that tolerates tech punctuation (c++, node.js, .net). */
export function mentions(haystackLc: string, termLc: string): boolean {
  if (!termLc) return false;
  const esc = termLc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // \b fails around "+", "#", "."; guard with non-word-ish neighbors instead.
  const re = new RegExp(`(^|[^a-z0-9+#.])${esc}([^a-z0-9+#.]|$)`, "i");
  return re.test(haystackLc);
}

/**
 * Vocab terms that collide with everyday English ("go the extra mile", "spring 2026
 * start date", "excel in a fast-paced environment") or French ("une vue d'ensemble").
 * Each counts only with a qualifier or nearby tech context; a bare mention is ignored.
 */
const AMBIGUOUS_TECH: Record<string, RegExp[]> = {
  go: [
    /\bgolang\b/,
    /\bgo\s*\((?:lang(?:uage)?|programming)?\)/,
    /\bgo\s+(?:programming|language|developer|engineer|services|microservices)\b/,
    /\bgo\b\s*[,/&]\s*(?:java|python|rust|kotlin|ruby|scala|c\+\+|c#|node)(?:[^a-z]|$)/,
    /(?:^|[^a-z])(?:java|python|rust|kotlin|ruby|scala|c\+\+|c#|node(?:\.js)?)\s*[,/&]\s*go\b/,
  ],
  vue: [
    /\bvue\.?js\b/,
    /\bvue\s*[23]\b/,
    /\bvue\b[^.\n]{0,60}\b(?:react|angular|svelte|nuxt|front-?end|javascript|typescript|components?)\b/,
    /\b(?:react|angular|svelte|nuxt)\b[^.\n]{0,60}\bvue\b/,
  ],
  spring: [
    /\bspring\s*(?:boot|framework|mvc|cloud|security|batch|data|webflux|kafka)\b/,
    /\bspring\b[^.\n]{0,60}\bjava\b/,
    /\bjava\b[^.\n]{0,60}\bspring\b/,
  ],
  rest: [
    /\brestful\b/,
    /\brest\s*(?:api|endpoint|service|web|integration|interface)/,
    /\bapis?\b[^.\n]{0,40}\brest\b/,
    /\brest\b[^.\n]{0,40}\bapis?\b/,
  ],
  excel: [
    /\b(?:microsoft|ms|advanced|intermediate)\s+excel\b/,
    /\bexcel\b(?!\s+(?:in|at|as|with(?:in)?|under|academically|professionally))/,
  ],
};

/** `mentions`, but ambiguous terms need their qualifier/context before they count. */
export function mentionsTech(haystackLc: string, termLc: string): boolean {
  const guards = AMBIGUOUS_TECH[termLc];
  if (guards) return guards.some((re) => re.test(haystackLc));
  return mentions(haystackLc, termLc);
}

/**
 * Highest "N+ years" figure that reads as a candidate requirement (min bound of ranges).
 * Skips company-tenure boilerplate like "rely on our 30+ years of domain expertise",
 * which otherwise produces false years-knockouts.
 */
export function requiredYears(text: string): number | null {
  const re = /(\d{1,2})\s*\+?\s*(?:-|–|—|to)?\s*(?:\d{1,2})?\s*\+?\s*(?:years|yrs)\b/gi;
  let max: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isNaN(n) || n <= 0 || n >= 40) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const after = text.slice(m.index, m.index + m[0].length + 70);
    // "our 25 years", "we have 25 years", "company's 30+ years" — tenure, not a requirement.
    if (/\b(?:our|we|we've|we have|company|company's)\s*$/i.test(before)) continue;
    // Must be tied to candidate experience, not warranties/benefits/history.
    if (!/(experience|work|hands[- ]on|development|engineering|coding|programming|relevant|professional|industry)/i.test(`${before} ${after}`)) {
      continue;
    }
    max = max == null ? n : Math.max(max, n);
  }
  return max;
}

/**
 * Phrases that describe a way of working / a whole profession rather than an
 * industry domain — "5+ years of experience in software development" is a years
 * requirement (handled by requiredYears), not a domain must-have.
 */
const GENERIC_DOMAIN_RE = new RegExp(
  [
    // "a related field", "similar role", "equivalent position" — escape hatches, not domains
    /\b(?:related|similar|equivalent|comparable|relevant|other)\b/,
    // engineering deliverables/practices ("building cloud-native services like APIs",
    // "designing distributed systems") — that's stack/practice fit, not an industry
    /\b(?:build(?:ing)?|develop(?:ing)?|design(?:ing)?|writing|shipping|maintain(?:ing)?|operating|services?|applications?|apis?|systems?|software|solutions?|platforms?|infrastructure|pipelines?|microservices|codebases?|tools?|technologies)\b/,
    // profession-generic phrases
    /^(?:a\s+|an\s+|the\s+)?(?:professional\s+)?(?:software|web|mobile|application|backend|back-?end|frontend|front-?end|full[- ]?stack|data|systems?|platform)?\s*(?:software\s+)?(?:development|engineering|programming|coding|analysis|analytics|science)$/,
    /^computer science$/,
    /^(?:information )?technology$/,
    /^(?:professional|work|hands[- ]on|industry|technical)?\s*experience$/,
    /^(?:a\s+)?(?:technical|professional|similar)\s+(?:role|capacity|position|environment|setting)$/,
  ]
    .map((r) => r.source)
    .join("|"),
  "i"
);

const YEARS_SRC = String.raw`\d{1,2}\s*\+?\s*(?:-|–|—|to)?\s*(?:\d{1,2})?\s*\+?\s*(?:years?|yrs?)`;

/** A stated preference ("banking experience preferred / an asset") is not a must-have. */
const PREFERENCE_RE = /\b(?:preferred|nice to have|a plus|an asset|asset|bonus|desirable|not required|would be)\b/i;

/** Qualifier words that carry no domain meaning inside a years phrase. */
const FILLER_WORDS = new Set([
  "a", "an", "the", "of", "in",
  "work", "working", "hands-on", "professional", "relevant", "prior", "previous",
  "demonstrated", "proven", "solid", "strong", "recent", "progressive", "direct",
  "practical", "overall", "total", "combined", "extensive", "significant",
  "industry", "related", "full-time", "minimum",
]);

function cleanDomainPhrase(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9+#& -]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER_WORDS.has(w))
    .join(" ")
    .trim();
}

/**
 * Domain/industry/tool must-haves anchored to an explicit years requirement, in
 * the common JD phrasings:
 *   - "2-4 years of [relevant] experience in <domain list>"
 *   - "3+ years of work experience with Camunda BPM"
 *   - "3+ years of Banking experience"
 *   - "Banking experience (3+ years)"
 * Returns groups: alternatives inside one phrase are OR'd by the JD (one group),
 * while separate years phrases are independent requirements (separate groups).
 * Tech terms and profession-generic phrases are excluded — vocab tech is already
 * handled by the stack-fit ratio and the years knockout — so what remains is
 * either an industry domain ("banking") or a named tool we don't recognize
 * ("camunda bpm"): both are must-haves the coverage ratio cannot see.
 * Phrases followed by preference wording ("preferred", "an asset") are skipped.
 */
export function extractDomainRequirements(text: string): string[][] {
  const groups: string[][] = [];
  const seen = new Set<string>();

  const collect = (tail: string, context: string) => {
    if (PREFERENCE_RE.test(context)) return;
    const group: string[] = [];
    for (const part of tail.split(/,|\/|\bor\b|\band\b/i)) {
      const phrase = cleanDomainPhrase(part);
      if (phrase.length < 3 || phrase.split(" ").length > 6) continue;
      if (GENERIC_DOMAIN_RE.test(phrase)) continue;
      if (TECH_VOCAB.some((t) => mentionsTech(phrase, t))) continue;
      if (!group.includes(phrase)) group.push(phrase);
    }
    if (!group.length) return;
    const key = group.join("|");
    if (seen.has(key)) return;
    seen.add(key);
    groups.push(group.slice(0, 8));
  };

  // "N+ years ... experience in|within|with|using <tail>"
  const inWith = new RegExp(
    `${YEARS_SRC}[^.•\\n;:]{0,60}?experience\\s+(?:in|within|with|using)\\s+([^.•\\n;]+)`,
    "gi"
  );
  // "N+ years of <X> experience" (e.g. "3+ years of Banking experience")
  const ofX = new RegExp(`${YEARS_SRC}\\s+of\\s+([^.•\\n;:]{3,60}?)\\s+experience\\b`, "gi");
  // "<X> experience (N+ years)"
  const parenYears = new RegExp(
    `([A-Za-z][A-Za-z0-9 .+#/&-]{2,60}?)\\s+experience\\s*[(\\[][^)\\]]{0,25}?${YEARS_SRC}`,
    "gi"
  );

  for (const re of [inWith, ofX, parenYears]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && groups.length < 8) {
      // parenYears can capture leading sentence words — keep only the phrase tail.
      const tail = re === parenYears ? m[1]!.split(/\s+/).slice(-4).join(" ") : m[1]!;
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
      collect(tail, `${m[0]} ${after}`);
    }
  }
  return groups;
}

/** Words in a title's "with X" phrase that don't name the tool/domain itself. */
const TITLE_WITH_NOISE = new Set(["experience", "skills", "expertise", "background", "knowledge"]);

/**
 * "Senior Java Backend Developer with Camunda": a tool/domain named in the title
 * is role-central even when the JD prose hedges ("nice to have") — staffing-agency
 * postings gate on it. Returns the named term when the candidate's profile shows
 * no word of it, else null. Only capitalized phrases count, so "engineer with a
 * passion for..." never matches.
 */
export function titleToolGap(title: string, candidateHayLc: string): string | null {
  const m = title.match(/\bwith\s+((?:[A-Z][A-Za-z0-9.+#&-]*\s*){1,3})/);
  if (!m) return null;
  const words = m[1]!
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !TITLE_WITH_NOISE.has(w));
  if (!words.length) return null;
  if (words.some((w) => mentions(candidateHayLc, w))) return null;
  return words.join(" ");
}

/** Languages named in the job title, e.g. "Senior Node.js Engineer" -> ["node.js"]. */
function titleLanguages(titleLc: string): string[] {
  const langs = [
    "java", "python", "typescript", "javascript", "golang", "go", "rust", "c++", "c#",
    "ruby", "php", "scala", "kotlin", "swift", "node.js", "node",
  ];
  return langs.filter((l) => mentionsTech(titleLc, l));
}

/**
 * Deterministic triage: region + years + stack knockouts and a skill-fit score.
 * Never throws; the LLM (when available) only refines the ambiguous "maybe" band.
 */
export function triageDeterministic(job: TriageInput, facts: MatchFacts, prefs: Preferences): TriageResult {
  const titleLc = lc(job.title);
  const jd = job.description ?? "";
  const hayLc = `${titleLc} ${lc(jd)}`;
  const disqualifiers: string[] = [];

  // --- Region knockout ---
  const region = checkJobRegion(job.location, jd, regionPolicyFromPrefs(prefs));
  if (!region.allowed) disqualifiers.push(region.reason);

  // --- Dealbreaker knockout ---
  for (const d of facts.dealbreakers) {
    if (mentions(hayLc, d.toLowerCase())) disqualifiers.push(`Dealbreaker present: ${d}`);
  }

  // --- Years knockout (relevant years, not total: a career-changer's unrelated
  // history must not make senior roles look winnable) ---
  const years = facts.relevantYearsExperience ?? facts.yearsExperience;
  const req = requiredYears(jd);
  if (req != null && req > years + YEARS_SLACK) {
    const label = years !== facts.yearsExperience ? `${years} relevant` : `${years}`;
    disqualifiers.push(`Requires ${req}+ yrs (you have ~${label})`);
  }

  // --- Primary-language / stack knockout ---
  const candidateLangsLc = facts.languages.map((l) => l.toLowerCase());
  const tLangs = titleLanguages(titleLc);
  if (tLangs.length && !tLangs.some((l) => candidateLangsLc.includes(l))) {
    // Normalize "node" -> "node.js" for the human-readable reason.
    const named = tLangs.map((l) => (l === "node" ? "node.js" : l)).join("/");
    disqualifiers.push(`Role centers on ${named} (not in your stack)`);
  }

  // --- Skill fit ---
  const skillSet = new Set(facts.skills.map((s) => s.toLowerCase()));
  const matchedSkills = facts.skills.filter((s) => mentionsTech(hayLc, s.toLowerCase()));
  const jdTech = TECH_VOCAB.filter((t) => mentionsTech(hayLc, t));
  const missingRequired = jdTech.filter((t) => !skillSet.has(t) && !mentions(matchedSkills.join(" ").toLowerCase(), t));
  const covered = jdTech.filter((t) => skillSet.has(t) || mentions(matchedSkills.join(" ").toLowerCase(), t));

  const denom = covered.length + missingRequired.length;
  let score = denom > 0 ? covered.length / denom : matchedSkills.length > 0 ? 0.5 : 0.3;
  // Title alignment is a strong signal.
  if (facts.titles.some((t) => t && titleLc.includes(t.toLowerCase()))) {
    score = Math.min(1, score + 0.15);
  }
  // A ratio built on 1-3 recognized terms is weak evidence — never a perfect score.
  if (denom < 4) score = Math.min(score, 0.75);
  score = Math.round(score * 100) / 100;

  const thinJd = jd.trim().length < THIN_JD_CHARS;
  if (thinJd && score > THIN_JD_CAP) score = THIN_JD_CAP;

  // --- Domain/tool must-haves (years-anchored) ---
  // Tool overlap (sql/excel/power-bi) says nothing about industry fit or about a
  // named tool we don't recognize. Each years phrase is one requirement group:
  // alternatives inside a group are OR'd; separate groups are AND'd — a satisfied
  // "6+ years with Java" must not mask an unmet "3+ years of Banking experience".
  const candidateHayLc = [...facts.skills, ...facts.languages].join(" | ").toLowerCase();
  const unmetGroups = extractDomainRequirements(jd).filter(
    (g) => !g.some((d) => mentions(candidateHayLc, d))
  );
  const domainGaps = unmetGroups.length ? [...new Set(unmetGroups.flat())].slice(0, 3) : [];
  // A tool named in the title ("... with Camunda") that the profile shows nothing
  // for is the same kind of gap, even when the JD prose calls it nice-to-have.
  const titleGap = titleToolGap(job.title ?? "", candidateHayLc);
  if (titleGap && !domainGaps.includes(titleGap)) domainGaps.unshift(titleGap);
  if (domainGaps.length && score > DOMAIN_GAP_CAP) score = DOMAIN_GAP_CAP;

  let verdict: TriageVerdict;
  if (disqualifiers.length) {
    verdict = "disqualified";
    score = 0; // a knockout is a knockout — don't flash a high fit % on a skip chip
  } else if (score >= STRONG_SCORE) verdict = "strong";
  else if (score < WEAK_SCORE) verdict = "weak";
  else verdict = "maybe";

  let reason = buildReason(verdict, disqualifiers, covered, missingRequired);
  if (domainGaps.length && verdict !== "disqualified") {
    reason += `; domain gap: ${domainGaps.slice(0, 2).join(", ")}`;
  }
  if (thinJd && verdict !== "disqualified") reason += "; no JD — unverified";

  return {
    verdict,
    score,
    matchedSkills,
    coveredTech: covered,
    missingRequired: missingRequired.slice(0, 12),
    domainGaps,
    disqualifiers,
    reason: reason.slice(0, 200),
  };
}

function buildReason(
  verdict: TriageVerdict,
  disqualifiers: string[],
  covered: string[],
  missing: string[]
): string {
  if (verdict === "disqualified") return disqualifiers.join("; ");
  const parts: string[] = [];
  if (covered.length) parts.push(`Matches ${covered.slice(0, 5).join(", ")}`);
  if (missing.length) parts.push(`missing ${missing.slice(0, 4).join(", ")}`);
  return parts.join("; ") || "No strong signal from title/company.";
}

const BatchScoreSchema = z.object({
  results: z.array(
    z.object({
      i: z.number(),
      score: z.number().min(0).max(1),
      reason: z.string(),
    })
  ),
});

function factsSummary(facts: MatchFacts): string {
  const total = facts.yearsExperience;
  const relevant = facts.relevantYearsExperience ?? total;
  const yearsLine =
    relevant < total
      ? `Years of experience: ~${relevant} relevant to target roles (${total} total incl. unrelated fields)`
      : `Years of experience: ~${total}`;
  return [
    yearsLine,
    `Languages: ${facts.languages.join(", ") || "n/a"}`,
    `Skills: ${facts.skills.slice(0, 60).join(", ")}`,
    `Target titles: ${facts.titles.join(", ") || "n/a"}`,
  ].join("\n");
}

/**
 * Triage a batch of jobs. Deterministic knockouts run for all; the LLM (when enabled)
 * arbitrates only the ambiguous "maybe" band that has a real JD, in a single batched
 * call to keep API usage low. Fail-soft: LLM errors leave deterministic results intact.
 */
export async function triageJobs(
  llm: LlmClient,
  jobs: TriageInput[],
  facts: MatchFacts,
  prefs: Preferences
): Promise<TriageResult[]> {
  const results = jobs.map((j) => triageDeterministic(j, facts, prefs));

  if (!llm.enabled) return results;

  // A "strong" built on a couple of covered terms (e.g. "Matches sql, rest" in a long
  // JD) is a coverage-ratio artifact, not real evidence — send those to the LLM too.
  const lowEvidenceStrong = (r: TriageResult) =>
    r.verdict === "strong" && (r.coveredTech ?? []).length + r.missingRequired.length < 4;

  const arbitrate = results
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r, i }) =>
        (r.verdict === "maybe" || lowEvidenceStrong(r)) && (jobs[i]!.description ?? "").length > 200
    );
  if (!arbitrate.length) return results;

  const payload = arbitrate.map(({ i }) => ({
    i,
    title: jobs[i]!.title,
    company: jobs[i]!.company ?? "",
    location: jobs[i]!.location ?? "",
    description: (jobs[i]!.description ?? "").slice(0, 3000),
  }));

  try {
    const out = await llm.completeJson(
      [
        {
          role: "system",
          content: [
            "You rate how well each job fits a candidate. Return STRICT JSON.",
            "For each job return { i, score (0..1), reason (<=160 chars) }.",
            "Score reflects skill/seniority fit only — do NOT invent qualifications the candidate lacks.",
            "Base the score on the candidate facts provided; be decisive (avoid clustering at 0.5).",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            "CANDIDATE FACTS:",
            factsSummary(facts),
            "",
            "JOBS (JSON):",
            JSON.stringify(payload),
            "",
            'Return JSON: { "results": [{ "i": number, "score": number, "reason": string }] }',
          ].join("\n"),
        },
      ],
      BatchScoreSchema
    );

    for (const item of out.results) {
      const target = results[item.i];
      if (!target || target.verdict === "disqualified") continue;
      let score = Math.round(item.score * 100) / 100;
      let reason = item.reason.slice(0, 200);
      // The LLM judges skill fit; an unmatched domain must-have stays a hard cap.
      if (target.domainGaps?.length && score > DOMAIN_GAP_CAP) {
        score = DOMAIN_GAP_CAP;
        reason = `${reason}; domain gap: ${target.domainGaps[0]}`.slice(0, 200);
      }
      target.score = score;
      target.reason = reason;
      target.verdict = score >= STRONG_SCORE ? "strong" : score < WEAK_SCORE ? "weak" : "maybe";
    }
  } catch (err) {
    if (!(err instanceof LlmUnavailableError)) {
      console.warn("[triageJobs] LLM arbitration failed, keeping deterministic:", (err as Error).message);
    }
  }

  return results;
}
