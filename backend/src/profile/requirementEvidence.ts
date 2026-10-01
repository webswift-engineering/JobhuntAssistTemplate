import type { MasterProfile } from "./masterProfile.js";
import type { JdRequirements } from "../llm/extractRequirements.js";
import {
  profileProofCorpus,
  skillProven,
  isCompiledVariant,
  isBugFixBullet,
} from "./tailorFromProfile.js";

/**
 * Multi-stage tailoring, stage 2: map each JD requirement to the profile evidence
 * that proves it — deterministically, no LLM call. Only PROVABLE requirements ever
 * reach the selection prompt as things to cover; unprovable must-haves are reported
 * as honest gaps and never claimed. This preserves the anti-fabrication guarantee
 * structurally rather than by prompt discipline alone.
 */
export type RequirementCategory = "tech" | "domain" | "practice" | "soft";

export interface RequirementEvidence {
  requirement: string;
  kind: "must" | "nice";
  /** Extraction category — "soft" requirements get their own coverage status. */
  category?: RequirementCategory;
  /** Appears anywhere in the profile corpus (skills, bullets, tags, projects). */
  provable: boolean;
  /** Experience bullets that prove it, best candidates first. */
  bulletIds: string[];
  /** Already listed in the profile's skills section. */
  inSkillsSection: boolean;
  /** Degree requirement satisfied by the profile's education section. */
  provenByEducation?: boolean;
}

export interface CoverageEntry {
  requirement: string;
  kind: "must" | "nice";
  status: "covered" | "gap" | "unprovable" | "soft";
  bulletIds: string[];
}

function termRegex(term: string): RegExp | null {
  const s = term.trim().toLowerCase();
  if (s.length < 2) return null;
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`);
}

/** Filler tails that hide the real term: "RESTful API development" → "RESTful API". */
const FILLER_SUFFIX =
  /\s+(?:development|experience|skills?|knowledge|proficiency|expertise|background|environments?|methodolog(?:y|ies))\s*$/i;
/**
 * Filler lead-ins that hide the real term: "Exposure to web security" → "web
 * security", "Knowledge of CI" → "CI". Applied repeatedly so stacked fillers
 * ("Strong hands-on experience with X") still reduce to the real term.
 */
const FILLER_PREFIX =
  /^(?:strong|solid|proven|excellent|good|deep|demonstrated|prior|previous|practical|hands[- ]on)\s+|^(?:experience|knowledge|exposure|familiarity|understanding|proficiency|proficient|expertise|background|ability|skills?)\s+(?:with|of|in|to|using|on)\s+|^working\s+(?:with|in|on)\s+/i;
/** List-lead noise inside parentheticals: "(e.g., MySQL, PostgreSQL)". */
const LIST_LEAD = /^(?:e\.?g\.?|i\.?e\.?|such as|including|etc\.?)[\s:,]*/i;
const NOISE_TERM = /^(?:e\.?g\.?|i\.?e\.?|etc\.?|and|or|other|others)$/i;
/**
 * Terms too generic to be probes: prefix stripping can reduce "Ability to
 * integrate" to a lone verb, and compound splitting can leave a bare noun
 * ("workflows") that would false-positive against any bullet.
 */
const GENERIC_TERM =
  /^(?:integrate|integrating|adopt|adopting|use|using|work|working|build|building|develop|developing|write|writing|create|creating|deliver|delivering|learn|learning|apply|applying|manage|managing|support|supporting|tools?|tasks?|pipelines?|workflows?|applications?|systems?|services?|software|code|projects?|technologies|solutions?|experiences?|knowledge|exposure|familiarity|understanding|proficiency|expertise|background|abilit(?:y|ies)|skills?)$/i;

/** Strip stacked filler lead-ins until the term stabilizes. */
function stripFillerPrefix(term: string): string {
  let t = term.trim();
  for (let i = 0; i < 4; i++) {
    const next = t.replace(FILLER_PREFIX, "").trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * Deterministic aliases for umbrella requirements whose canonical evidence goes
 * by other names on a résumé. Aliases are probe hypotheses ONLY — like every
 * probe, they count solely when the term literally appears in the profile
 * corpus, so the table can never fabricate a claim.
 */
const REQUIREMENT_ALIASES: [RegExp, string[]][] = [
  [
    /ci\s*\/?\s*cd|continuous\s+(?:integration|delivery|deployment)|build\s+pipelines?/i,
    ["CI/CD", "CI", "Jenkins", "GitHub Actions", "GitLab CI", "pipeline"],
  ],
  [
    /debug|troubleshoot|problem[\s-]solving|root[\s-]cause/i,
    ["debugging", "debug", "troubleshooting", "troubleshoot", "root cause", "diagnosed"],
  ],
  [
    /web\s+security|application\s+security|appsec|secure\s+coding/i,
    ["OAuth", "OIDC", "TLS", "Spring Security", "vulnerability", "input validation", "OWASP", "web security"],
  ],
  [
    /\bai\b[^,;.]{0,30}\btools?\b|generative\s*ai|gen\s*ai|ai[\s-]assisted|ai\s+coding|llm/i,
    ["GitHub Copilot", "Copilot", "Cursor", "Claude", "ChatGPT", "LLM", "AI"],
  ],
];

/** Alias probes triggered by the requirement's own wording. */
export function aliasProbes(requirement: string): string[] {
  const out: string[] = [];
  for (const [re, probes] of REQUIREMENT_ALIASES) {
    if (re.test(requirement)) out.push(...probes);
  }
  return out;
}

/** Degree level required by a JD line: 1 bachelor's, 2 master's, 3 doctorate. */
export function requiredDegreeLevel(requirement: string): number | null {
  const r = requirement.toLowerCase();
  const gate =
    /\b(?:degree|diploma|bachelor'?s?|b\.?sc?\b|b\.?eng\b|undergraduate|master'?s\b|master\s+of\b|m\.?sc\b|m\.?eng\b|ph\.?d\b|doctorate|doctoral)/;
  if (!gate.test(r)) return null;
  const levels: number[] = [];
  if (/\b(?:bachelor|b\.?sc?\b|b\.?eng\b|undergraduate)/.test(r)) levels.push(1);
  if (/\b(?:master'?s\b|master\s+of\b|m\.?sc\b|m\.?eng\b|graduate\s+degree)/.test(r)) levels.push(2);
  if (/\b(?:ph\.?d\b|doctorate|doctoral)/.test(r)) levels.push(3);
  // Generic "degree in a related field" — any degree qualifies.
  return levels.length ? Math.min(...levels) : 1;
}

/** Highest degree level in the profile's education section (0 = none). */
export function profileDegreeLevel(profile: MasterProfile): number {
  let max = 0;
  for (const ed of profile.education ?? []) {
    const d = ed.degree.toLowerCase();
    if (/ph\.?d|doctor/.test(d)) max = Math.max(max, 3);
    else if (/master|m\.?sc\b|m\.?eng\b|mba\b/.test(d)) max = Math.max(max, 2);
    else if (/bachelor|b\.?sc?\b|b\.?eng\b|degree|diploma/.test(d)) max = Math.max(max, 1);
  }
  return max;
}

/**
 * Deterministic decomposition of a compound JD requirement into candidate probe
 * terms. "Relational databases (e.g., MySQL, PostgreSQL)" → MySQL, PostgreSQL,
 * Relational databases; "Agile or Scrum" → Agile, Scrum. Probes are hypotheses:
 * a requirement only counts as provable when a probe literally appears in the
 * profile corpus, so decomposition can never fabricate a claim.
 */
export function decomposeRequirement(requirement: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const t = raw.replace(LIST_LEAD, "").replace(/^[-–—•]\s*/, "").trim();
    if (t.length >= 2 && !NOISE_TERM.test(t) && !GENERIC_TERM.test(t)) out.add(t);
  };
  // Terms inside parentheses are usually the concrete examples.
  for (const m of requirement.matchAll(/\(([^)]*)\)/g)) {
    for (const part of m[1]!.split(/,|\/|\bor\b|\band\b/i)) add(part);
  }
  // Slash compounds ("CI/CD", "TCP/IP") are atomic terms — keep them whole
  // before the top-level split below cuts them in half.
  for (const m of requirement.matchAll(/(?<![a-z0-9])[a-z0-9]{1,6}\/[a-z0-9]{1,6}(?![a-z0-9])/gi)) {
    add(m[0]);
  }
  // The stem without parentheticals, whole and split on top-level separators.
  const stem = requirement.replace(/\([^)]*\)/g, " ").replace(/\s{2,}/g, " ").trim();
  add(stem);
  for (const part of stem.split(/,|\/| or | and /i)) add(part);
  // Strip filler tails and lead-ins from every candidate collected so far.
  for (const t of [...out]) {
    const tailStripped = t.replace(FILLER_SUFFIX, "").trim();
    if (tailStripped !== t) add(tailStripped);
    const leadStripped = stripFillerPrefix(tailStripped);
    if (leadStripped !== tailStripped) add(leadStripped);
  }
  return [...out];
}

/** Bullets mentioning ANY term, ranked: curated before compiled variants, non-bug-fix first. */
function evidenceBulletsForTerms(profile: MasterProfile, terms: string[]): string[] {
  const best = new Map<string, number>();
  for (const term of terms) {
    const re = termRegex(term);
    if (!re) continue;
    for (const exp of profile.experience) {
      for (const b of exp.bullets) {
        const hay = `${b.text} ${(b.tags ?? []).join(" ")}`.toLowerCase();
        if (!re.test(hay)) continue;
        let rank = 0;
        if (isCompiledVariant(b.id)) rank += 2;
        if (isBugFixBullet(b.text)) rank += 1;
        const prev = best.get(b.id);
        if (prev == null || rank < prev) best.set(b.id, rank);
      }
    }
  }
  return [...best.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

export function mapRequirementsToEvidence(
  profile: MasterProfile,
  reqs: JdRequirements
): RequirementEvidence[] {
  const corpus = profileProofCorpus(profile);
  const explicit = new Set(Object.values(profile.skills ?? {}).flat());
  const explicitLc = new Set([...explicit].map((s) => s.toLowerCase()));

  const entry = (
    requirement: string,
    kind: "must" | "nice",
    category?: RequirementCategory,
    evidenceTerms: string[] = []
  ): RequirementEvidence => {
    // Probe order: the JD's own phrase, deterministic sub-terms, LLM-proposed
    // evidence terms, then built-in aliases. A probe only counts if it literally
    // exists in the profile.
    const probes: string[] = [];
    const seenProbe = new Set<string>();
    for (const p of [
      requirement,
      ...decomposeRequirement(requirement),
      ...evidenceTerms,
      ...aliasProbes(requirement),
    ]) {
      const key = p.trim().toLowerCase();
      if (!key || seenProbe.has(key)) continue;
      seenProbe.add(key);
      probes.push(p);
    }
    const proven = probes.filter((p) => skillProven(p, explicit, corpus));
    // Degree requirements are satisfied by the education section, not bullets.
    const reqLevel = requiredDegreeLevel(requirement);
    const provenByEducation = reqLevel != null && profileDegreeLevel(profile) >= reqLevel;
    return {
      requirement,
      kind,
      category,
      provable: proven.length > 0 || provenByEducation,
      bulletIds: evidenceBulletsForTerms(profile, proven).slice(0, 4),
      inSkillsSection: proven.some((p) => explicitLc.has(p.trim().toLowerCase())),
      provenByEducation,
    };
  };

  const seen = new Set<string>();
  const out: RequirementEvidence[] = [];
  for (const m of reqs.mustHave) {
    const key = m.skill.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry(m.skill, "must", m.kind, m.evidenceTerms ?? []));
  }
  for (const n of reqs.niceToHave) {
    const key = n.skill.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry(n.skill, "nice", undefined, n.evidenceTerms ?? []));
  }
  return out;
}

/**
 * Final coverage report: for each requirement, did the tailored document actually
 * cover it (an evidence bullet made the final cut, or it sits in the skills
 * section)? "gap" = provable but not surfaced; "unprovable" = honest gap the
 * candidate cannot claim; "soft" = interpersonal/self-management requirement a
 * résumé can't keyword-prove — addressed via the cover letter, never reported
 * as a scary can't-claim.
 */
export function computeRequirementCoverage(
  evidence: RequirementEvidence[],
  finalBulletIds: string[]
): CoverageEntry[] {
  const finalSet = new Set(finalBulletIds);
  return evidence.map((e) => {
    const coveringBullets = e.bulletIds.filter((id) => finalSet.has(id));
    const covered =
      e.provable &&
      (coveringBullets.length > 0 || e.inSkillsSection || e.provenByEducation === true);
    if (e.category === "soft") {
      // A soft skill the profile genuinely proves still counts as covered.
      return {
        requirement: e.requirement,
        kind: e.kind,
        status: covered ? "covered" : "soft",
        bulletIds: coveringBullets,
      };
    }
    return {
      requirement: e.requirement,
      kind: e.kind,
      status: !e.provable ? "unprovable" : covered ? "covered" : "gap",
      bulletIds: coveringBullets,
    };
  });
}
