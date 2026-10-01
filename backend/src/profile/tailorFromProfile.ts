import { z } from "zod";
import type { LlmClient } from "../llm/client.js";
import { LlmUnavailableError } from "../llm/client.js";
import {
  tailorResume,
  keywordCoverage,
  enforceNoFabrication,
  fabricatedKeywords,
  FabricationError,
  type TailoredResume,
} from "../llm/tailorResume.js";
import {
  bulletIndex,
  profileToMasterText,
  formatDateRange,
  formatMonthYear,
  type MasterProfile,
  type ProfileBullet,
} from "./masterProfile.js";
import type { ResumeContact, ResumeDoc } from "../llm/tailorResume.js";
import {
  computeRequirementCoverage,
  type RequirementEvidence,
} from "./requirementEvidence.js";

const ProfileSelectionSchema = z.object({
  summary: z.string().optional(),
  skill_groups: z.record(z.array(z.string())).optional(),
  selected_bullet_ids: z.array(z.string()),
  bullet_rewrites: z.record(z.string()).optional(),
  cover_letter: z.string(),
  changes_summary: z.string(),
});

const BulletRewriteSchema = z.object({
  bullet_rewrites: z.record(z.string()),
});

const REWRITE_SYSTEM = [
  "You polish resume experience bullets for a specific job description.",
  "Output STRICT JSON only.",
  "For each bullet id provided, return one grounded rewrite in bullet_rewrites.",
  "Use ONLY facts from the original bullet text — do NOT invent metrics, employers, dates, or technologies.",
  "Where the original bullet already supports it, use the JD's own terminology so the match is explicit.",
  "Keep any confirmed number that is already in the original bullet.",
  "Lead with impact/scope. Do NOT start with 'Fixed'. Omit obscure internal acronyms unless the JD uses them.",
].join("\n");

const SYSTEM = [
  "You are an expert technical resume writer. Tailor ONE candidate's resume to ONE job",
  "description using ONLY facts provable from the provided master profile. Output STRICT JSON.",
  "",
  "OVERARCHING GOAL: maximize specific, provable overlap with THIS job. Fully exploit the",
  "master profile — surface every relevant technology, system, and accomplishment the candidate",
  "can actually prove, INCLUDING ones buried inside an experience bullet rather than the skills list.",
  "Be concrete and specific; avoid generic filler. Never claim anything the profile cannot support.",
  "",
  "selected_bullet_ids: a subset of the provided bullet ids. Pick 8–14 total across roles,",
  "prioritizing the JD's core responsibilities and must-have technologies. Use the EXACT id strings",
  "(e.g. acme-x11, not acme-11). Never select two bullets describing the SAME accomplishment.",
  "If the candidate has a bullet that demonstrates a JD must-have technology, you MUST select it.",
  "Prefer systems built, pipelines shipped, and outcomes delivered; avoid bug-fix-only bullets",
  "unless the JD explicitly emphasizes production reliability or debugging.",
  "",
  "summary: REQUIRED. Write 2–3 sentences SPECIFICALLY for this role — do NOT copy the master",
  "summary verbatim. Lead with the candidate's most JD-relevant strength, name the 2–4 most",
  "important JD technologies the candidate genuinely has, and frame the background for this exact",
  "role and domain. Only state facts provable from the profile.",
  "",
  "skill_groups: choose 5–8 categories and order them MOST-JD-RELEVANT FIRST. Every skill value must",
  "be provable somewhere in the profile — the skills section OR any experience/project bullet.",
  "Actively PROMOTE JD-required skills that appear only inside bullets (e.g. Kafka, Flink, Redis)",
  "into the right category so an ATS can see them. Never include a skill the profile cannot prove.",
  "",
  "bullet_rewrites: for EACH selected id, one polished, impact-first sentence grounded in the original",
  "bullet. Where the original already supports it, use the JD's own terminology. Keep any confirmed",
  "metric from the original. Do NOT start with 'Fixed'. Omit obscure internal acronyms unless the JD",
  "uses them. Do NOT invent metrics, employers, dates, titles, or technologies.",
  "",
  "cover_letter: 120–180 words, specific to the company and role. Mention ONLY technologies and",
  "achievements present in the profile — never claim a skill the candidate lacks.",
  "",
  "Any JD keyword with no support anywhere in the profile must NOT appear in summary, skills,",
  "bullets, or the cover letter.",
].join("\n");

function allBullets(profile: MasterProfile): ProfileBullet[] {
  return profile.experience.flatMap((e) => e.bullets);
}

function resolveBullets(
  profile: MasterProfile,
  ids: string[],
  rewrites: Record<string, string> = {}
): { heading: string; items: string[] }[] {
  const index = bulletIndex(profile);
  const byExp = new Map<string, string[]>();

  for (const id of ids) {
    const text = rewrites[id] ?? index.get(id);
    if (!text) continue;
    for (const exp of profile.experience) {
      if (exp.bullets.some((b) => b.id === id)) {
        const key = `${exp.title} — ${exp.company} (${exp.start}–${exp.end})`;
        const arr = byExp.get(key) ?? [];
        arr.push(text);
        byExp.set(key, arr);
        break;
      }
    }
  }

  const sections: { heading: string; items: string[] }[] = [];
  if (profile.summary) {
    sections.push({ heading: "Summary", items: [profile.summary] });
  }
  if (profile.skills && Object.keys(profile.skills).length) {
    sections.push({
      heading: "Skills",
      items: Object.entries(profile.skills).map(([k, v]) => `${k}: ${v.join(", ")}`),
    });
  }
  for (const [heading, items] of byExp) {
    sections.push({ heading: "Experience", items: [`${heading}`, ...items.map((i) => i)] });
  }
  if (profile.education?.length) {
    sections.push({
      heading: "Education",
      items: profile.education.map((e) => `${e.degree}, ${e.school} (${e.year})`),
    });
  }
  return sections.length
    ? sections
    : [{ heading: "Experience", items: ids.map((id) => rewrites[id] ?? index.get(id)!).filter(Boolean) }];
}

/** Fill the page: aim for at least this many bullets per role (top up if the tailor picked fewer). */
export const TARGET_BULLETS_PER_ROLE = 5;
/** Upper bound per role before the PDF fit loop trims to one page. */
export const MAX_BULLETS_PER_ROLE = 5;
/** Keep résumés to one page: show at most this many projects (most relevant first). */
const MAX_PROJECTS = 2;
/**
 * Projects are page-fillers, not primary content. Only include them when the
 * experience section is thin (fewer than this many total bullets) — otherwise a
 * full experience section already fills the page and projects would push to a 2nd.
 */
const PROJECTS_FILL_THRESHOLD = 7;
/**
 * Containment threshold: fraction of the SHORTER bullet's distinctive words also
 * found in the other. Containment beats Jaccard here because compiled bullets
 * reword the same accomplishment (same-topic pairs score ~0.5–0.6, genuinely
 * distinct bullets stay ~0.2–0.36, even when they share tech vocabulary).
 */
const DUPLICATE_THRESHOLD = 0.5;

const STOP = new Set([
  "and", "the", "for", "with", "that", "into", "via", "across", "all", "from",
  "using", "based", "level", "java", "spring", "boot", "aws", "service", "services",
]);

function bulletTokens(s: string): Set<string> {
  return new Set(
    (s.toLowerCase().match(/[a-z0-9+#.]{3,}/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w))
  );
}

/** Overlap relative to the smaller token set — high when one bullet restates another. */
function containment(a: string, b: string): number {
  const ta = bulletTokens(a);
  const tb = bulletTokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

type BulletEntry = { id: string; text: string };

/**
 * Drop near-duplicate bullets, keeping the first occurrence. The pool mixes
 * hand-curated bullets (listed first, higher quality) with corpus-compiled ones
 * that can restate the same accomplishment; this is the lexical safety net behind
 * the LLM's own "no duplicate accomplishments" instruction.
 */
function dedupeEntries(entries: BulletEntry[]): BulletEntry[] {
  const kept: BulletEntry[] = [];
  for (const e of entries) {
    if (kept.some((k) => containment(k.text, e.text) >= DUPLICATE_THRESHOLD)) continue;
    kept.push(e);
  }
  return kept;
}

/** Corpus-compiled variants (acme-x1, acme-x9) — lower priority for auto top-up. */
export function isCompiledVariant(id: string): boolean {
  return /-x\d+$/.test(id);
}

/** Bug-fix framing reads weak on résumés — deprioritize unless the LLM explicitly selected it. */
export function isBugFixBullet(text: string): boolean {
  return /^(fixed|resolved a critical|fixed a critical)\b/i.test(text.trim());
}

/** Count JD keyword overlap for ranking top-up candidates. */
export function jdOverlapScore(text: string, jdLc: string): number {
  const words = Array.from(
    new Set(
      (text.toLowerCase().match(/[a-z][a-z0-9+#.\-]{2,}/g) ?? [])
        .map((w) => w.replace(/[.\-+#]+$/, ""))
        .filter((w) => w.length >= 3 && !STOP.has(w))
    )
  );
  let score = 0;
  for (const w of words) {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(jdLc)) score++;
  }
  return score;
}

/** Rank a bullet for auto top-up: JD overlap minus penalties for weak framing. */
export function topUpRank(bullet: ProfileBullet, jdLc: string): number {
  let score = jdOverlapScore(bullet.text, jdLc);
  if (isBugFixBullet(bullet.text)) score -= 4;
  if (isCompiledVariant(bullet.id)) score -= 2;
  return score;
}

/**
 * Everything the candidate can prove, lowercased: skills section, every experience
 * bullet + tags, and project text. Used to validate LLM-proposed skills so we can
 * surface JD-relevant technologies that live inside bullets (Kafka, Flink, Redis)
 * — not just the ones already hoisted into the skills section — without fabricating.
 */
export function profileProofCorpus(profile: MasterProfile): string {
  const parts: string[] = [];
  if (profile.summary) parts.push(profile.summary);
  for (const items of Object.values(profile.skills ?? {})) parts.push(items.join(" "));
  for (const exp of profile.experience) {
    parts.push(exp.title, exp.company);
    for (const b of exp.bullets) {
      parts.push(b.text);
      if (b.tags) parts.push(b.tags.join(" "));
    }
  }
  for (const p of profile.projects ?? []) {
    parts.push(p.name, p.stack ?? "", p.bullets.join(" "));
  }
  for (const ed of profile.education ?? []) parts.push(ed.degree, ed.school);
  return parts.join(" \n ").toLowerCase();
}

/** True if `skill` appears as a whole term in the proof corpus (word-boundaried to avoid "Go" ⊂ "goal"). */
export function skillProven(skill: string, explicit: Set<string>, corpusLc: string): boolean {
  if (explicit.has(skill)) return true;
  const s = skill.trim().toLowerCase();
  if (s.length < 2) return false;
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(corpusLc);
}

function resolveSkills(
  profile: MasterProfile,
  skillGroups?: Record<string, string[]>
): { label: string; value: string }[] {
  const explicit = new Set(Object.values(profile.skills ?? {}).flat());
  const corpus = profileProofCorpus(profile);
  if (skillGroups && Object.keys(skillGroups).length) {
    const out: { label: string; value: string }[] = [];
    for (const [label, items] of Object.entries(skillGroups)) {
      // Keep any skill provable anywhere in the profile (skills OR bullets), de-duplicated.
      const seen = new Set<string>();
      const filtered = items.filter((s) => {
        const key = s.trim().toLowerCase();
        if (seen.has(key) || !skillProven(s, explicit, corpus)) return false;
        seen.add(key);
        return true;
      });
      if (filtered.length) out.push({ label, value: filtered.join(", ") });
    }
    if (out.length) return out;
  }
  return profile.skills
    ? Object.entries(profile.skills).map(([label, v]) => ({ label, value: v.join(", ") }))
    : [];
}

/**
 * Keep only grounded rewrites. A rewrite that introduces a JD keyword absent from
 * the entire master profile (i.e. in `missing`) is a fabrication — we drop it so the
 * renderer falls back to the original, still-tailored bullet text instead of shipping
 * an invented claim. This is the per-bullet enforcement behind the global guard.
 */
function sanitizeRewrites(
  profile: MasterProfile,
  selectedIds: string[],
  raw: Record<string, string> | undefined,
  missing: string[]
): Record<string, string> {
  if (!raw) return {};
  const index = bulletIndex(profile);
  const out: Record<string, string> = {};
  for (const id of selectedIds) {
    const rewrite = raw[id]?.trim();
    if (!rewrite || !index.has(id)) continue;
    if (fabricatedKeywords(rewrite, missing).length) continue;
    out[id] = rewrite;
  }
  return out;
}

/**
 * Bullets to show for one role: the tailor's JD-selected bullets first, then
 * topped up from JD-ranked curated candidates only (compiled `-xN` variants are
 * excluded from auto top-up). Project-source bullets and near-duplicates are excluded.
 */
function resolveRoleEntries(
  exp: MasterProfile["experience"][number],
  idSet: Set<string>,
  projectBulletIds: Set<string>,
  jdLc: string
): BulletEntry[] {
  const usable = exp.bullets.filter((b) => !projectBulletIds.has(b.id));
  let entries = dedupeEntries(
    usable.filter((b) => idSet.has(b.id)).map((b) => ({ id: b.id, text: b.text }))
  );
  if (entries.length < TARGET_BULLETS_PER_ROLE) {
    const remaining = usable
      .filter((b) => !idSet.has(b.id) && !isCompiledVariant(b.id))
      .sort((a, b) => topUpRank(b, jdLc) - topUpRank(a, jdLc))
      .map((b) => ({ id: b.id, text: b.text }));
    entries = dedupeEntries([...entries, ...remaining]).slice(0, TARGET_BULLETS_PER_ROLE);
  }
  return entries.slice(0, MAX_BULLETS_PER_ROLE);
}

function roleBullets(
  exp: MasterProfile["experience"][number],
  idSet: Set<string>,
  projectBulletIds: Set<string>,
  jdLc: string,
  rewrites: Record<string, string>
): string[] {
  return resolveRoleEntries(exp, idSet, projectBulletIds, jdLc).map(
    (e) => rewrites[e.id] ?? e.text
  );
}

/** All experience bullet ids that will appear in the tailored doc (selection + curated top-up). */
export function finalExperienceBulletIds(
  profile: MasterProfile,
  selectedIds: string[],
  jdLc: string
): string[] {
  const idSet = new Set(selectedIds);
  const projectBulletIds = new Set(
    (profile.projects ?? []).flatMap((p) => p.sourceBulletIds ?? [])
  );
  return profile.experience.flatMap((exp) =>
    resolveRoleEntries(exp, idSet, projectBulletIds, jdLc).map((e) => e.id)
  );
}

async function polishTopUpRewrites(
  llm: LlmClient,
  profile: MasterProfile,
  selectedIds: string[],
  jdLc: string,
  jobDescription: string,
  existing: Record<string, string>,
  missing: string[]
): Promise<Record<string, string>> {
  const finalIds = finalExperienceBulletIds(profile, selectedIds, jdLc);
  const missingIds = finalIds.filter((id) => !existing[id]?.trim());
  if (!missingIds.length || !llm.enabled) return existing;

  const index = bulletIndex(profile);
  const bulletList = missingIds.map((id) => ({ id, text: index.get(id)! }));

  try {
    const result = await llm.completeJson(
      [
        { role: "system", content: REWRITE_SYSTEM },
        {
          role: "user",
          content: [
            "Rewrite these bullets for the job description below.",
            "Return JSON: { \"bullet_rewrites\": { [id]: string } }",
            "",
            "BULLETS:",
            JSON.stringify(bulletList, null, 2),
            "",
            "JOB DESCRIPTION:",
            jobDescription.slice(0, 16000),
          ].join("\n"),
        },
      ],
      BulletRewriteSchema
    );
    return {
      ...existing,
      ...sanitizeRewrites(profile, missingIds, result.bullet_rewrites, missing),
    };
  } catch (err) {
    if (!(err instanceof LlmUnavailableError)) {
      console.warn("[tailorFromProfile] Top-up rewrite pass failed:", (err as Error).message);
    }
    return existing;
  }
}

type ProfileProject = NonNullable<MasterProfile["projects"]>[number];

/** JD relevance threshold for including a personal/side project (keyword hits). */
const PERSONAL_PROJECT_MIN_OVERLAP = 2;

/**
 * Pick up to MAX_PROJECTS projects, most JD-relevant first. Work projects are
 * always eligible; personal/side projects are included only when they clearly
 * match the JD (e.g. a Node/Express side project for a Node role) so we surface
 * real, relevant evidence instead of hiding it — and never fabricating it.
 */
function selectProjects(projects: ProfileProject[], jdLc: string): ProfileProject[] {
  const scored = projects.map((p) => {
    const personal = (p.context ?? "").toLowerCase().includes("personal");
    const score = jdOverlapScore([p.name, p.stack ?? "", ...p.bullets].join(" "), jdLc);
    return { p, personal, score };
  });
  const work = scored.filter((s) => !s.personal);
  const personal = scored.filter((s) => s.personal && s.score >= PERSONAL_PROJECT_MIN_OVERLAP);
  return [...work, ...personal]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PROJECTS)
    .map((s) => s.p);
}

/**
 * Remove any sentence from the cover letter that claims a JD keyword the profile
 * can't prove. Keeps the rest of the tailored letter rather than discarding it;
 * falls back to a safe grounded template only if scrubbing guts it.
 */
function scrubCoverLetter(coverLetter: string, missing: string[]): string {
  if (!fabricatedKeywords(coverLetter, missing).length) return coverLetter;
  const sentences = coverLetter.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => fabricatedKeywords(s, missing).length === 0);
  const out = kept.join(" ").trim();
  return out.length >= 120 ? out : GROUNDED_COVER_LETTER;
}

const GROUNDED_COVER_LETTER =
  "Dear Hiring Manager,\n\nI'm excited to apply for this role. My background aligns with your needs as outlined in my resume below, and I'd welcome the chance to discuss how I can contribute.\n\nBest regards";

/**
 * Build an ATS-clean structured document from the profile, keeping only the
 * selected bullets. Roles with no selected bullet are dropped so no empty
 * work-history entries reach the parser. Bullets are auto-capped per role to
 * keep the document to one page; dates normalized to "Mon YYYY".
 */
function buildProfileDoc(
  profile: MasterProfile,
  ids: string[],
  opts: {
    summary?: string;
    skillGroups?: Record<string, string[]>;
    jdLc?: string;
    rewrites?: Record<string, string>;
  } = {}
): ResumeDoc {
  const idSet = new Set(ids);
  const jdLc = opts.jdLc ?? "";
  const rewrites = opts.rewrites ?? {};
  // Bullets featured as Projects are excluded from Experience (no duplication).
  const projectBulletIds = new Set(
    (profile.projects ?? []).flatMap((p) => p.sourceBulletIds ?? [])
  );
  const skills = resolveSkills(profile, opts.skillGroups);
  const experience = profile.experience
    .map((exp) => ({
      title: exp.title,
      company: exp.company,
      location: exp.location ?? "",
      dates: formatDateRange(exp.start, exp.end),
      bullets: roleBullets(exp, idSet, projectBulletIds, jdLc, rewrites),
    }))
    .filter((e) => e.bullets.length > 0);
  const education = (profile.education ?? []).map((e) => ({
    degree: e.degree,
    school: e.school,
    year: formatMonthYear(e.year),
  }));
  // Projects only fill space the experience section leaves empty. A full work
  // history already fills the page, so skip projects unless experience is thin.
  const totalExpBullets = experience.reduce((n, e) => n + e.bullets.length, 0);
  const projects =
    totalExpBullets >= PROJECTS_FILL_THRESHOLD
      ? []
      : selectProjects(profile.projects ?? [], jdLc).map((p) => ({
          name: p.name,
          context: p.context,
          stack: p.stack,
          bullets: p.bullets,
        }));
  return {
    summary: opts.summary?.trim() || profile.summary,
    skills,
    experience,
    education,
    projects,
  };
}

function profileContact(profile: MasterProfile): ResumeContact {
  return { ...profile.contact };
}

function structuralProfileFallback(profile: MasterProfile, jobDescription: string): TailoredResume {
  const masterText = profileToMasterText(profile);
  const { present, missing } = keywordCoverage(masterText, jobDescription);
  const bullets = allBullets(profile);
  const jdLc = jobDescription.toLowerCase();
  const selected = bullets
    .filter((b) => !isCompiledVariant(b.id))
    .map((b) => ({ b, score: topUpRank(b, jdLc) }))
    .sort((a, b) => b.score - a.score)
    .filter(({ b, score }) => score > 0 || !isBugFixBullet(b.text))
    .slice(0, 12)
    .map(({ b }) => b);
  const picked = selected.length ? selected : bullets.filter((b) => !isCompiledVariant(b.id)).slice(0, 8);
  const ids = picked.map((b) => b.id);
  const sections = resolveBullets(profile, ids);
  return {
    sections,
    contact: profileContact(profile),
    doc: buildProfileDoc(profile, ids, { jdLc }),
    cover_letter:
      "Dear Hiring Manager,\n\nI'm excited to apply for this role. My background aligns with your needs as outlined in my resume below.\n\nBest regards",
    keyword_coverage: { present, missing },
    changes_summary:
      "Profile-based selection (offline): bullets chosen by JD overlap ranking. Nothing invented.",
    tailoredMode: "offline",
  };
}

type ProfileSelection = z.infer<typeof ProfileSelectionSchema>;

/**
 * Run the LLM selection/tailoring call, retrying once on a transient failure
 * (network, HTTP, malformed JSON) before giving up. This meaningfully reduces
 * silent degradation to the offline structural fallback. Returns null only when
 * the LLM is genuinely unavailable or both attempts fail.
 */
/**
 * Coverage-directed prompt block (stage 3 input): the provable must-haves the
 * selection MUST cover, with the bullet ids that prove each — and the unprovable
 * ones it must never claim. Empty string when no evidence was computed.
 */
function evidenceBlock(evidence: RequirementEvidence[] | undefined): string {
  if (!evidence?.length) return "";
  const soft = evidence.filter((e) => e.kind === "must" && e.category === "soft");
  const hard = evidence.filter((e) => e.kind === "must" && e.category !== "soft");
  const musts = hard.filter((e) => e.provable);
  const unprovable = hard.filter((e) => !e.provable);
  const lines: string[] = [];
  if (musts.length) {
    lines.push(
      "TOP JD REQUIREMENTS the candidate CAN prove. Every one MUST be covered by at",
      "least one selected bullet (the listed ids prove it) or a skills entry:",
      ...musts.map(
        (e) =>
          `  • ${e.requirement}${
            e.bulletIds.length
              ? ` — proving bullets: ${e.bulletIds.join(", ")}`
              : e.provenByEducation
                ? " — via education section"
                : " — via skills section"
          }`
      ),
      ""
    );
  }
  if (unprovable.length) {
    lines.push(
      "JD requirements NOT provable from the profile — NEVER claim these anywhere:",
      ...unprovable.map((e) => `  • ${e.requirement}`),
      ""
    );
  }
  if (soft.length) {
    lines.push(
      "SOFT requirements (interpersonal / self-management). Do NOT add these as",
      "skills entries or invent bullets for them; where the selected accomplishments",
      "honestly demonstrate them, let the cover letter speak to them:",
      ...soft.map((e) => `  • ${e.requirement}`),
      ""
    );
  }
  return lines.join("\n");
}

async function runSelection(
  llm: LlmClient,
  bulletList: { id: string; text: string; tags: string[] }[],
  profile: MasterProfile,
  masterText: string,
  jobDescription: string,
  requirementsBlock = ""
): Promise<ProfileSelection | null> {
  const messages = [
    { role: "system" as const, content: SYSTEM },
    {
      role: "user" as const,
      content: [
        "MASTER PROFILE BULLETS (select from these ids only):",
        JSON.stringify(bulletList, null, 2),
        "",
        "PROFILE SKILLS (starting point — you may also surface JD-relevant skills",
        "proven inside the bullets above, e.g. Kafka/Flink/Redis):",
        JSON.stringify(profile.skills ?? {}, null, 2),
        "",
        ...(requirementsBlock ? [requirementsBlock, ""] : []),
        "FULL PROFILE TEXT:",
        masterText.slice(0, 8000),
        "",
        "JOB DESCRIPTION:",
        jobDescription.slice(0, 32000),
        "",
        'Return JSON: { "selected_bullet_ids":[string], "summary":string,',
        '"skill_groups":{[category]:[skill,...]}, "bullet_rewrites":{[id]:string},',
        '"cover_letter":string, "changes_summary":string }',
      ].join("\n"),
    },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await llm.completeJson(messages, ProfileSelectionSchema);
    } catch (err) {
      if (err instanceof LlmUnavailableError) return null;
      const last = attempt === 1;
      console.warn(
        `[tailorFromProfile] LLM selection failed (attempt ${attempt + 1}/2)${
          last ? ", structural fallback" : ", retrying"
        }:`,
        (err as Error).message
      );
    }
  }
  return null;
}

/**
 * Tailor from structured master profile — LLM selects bullet ids from a closed set,
 * returns JD-tailored summary/skills and grounded bullet rewrites.
 */
export async function tailorFromProfile(
  llm: LlmClient,
  profile: MasterProfile,
  jobDescription: string,
  opts: { evidence?: RequirementEvidence[] } = {}
): Promise<TailoredResume> {
  const bullets = allBullets(profile);
  const bulletList = bullets.map((b) => ({ id: b.id, text: b.text, tags: b.tags ?? [] }));
  const masterText = profileToMasterText(profile);
  const jdLc = jobDescription.toLowerCase();
  const { present, missing } = keywordCoverage(masterText, jobDescription);

  if (!llm.enabled) return structuralProfileFallback(profile, jobDescription);

  const selection = await runSelection(
    llm,
    bulletList,
    profile,
    masterText,
    jobDescription,
    evidenceBlock(opts.evidence)
  );
  if (!selection) return structuralProfileFallback(profile, jobDescription);

  const index = bulletIndex(profile);
  let selectedIds = selection.selected_bullet_ids.filter((id) => {
    if (index.has(id)) return true;
    console.warn(`[tailorFromProfile] Dropping invalid bullet id: ${id}`);
    return false;
  });
  if (!selectedIds.length) {
    console.warn("[tailorFromProfile] No valid bullet ids after filtering — using structural fallback");
    return structuralProfileFallback(profile, jobDescription);
  }

  // Deterministic coverage repair (no extra LLM call): if a provable must-have
  // has no proving bullet in the final document, force-select its best evidence
  // bullet so the requirement is explicitly covered.
  for (const e of opts.evidence ?? []) {
    if (e.kind !== "must" || !e.provable || !e.bulletIds.length) continue;
    if (e.category === "soft") continue; // soft skills never force bullet selection
    const finalIds = new Set(finalExperienceBulletIds(profile, selectedIds, jdLc));
    if (e.bulletIds.some((id) => finalIds.has(id))) continue;
    if (e.inSkillsSection) continue; // covered via the skills section
    selectedIds = [...selectedIds, e.bulletIds[0]!];
  }

  const rewrites = sanitizeRewrites(profile, selectedIds, selection.bullet_rewrites, missing);
  const allRewrites = await polishTopUpRewrites(
    llm,
    profile,
    selectedIds,
    jdLc,
    jobDescription,
    rewrites,
    missing
  );
  // Ground the summary: if the LLM's reframed summary invents a JD keyword the
  // profile can't prove, drop back to the master summary instead of nuking the
  // whole (otherwise well-tailored) resume.
  const summary =
    selection.summary && fabricatedKeywords(selection.summary, missing).length === 0
      ? selection.summary
      : profile.summary;
  const doc = buildProfileDoc(profile, selectedIds, {
    summary,
    skillGroups: selection.skill_groups,
    jdLc,
    rewrites: allRewrites,
  });

  const result: TailoredResume = {
    sections: resolveBullets(profile, selectedIds, allRewrites),
    contact: profileContact(profile),
    doc,
    cover_letter: scrubCoverLetter(selection.cover_letter, missing),
    keyword_coverage: { present, missing },
    changes_summary: selection.changes_summary,
    tailoredMode: "llm",
    requirement_coverage: opts.evidence
      ? computeRequirementCoverage(
          opts.evidence,
          finalExperienceBulletIds(profile, selectedIds, jdLc)
        )
      : undefined,
  };

  // Apply tailored summary/skills to flat sections too (renderers may use either path).
  if (doc.summary) {
    const sum = result.sections.find((s) => s.heading === "Summary");
    if (sum) sum.items = [doc.summary];
    else result.sections.unshift({ heading: "Summary", items: [doc.summary] });
  }
  if (doc.skills?.length) {
    const sk = result.sections.find((s) => s.heading === "Skills");
    const items = doc.skills.map((s) => `${s.label}: ${s.value}`);
    if (sk) sk.items = items;
  }

  // Fabrication guard (§16). If the LLM's free-text summary/rewrites slipped in a
  // missing keyword, degrade to the non-fabricating structural fallback instead of
  // failing the whole generation.
  try {
    enforceNoFabrication(result);
    return result;
  } catch (err) {
    if (err instanceof FabricationError) {
      console.warn(
        "[tailorFromProfile] LLM output tripped fabrication guard, using structural fallback:",
        err.message
      );
      return structuralProfileFallback(profile, jobDescription);
    }
    throw err;
  }
}

/** Route to profile or string tailor based on source kind. */
export async function tailorForJob(
  llm: LlmClient,
  source: { kind: "profile" | "string"; profile: MasterProfile | null; masterText: string },
  jobDescription: string,
  opts: { evidence?: RequirementEvidence[] } = {}
): Promise<TailoredResume> {
  if (source.kind === "profile" && source.profile) {
    return tailorFromProfile(llm, source.profile, jobDescription, opts);
  }
  return tailorResume(llm, source.masterText, jobDescription);
}
