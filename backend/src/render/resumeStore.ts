import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db/client.js";
import { config } from "../config.js";
import type { JobRow } from "../types.js";

export type ArtifactFormat = "txt" | "docx" | "pdf" | "cover_letter" | "manifest";

export interface ResumeArtifactRow {
  id: number;
  job_id: string;
  format: ArtifactFormat;
  path: string;
  bytes: number | null;
  generated_at: number;
}

const now = () => Date.now();

function resumeRoot(): string {
  return process.env.RESUME_DIR ?? config.resumeDir;
}

/** Deterministic folder slug per job. */
export function resumeSlug(job: Pick<JobRow, "id" | "company" | "title">): string {
  const base = slugify(`${job.company ?? "resume"}-${job.title}`).slice(0, 60);
  return `${base}-${job.id.slice(0, 8)}`.toLowerCase();
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Absolute path to the per-job résumé folder. The owner (user 1) keeps the
 * original flat layout; other accounts nest under users/<id>/ inside the same
 * root, so stored artifact paths stay relative to one root for every user.
 */
export function resumeDir(job: Pick<JobRow, "id" | "company" | "title" | "user_id">): string {
  const userId = job.user_id ?? 1;
  const base = userId === 1 ? resumeRoot() : path.join(resumeRoot(), "users", String(userId));
  return path.join(base, resumeSlug(job));
}

function relPath(abs: string): string {
  return path.relative(resumeRoot(), abs).split(path.sep).join("/");
}

function formatFilename(format: ArtifactFormat): string {
  switch (format) {
    case "txt":
      return "resume.txt";
    case "docx":
      return "resume.docx";
    case "pdf":
      return "resume.pdf";
    case "cover_letter":
      return "cover-letter.txt";
    case "manifest":
      return "job.json";
  }
}

export async function writeArtifact(
  db: DB,
  job: JobRow,
  format: ArtifactFormat,
  content: string | Buffer
): Promise<{ path: string; bytes: number; absPath: string }> {
  const dir = resumeDir(job);
  fs.mkdirSync(dir, { recursive: true });
  const filename = formatFilename(format);
  const absPath = path.join(dir, filename);
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  fs.writeFileSync(absPath, buf);
  const rel = relPath(absPath);
  await db.prepare(
    `INSERT INTO resume_artifacts (job_id, user_id, format, path, bytes, generated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(job_id, format) DO UPDATE SET
       path = excluded.path,
       bytes = excluded.bytes,
       generated_at = excluded.generated_at`
  ).run(job.id, job.user_id ?? 1, format, rel, buf.length, now());
  return { path: rel, bytes: buf.length, absPath };
}

export async function listArtifacts(db: DB, jobId: string): Promise<ResumeArtifactRow[]> {
  return (await db
    .prepare("SELECT * FROM resume_artifacts WHERE job_id = ? ORDER BY generated_at DESC")
    .all(jobId)) as ResumeArtifactRow[];
}

export async function readArtifact(db: DB, jobId: string, format: ArtifactFormat): Promise<Buffer | null> {
  const row = (await db
    .prepare("SELECT path FROM resume_artifacts WHERE job_id = ? AND format = ?")
    .get(jobId, format)) as { path: string } | undefined;
  if (!row) return null;
  const abs = path.join(resumeRoot(), row.path);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs);
}

export async function artifactAbsPath(db: DB, jobId: string, format: ArtifactFormat): Promise<string | null> {
  const row = (await db
    .prepare("SELECT path FROM resume_artifacts WHERE job_id = ? AND format = ?")
    .get(jobId, format)) as { path: string } | undefined;
  if (!row) return null;
  return path.join(resumeRoot(), row.path);
}

export interface JobManifest {
  jobId: string;
  title: string;
  company: string | null;
  url: string;
  capturedAt: number | null;
  descriptionSource: string;
  jd: string;
  keyword_coverage: { present: string[]; missing: string[] };
  changes_summary: string;
  /** "llm" = model-tailored; "offline" = deterministic fallback (not tailored). */
  tailoredMode?: "llm" | "offline";
  /** Per-JD-requirement coverage (null for manifests predating multi-stage tailoring). */
  requirement_coverage?:
    | { requirement: string; kind: "must" | "nice"; status: "covered" | "gap" | "unprovable" | "soft"; bulletIds: string[] }[]
    | null;
  generatedAt: number;
  artifacts: { format: string; path: string; bytes: number }[];
}

export async function writeManifest(db: DB, job: JobRow, manifest: JobManifest): Promise<void> {
  await writeArtifact(db, job, "manifest", JSON.stringify(manifest, null, 2));
}

export async function latestGeneratedAt(db: DB, jobId: string): Promise<number | null> {
  const row = (await db
    .prepare("SELECT MAX(generated_at) g FROM resume_artifacts WHERE job_id = ?")
    .get(jobId)) as { g: number | null };
  return row.g ?? null;
}

/** Safe download filename: Company-Title.ext */
export function downloadBasename(job: JobRow, ext: string): string {
  const base = slugify(`${job.company ?? "Resume"}-${job.title}`).slice(0, 80) || "resume";
  return `${base}.${ext}`;
}

/**
 * Copilot "stage to outbox": clear `dir` and write this job's PDF as its ONLY
 * file, so the OS file picker always finds the right résumé at a fixed path.
 * Returns the written filename.
 */
export function stageToOutbox(job: JobRow, pdf: Buffer, dir: string): string {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const filename = downloadBasename(job, "pdf");
  fs.writeFileSync(path.join(dir, filename), pdf);
  return filename;
}
