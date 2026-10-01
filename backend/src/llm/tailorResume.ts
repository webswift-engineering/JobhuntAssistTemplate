import { z } from "zod";
import type { LlmClient } from "./client.js";
import { LlmUnavailableError } from "./client.js";

export const ResumeSectionSchema = z.object({
  heading: z.string(),
  items: z.array(z.string()),
});

export const ResumeContactSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  location: z.string().optional(),
  links: z.array(z.string()).optional(),
});

export const ResumeDocEntrySchema = z.object({
  title: z.string(),
  company: z.string(),
  location: z.string().optional(),
  dates: z.string().optional(),
  bullets: z.array(z.string()),
});

export const ResumeDocProjectSchema = z.object({
  name: z.string(),
  context: z.string().optional(),
  stack: z.string().optional(),
  bullets: z.array(z.string()),
});

/**
 * Structured, ATS-clean resume document. Unlike flat `sections`, this keeps each
 * work-history entry intact (title/company/dates/bullets) so renderers can emit a
 * single "EXPERIENCE" section with parseable role headers and consistent dates.
 */
export const ResumeDocSchema = z.object({
  summary: z.string().optional(),
  skills: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  experience: z.array(ResumeDocEntrySchema).optional(),
  education: z
    .array(z.object({ degree: z.string(), school: z.string(), year: z.string().optional() }))
    .optional(),
  projects: z.array(ResumeDocProjectSchema).optional(),
});

export const TailoredResumeSchema = z.object({
  sections: z.array(ResumeSectionSchema),
  contact: ResumeContactSchema.optional(),
  doc: ResumeDocSchema.optional(),
  cover_letter: z.string(),
  keyword_coverage: z.object({
    present: z.array(z.string()),
    missing: z.array(z.string()),
  }),
  changes_summary: z.string(),
  /**
   * How this résumé was tailored: "llm" = a live model call tailored it;
   * "offline" = a deterministic, non-fabricating structural fallback (LLM
   * unavailable/failed). Surfaced so the dashboard can flag un-tailored output.
   */
  tailoredMode: z.enum(["llm", "offline"]).optional(),
  /** Per-JD-requirement coverage report (multi-stage tailoring) — see requirementEvidence.ts. */
  requirement_coverage: z
    .array(
      z.object({
        requirement: z.string(),
        kind: z.enum(["must", "nice"]),
        status: z.enum(["covered", "gap", "unprovable", "soft"]),
        bulletIds: z.array(z.string()),
      })
    )
    .optional(),
});

export type TailoredResume = z.infer<typeof TailoredResumeSchema>;
export type ResumeContact = z.infer<typeof ResumeContactSchema>;
export type ResumeDoc = z.infer<typeof ResumeDocSchema>;
export type ResumeDocEntry = z.infer<typeof ResumeDocEntrySchema>;
export type ResumeDocProject = z.infer<typeof ResumeDocProjectSchema>;

const SYSTEM = [
  "You tailor a resume to a job description. Output STRICT JSON only.",
  "HARD CONSTRAINT — you may ONLY re-emphasize, reorder, or rephrase content that is",
  "ALREADY PRESENT in the master resume. You MUST NOT invent experience, skills,",
  "employers, dates, titles, or metrics. If a JD keyword is not in the master resume,",
  "it goes in keyword_coverage.missing and NOWHERE in sections. Never add it to a bullet.",
  "changes_summary must describe only reordering/rephrasing you did.",
].join(" ");

/**
 * Resume tailor (§8.3). Guardrailed + parser-safe. LLM when available, otherwise a
 * non-fabricating structural fallback (sections straight from the master resume).
 * Always passes the fabrication guard before returning.
 */
export async function tailorResume(
  llm: LlmClient,
  masterResume: string,
  jobDescription: string
): Promise<TailoredResume> {
  if (llm.enabled) {
    try {
      const result = await llm.completeJson(
        [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              "MASTER RESUME (source of truth — do not exceed it):",
              masterResume,
              "",
              "JOB DESCRIPTION:",
              jobDescription.slice(0, 32000),
              "",
              'Return JSON: { "sections":[{"heading":string,"items":[string]}],',
              '"cover_letter":string, "keyword_coverage":{"present":[string],"missing":[string]},',
              '"changes_summary":string }',
            ].join("\n"),
          },
        ],
        TailoredResumeSchema
      );
      // Fabrication guard (§16): missing keywords must never appear in emitted sections.
      // If the LLM tripped it, degrade to the non-fabricating structural fallback rather
      // than hard-failing the whole generation.
      enforceNoFabrication(result);
      return { ...result, tailoredMode: "llm" };
    } catch (err) {
      if (err instanceof FabricationError) {
        console.warn(
          "[tailorResume] LLM output tripped fabrication guard, using structural fallback:",
          err.message
        );
      } else if (!(err instanceof LlmUnavailableError)) {
        console.warn("[tailorResume] LLM failed, using structural fallback:", (err as Error).message);
      }
    }
  }

  // Structural fallback only reflows existing master content, so it can never fabricate.
  const result = structuralFallback(masterResume, jobDescription);
  enforceNoFabrication(result);
  return result;
}

/**
 * Build a structured resume directly from the master resume, with a keyword-coverage
 * report computed against the JD. Cannot fabricate — it only reflows existing text.
 */
export function structuralFallback(masterResume: string, jobDescription: string): TailoredResume {
  const sections = parseMasterIntoSections(masterResume);
  const { present, missing } = keywordCoverage(masterResume, jobDescription);
  return {
    sections,
    cover_letter:
      "Dear Hiring Manager,\n\nI'm excited to apply for this role. My background aligns with your needs as outlined in my resume below. I'd welcome the chance to discuss how I can contribute.\n\nBest regards",
    keyword_coverage: { present, missing },
    changes_summary:
      "No LLM tailoring applied (offline mode): resume reproduced from master with a JD keyword-coverage report. Nothing invented.",
    tailoredMode: "offline",
  };
}

function parseMasterIntoSections(master: string): { heading: string; items: string[] }[] {
  const lines = master.split(/\r?\n/);
  const sections: { heading: string; items: string[] }[] = [];
  let current: { heading: string; items: string[] } | null = null;
  // A heading: short line, no trailing sentence punctuation, optional markdown '#' or trailing ':'.
  const isHeading = (l: string) => /^(#+\s*)?[A-Z][A-Za-z &/]{2,40}:?\s*$/.test(l) && l.length <= 42;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (isHeading(line)) {
      current = { heading: line.replace(/^#+\s*/, "").replace(/:$/, ""), items: [] };
      sections.push(current);
    } else {
      if (!current) {
        current = { heading: "Summary", items: [] };
        sections.push(current);
      }
      current.items.push(line.replace(/^[-*•]\s*/, ""));
    }
  }
  if (sections.length === 0) sections.push({ heading: "Resume", items: [master.trim()] });
  return sections;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "you", "our", "are", "have", "will", "this", "that",
  "your", "from", "work", "team", "role", "job", "able", "must", "all", "who", "we",
  "a", "to", "of", "in", "on", "is", "as", "an", "or", "be", "by", "at", "it",
]);

/**
 * Generic seniority / HR-filler words that are NOT skills or technologies. They are
 * excluded from keyword coverage so the fabrication guard never trips on an LLM
 * legitimately writing e.g. "senior" in a tailored summary. The guard exists to
 * catch invented *skills* (Kafka, Terraform), not common job-posting adjectives.
 */
const GENERIC_TERMS = new Set([
  "senior", "junior", "mid", "midlevel", "lead", "principal", "staff", "entry",
  "level", "intern", "internship", "experienced", "experience", "years", "year",
  "engineer", "engineering", "developer", "development", "software", "candidate",
  "candidates", "applicant", "position", "opportunity", "company", "hiring",
  "preferred", "required", "requirement", "requirements", "responsibilities",
  "qualifications", "strong", "excellent", "passionate", "motivated", "ideal",
  "looking", "seeking", "join", "build", "building", "help", "including",
  // Common job-posting / English filler that is NOT a skill or technology. These
  // frequently appear in a legitimately tailored summary or bullet, so excluding
  // them keeps the fabrication guard from tripping on ordinary prose (and keeps
  // the keyword-coverage report focused on real skills).
  "about", "responsible", "establishing", "implementing", "implement", "revised",
  "systems", "programs", "program", "coordination", "overall", "objective",
  "activities", "activity", "partner", "partners", "teams", "ensure", "ensuring",
  "appropriate", "meet", "meets", "goals", "goal", "identify", "define", "defining",
  "necessary", "enhancements", "products", "product", "improvements", "improve",
  "improving", "resolve", "variety", "high", "impact", "problems", "problem",
  "projects", "project", "complex", "business", "industry", "expertise", "area",
  "areas", "advanced", "knowledge", "solutions", "solution", "support", "supporting",
  "deliver", "delivery", "delivering", "scalable", "maintainable", "modern",
  "across", "within", "various", "related", "new", "provide", "providing", "serve",
  "behavior", "practices", "practice", "communication", "written", "verbal",
  "collaborate", "collaboration", "collaborating", "participate", "contribute",
  "contributing", "stakeholders", "technical", "environment", "environments",
  "best", "quality", "reliable", "reliability", "maintain", "maintaining",
  "work", "working", "ability", "able", "role", "roles", "job", "team", "world",
  "global", "leading", "leader", "leadership", "drive", "driving", "own", "owning",
  "end-to-end", "cross-functional", "fast-paced", "detail-oriented", "self-motivated",
  // Generic engineering activity verbs — things every engineer does. Writing
  // "debugging" or "troubleshooting" in a summary is not claiming a technology.
  "debug", "debugging", "debugged", "troubleshoot", "troubleshooting", "troubleshot",
  "diagnose", "diagnosing", "diagnosed", "investigate", "investigating", "investigation",
  "writing", "reading", "read", "code", "coding", "review", "reviews", "reviewing",
  "testing", "tested", "monitoring", "monitored", "operational", "operations",
  "customer", "customers", "client", "clients", "escalation", "escalations",
]);

/** Compare JD keywords against the master resume. present = in master, missing = not. */
export function keywordCoverage(
  master: string,
  jobDescription: string
): { present: string[]; missing: string[] } {
  const masterLc = master.toLowerCase();
  const candidates = Array.from(
    new Set(
      (jobDescription.toLowerCase().match(/[a-z][a-z0-9+#.\-]{2,}/g) ?? [])
        .map((w) => w.replace(/[.\-+#]+$/, "")) // strip trailing punctuation (e.g. "terraform.")
        .filter((w) => !STOPWORDS.has(w) && !GENERIC_TERMS.has(w) && w.length >= 3)
    )
  );
  const present: string[] = [];
  const missing: string[] = [];
  for (const w of candidates) {
    (masterLc.includes(w) ? present : missing).push(w);
  }
  // Keep the report focused.
  return { present: present.slice(0, 40), missing: missing.slice(0, 40) };
}

export class FabricationError extends Error {
  constructor(keyword: string) {
    super(`Fabrication guard tripped: missing keyword "${keyword}" appears in tailored sections`);
    this.name = "FabricationError";
  }
}

/**
 * Which of `missing` keywords actually appear (as whole words) in `text`. Shared
 * by the fabrication guard and the per-field grounding checks (summary, bullet
 * rewrites, cover letter) so they all use identical matching semantics.
 */
export function fabricatedKeywords(text: string, missing: string[]): string[] {
  const body = text.toLowerCase();
  const hits: string[] = [];
  for (const kw of missing) {
    const term = kw.toLowerCase().trim();
    if (term.length < 3) continue;
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(body)) hits.push(kw);
  }
  return hits;
}

/** A missing keyword appearing in the body means the tailor fabricated it. Reject. */
export function enforceNoFabrication(r: TailoredResume): void {
  const body = r.sections.flatMap((s) => [s.heading, ...s.items]).join("\n");
  const hits = fabricatedKeywords(body, r.keyword_coverage.missing);
  if (hits.length) throw new FabricationError(hits[0]);
}
