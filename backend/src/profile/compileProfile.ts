import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { z } from "zod";
import { config } from "../config.js";
import { getLlm } from "../llm/client.js";
import { MasterProfileSchema, type MasterProfile } from "./masterProfile.js";

/**
 * Compile the work-experience corpus into ADDITIONAL experience bullets and merge
 * them into the curated master-profile.json. Contact, summary, skills, education,
 * projects, and existing experience metadata (company/title/dates) are preserved —
 * only new, deduplicated experience bullets are added.
 *
 * Safety rules enforced via the extraction prompt:
 *  - Internal codenames are translated to generic, industry-standard terms.
 *  - Unverified ("⚠️VERIFY") metrics are dropped or kept qualitative.
 *  - Nothing is invented (employers/dates/tech/metrics).
 */

const CompiledSchema = z.object({
  experience: z.array(
    z.object({
      company: z.string(),
      bullets: z.array(
        z.object({
          text: z.string(),
          tags: z.array(z.string()).default([]),
        })
      ),
    })
  ),
});
type Compiled = z.infer<typeof CompiledSchema>;

/**
 * Optional per-user compile settings, read from `<work-experience>/compile-config.json`
 * (see `work-experience/compile-config.example.json`):
 *  - employers:        canonical employer name -> aliases that appear in the corpus
 *  - codenames:        internal codename -> generic industry term the LLM must use instead
 *  - confirmedMetrics: numbers that are verified and may be stated verbatim
 * Without the file, employers come from master-profile.json and no codename map is applied.
 */
const CompileConfigSchema = z.object({
  employers: z.record(z.string(), z.array(z.string())).default({}),
  codenames: z.record(z.string(), z.string()).default({}),
  confirmedMetrics: z.array(z.string()).default([]),
});
type CompileConfig = z.infer<typeof CompileConfigSchema>;

function loadCompileConfig(): CompileConfig {
  const p = path.join(config.workExperienceDir, "compile-config.json");
  if (!fs.existsSync(p)) return CompileConfigSchema.parse({});
  return CompileConfigSchema.parse(JSON.parse(fs.readFileSync(p, "utf8")));
}

function buildSystemPrompt(cfg: CompileConfig, master: MasterProfile): string {
  const employerLines = master.experience.map((e) => {
    const aliases = cfg.employers[e.company] ?? [];
    return aliases.length ? `'${e.company}' (map ${aliases.join("/")} to this)` : `'${e.company}'`;
  });
  const codenameLines = Object.entries(cfg.codenames).map(([k, v]) => `${k} -> '${v}'`);
  const metricLine = cfg.confirmedMetrics.length
    ? `Confirmed-OK numbers: ${cfg.confirmedMetrics.map((m) => `'${m}'`).join(", ")}.`
    : "If no metric is explicitly confirmed, keep the bullet qualitative.";
  return [
    "You extract resume-ready EXPERIENCE bullets from a candidate's raw work-experience corpus,",
    "for downstream tailoring to job descriptions. Output STRICT JSON only.",
    "",
    "GROUPING: group bullets by employer using these canonical names exactly:",
    employerLines.join(" and ") + ".",
    "",
    "HARD RULES:",
    "- Do NOT invent employers, dates, titles, technologies, or metrics not present in the corpus.",
    "- TRANSLATE all internal codenames to generic industry terms and NEVER output internal codenames,",
    "  ticket ids, or CR ids." + (codenameLines.length ? ` Mappings: ${codenameLines.join("; ")}.` : ""),
    "- METRICS: only state a number if it is explicitly CONFIRMED in the corpus. Anything flagged ⚠️VERIFY",
    "  (latency, %, cost, hours saved, reduction) must be omitted or phrased qualitatively. " + metricLine,
    "- Each bullet: one sentence, impact-first, strong action verb, industry-standard tools only.",
    "- Do NOT lead bullets with 'Fixed' or 'Resolved a critical bug' — frame as reliability, architecture, or outcome.",
    "- Omit obscure internal acronyms unless widely known; describe what the thing is instead.",
    "- Produce up to 12 of the strongest, DEDUPLICATED bullets per employer.",
  ].join("\n");
}

/** Load corpus markdown, prioritizing source kits, skipping git-evidence + READMEs. */
function loadCorpus(): string {
  const root = config.workExperienceDir;
  const files: string[] = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== "git-evidence") walk(full);
      } else if (ent.isFile() && ent.name.endsWith(".md") && ent.name !== "README.md") {
        files.push(full);
      }
    }
  }
  walk(root);

  // Source kits first, then prior-resume notes, then references.
  const rank = (f: string) =>
    /source-kit\.md$/i.test(f) ? 0 : /prior-resume-notes\.md$/i.test(f) ? 1 : 2;
  files.sort((a, b) => rank(a) - rank(b));

  return files
    .map((f) => `--- ${path.relative(root, f)} ---\n${fs.readFileSync(f, "utf8").slice(0, 16000)}`)
    .join("\n\n")
    .slice(0, 90000);
}

function tokens(s: string): Set<string> {
  return new Set(
    (s.toLowerCase().match(/[a-z0-9+#.]{3,}/g) ?? []).filter((w) => w.length >= 3)
  );
}

/** Jaccard similarity over word tokens — used to skip near-duplicate bullets. */
function similar(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function canonicalCompany(name: string, cfg: CompileConfig, master: MasterProfile): string {
  const n = name.trim().toLowerCase();
  for (const [canonical, aliases] of Object.entries(cfg.employers)) {
    if (canonical.toLowerCase() === n || aliases.some((a) => n.includes(a.toLowerCase()))) return canonical;
  }
  const known = master.experience.find(
    (e) => e.company.toLowerCase() === n || n.includes(e.company.toLowerCase())
  );
  return known?.company ?? name.trim();
}

/** Merge compiled bullets into the master (add-only, deduped). Returns count added per company. */
function mergeIntoMaster(
  master: MasterProfile,
  compiled: Compiled,
  cfg: CompileConfig
): Record<string, number> {
  const added: Record<string, number> = {};
  const allIds = new Set(master.experience.flatMap((e) => e.bullets.map((b) => b.id)));

  for (const compExp of compiled.experience) {
    const company = canonicalCompany(compExp.company, cfg, master);
    const exp = master.experience.find(
      (e) => e.company.toLowerCase() === company.toLowerCase()
    );
    if (!exp) continue; // never create new employers from the corpus

    const prefix = exp.bullets[0]?.id.replace(/-[^-]*$/, "") || company.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    let n = 1;
    const nextId = () => {
      let id = `${prefix}-x${n}`;
      while (allIds.has(id)) {
        n++;
        id = `${prefix}-x${n}`;
      }
      allIds.add(id);
      n++;
      return id;
    };

    for (const cb of compExp.bullets) {
      const text = cb.text.trim();
      if (text.length < 20) continue;
      const dup = exp.bullets.some((b) => similar(b.text, text) > 0.5);
      if (dup) continue;
      exp.bullets.push({ id: nextId(), text, tags: cb.tags ?? [] });
      added[company] = (added[company] ?? 0) + 1;
    }
  }
  return added;
}

export async function compileWorkExperienceCorpus(): Promise<{
  path: string;
  added: Record<string, number>;
}> {
  const masterPath = config.masterProfilePath;
  if (!fs.existsSync(masterPath)) {
    throw new Error(`master-profile.json not found at ${masterPath} — create the curated master first`);
  }
  const master = MasterProfileSchema.parse(JSON.parse(fs.readFileSync(masterPath, "utf8")));

  const cfg = loadCompileConfig();
  const corpus = loadCorpus();
  const llm = getLlm();
  if (!llm.enabled) {
    throw new Error("LLM disabled — set DEEPSEEK_API_KEY to compile the work-experience corpus");
  }
  if (corpus.length < 200) {
    throw new Error("work-experience corpus is empty or too small");
  }

  const FORMAT = [
    "",
    "",
    "Return JSON in EXACTLY this shape (no other top-level keys):",
    '{ "experience": [ { "company": "<canonical employer name>", "bullets": [ { "text": "...", "tags": ["aws","lambda"] } ] } ] }',
  ].join("\n");

  const compiled = await llm.completeJson(
    [
      { role: "system", content: buildSystemPrompt(cfg, master) },
      { role: "user", content: corpus + FORMAT },
    ],
    CompiledSchema
  );

  // Back up before mutating the curated master.
  const backup = masterPath.replace(/\.json$/, `.backup-${Date.now()}.json`);
  fs.copyFileSync(masterPath, backup);

  const added = mergeIntoMaster(master, compiled, cfg);
  fs.writeFileSync(masterPath, JSON.stringify(master, null, 2));

  return { path: masterPath, added };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").includes("compileProfile");
if (isMain) {
  compileWorkExperienceCorpus()
    .then(({ path: p, added }) => {
      console.log("Merged corpus into", p);
      for (const [company, n] of Object.entries(added)) {
        console.log(`  + ${n} bullets -> ${company}`);
      }
      if (!Object.keys(added).length) console.log("  (no new bullets added)");
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
