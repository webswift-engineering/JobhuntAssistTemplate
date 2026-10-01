/**
 * Adhoc résumé generation from a JD file (docx/txt/md) — uses master-profile.json +
 * tailorFromProfile (LLM bullet selection) + TXT/DOCX/PDF renderers (same as dashboard).
 *
 * Usage:
 *   npx tsx scripts/gen-adhoc-resume.ts --jd "path/to/job.docx" --slug acme-role --company Acme --title "Backend Engineer"
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMasterProfile } from "../src/profile/tailorSource.js";
import { tailorFromProfile } from "../src/profile/tailorFromProfile.js";
import { bulletIndex, type MasterProfile } from "../src/profile/masterProfile.js";
import type { ResumeDoc } from "../src/llm/tailorResume.js";
import { renderResume } from "../src/llm/renderResume.js";
import { renderDocx } from "../src/render/renderDocx.js";
import { renderPdf, closePdfBrowser } from "../src/render/renderPdf.js";
import { getLlm } from "../src/llm/client.js";
import { readDocxText } from "./readDocx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

function readJd(filePath: string): string {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`JD file not found: ${abs}`);
  const ext = path.extname(abs).toLowerCase();
  if (ext === ".docx") return readDocxText(abs);
  return fs.readFileSync(abs, "utf8").trim();
}

function bulletIdsFromDoc(profile: MasterProfile, doc: ResumeDoc | undefined): string[] {
  if (!doc?.experience?.length) return [];
  const index = bulletIndex(profile);
  const ids: string[] = [];
  for (const exp of doc.experience) {
    for (const b of exp.bullets) {
      for (const [id, orig] of index) {
        const bl = b.toLowerCase();
        const ol = orig.toLowerCase();
        if (bl === ol || bl.includes(ol.slice(0, 48)) || ol.includes(bl.slice(0, 48))) {
          if (!ids.includes(id)) ids.push(id);
          break;
        }
      }
    }
  }
  return ids;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const jdPath = args.jd;
  const slug = args.slug ?? "adhoc";
  const company = args.company ?? "";
  const title = args.title ?? "";

  if (!jdPath) {
    console.error(
      "Usage: npx tsx scripts/gen-adhoc-resume.ts --jd <file.docx|txt> [--slug name] [--company Co] [--title Role] [--out filename.pdf]"
    );
    process.exit(1);
  }

  const profile = loadMasterProfile();
  if (!profile) {
    console.error("master-profile.json missing or invalid");
    process.exit(1);
  }

  const jd = readJd(jdPath);
  if (jd.length < 100) {
    console.error("JD text too short — check the input file");
    process.exit(1);
  }

  console.log(`Tailoring for ${company || slug} (${jd.length} chars JD)…`);
  const llm = getLlm();
  const tailored = await tailorFromProfile(llm, profile, jd);
  const bulletIds = bulletIdsFromDoc(profile, tailored.doc);

  const outDir = path.join(__dirname, "..", "data", "resumes", slug);
  fs.mkdirSync(outDir, { recursive: true });

  const txt = renderResume(tailored);
  fs.writeFileSync(path.join(outDir, "resume.txt"), txt, "utf8");
  fs.writeFileSync(path.join(outDir, "cover-letter.txt"), tailored.cover_letter, "utf8");

  const docxBuf = await renderDocx(tailored);
  fs.writeFileSync(path.join(outDir, "resume.docx"), docxBuf);

  const pdfBuf = await renderPdf(tailored);
  fs.writeFileSync(path.join(outDir, "resume.pdf"), pdfBuf);
  await closePdfBrowser();

  const manifest = {
    adhoc: true,
    company,
    title,
    jdSource: path.resolve(jdPath),
    generatedAt: Date.now(),
    keyword_coverage: tailored.keyword_coverage,
    changes_summary: tailored.changes_summary,
    experience_bullet_ids: bulletIds,
    artifacts: ["resume.txt", "resume.docx", "resume.pdf", "cover-letter.txt", "job.json"],
  };
  fs.writeFileSync(path.join(outDir, "job.json"), JSON.stringify(manifest, null, 2), "utf8");

  const downloadsName = args.out ?? `${slug}-adhoc.pdf`;
  const downloadsCopy = path.join(process.env.USERPROFILE ?? "", "Downloads", downloadsName);
  fs.copyFileSync(path.join(outDir, "resume.pdf"), downloadsCopy);

  console.log(`\nWrote ${outDir}/`);
  console.log(`  resume.pdf (${pdfBuf.length} bytes)`);
  console.log(`  resume.docx, resume.txt, cover-letter.txt, job.json`);
  console.log(`Copied PDF → ${downloadsCopy}`);
  console.log(`\nBullet ids: ${bulletIds.join(", ")}`);
  console.log(`Changes: ${tailored.changes_summary}`);
  if (tailored.keyword_coverage.missing.length) {
    console.log(
      `Missing JD keywords (not invented): ${tailored.keyword_coverage.missing.slice(0, 12).join(", ")}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
