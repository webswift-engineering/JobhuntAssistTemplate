import { getLlm } from "../llm/client.js";
import { renderResume } from "../llm/renderResume.js";
import type { DB } from "../db/client.js";
import { getJob } from "../store.js";
import { latestPageCapture } from "../captures.js";
import { getTailorSource } from "../profile/tailorSource.js";
import { tailorForJob } from "../profile/tailorFromProfile.js";
import { getJdRequirements } from "../llm/extractRequirements.js";
import {
  mapRequirementsToEvidence,
  type CoverageEntry,
  type RequirementEvidence,
} from "../profile/requirementEvidence.js";
import {
  resumeDir,
  writeArtifact,
  writeManifest,
  listArtifacts,
  type JobManifest,
} from "./resumeStore.js";
import { renderDocx } from "./renderDocx.js";
import { renderPdf } from "./renderPdf.js";
import type { JobRow } from "../types.js";
import type { LlmClient } from "../llm/client.js";

export class NoMasterResumeError extends Error {
  statusCode = 422;
  constructor() {
    super("no master resume / profile");
    this.name = "NoMasterResumeError";
  }
}

export interface GenerateResumeResult {
  jobId: string;
  dir: string;
  artifacts: { format: string; path: string; bytes: number }[];
  keywordCoverage: { present: string[]; missing: string[] } | null;
  changesSummary: string | null;
  tailoredMode: "llm" | "offline";
  renderError: string | null;
  renderedResume: string | null;
  requirementCoverage: CoverageEntry[] | null;
}

async function jobDescription(db: DB, userId: number, job: JobRow): Promise<{ jd: string; descriptionSource: string }> {
  const captured = (await latestPageCapture(db, userId, job.id))?.raw_text;
  const jd = captured ?? job.description ?? `${job.title} at ${job.company ?? ""}`;
  return { jd, descriptionSource: captured ? "apply_capture" : "listing" };
}

export async function generateResumeForJob(
  db: DB,
  userId: number,
  jobId: string,
  llm?: LlmClient
): Promise<GenerateResumeResult> {
  const job = await getJob(db, userId, jobId);
  if (!job) throw new Error(`job ${jobId} not found`);

  const source = await getTailorSource(db, userId);
  if (!source.masterResumeAdequate) {
    throw new NoMasterResumeError(
      "master resume too short — paste your full resume (Experience + bullets) in Dashboard → Profile, then Re-generate"
    );
  }

  const client = llm ?? getLlm();
  const { jd, descriptionSource } = await jobDescription(db, userId, job);

  // Multi-stage tailoring: (1) extract structured JD requirements (LLM, cached by
  // jd_hash), (2) map them to profile evidence deterministically, (3) run the
  // coverage-directed selection. Fail-soft at every stage — a failure here never
  // blocks generation, it just loses the coverage report.
  let evidence: RequirementEvidence[] | undefined;
  if (source.kind === "profile" && source.profile) {
    try {
      const { reqs } = await getJdRequirements(db, client, jd);
      evidence = mapRequirementsToEvidence(source.profile, reqs);
    } catch (err) {
      console.warn("[generateResume] requirement extraction failed:", (err as Error).message);
    }
  }

  const tailored = await tailorForJob(client, source, jd, { evidence });
  const tailoredMode: "llm" | "offline" = tailored.tailoredMode ?? "offline";

  let rendered: string | null = null;
  let renderError: string | null = null;
  try {
    rendered = renderResume(tailored);
  } catch (err) {
    renderError = (err as Error).message;
  }

  const artifacts: { format: string; path: string; bytes: number }[] = [];
  const dir = resumeDir(job);

  if (rendered) {
    const a = await writeArtifact(db, job, "txt", rendered);
    artifacts.push({ format: "txt", path: a.path, bytes: a.bytes });
  }

  const cl = await writeArtifact(db, job, "cover_letter", tailored.cover_letter);
  artifacts.push({ format: "cover_letter", path: cl.path, bytes: cl.bytes });

  try {
    const docxBuf = await renderDocx(tailored);
    const d = await writeArtifact(db, job, "docx", docxBuf);
    artifacts.push({ format: "docx", path: d.path, bytes: d.bytes });
  } catch (err) {
    renderError = renderError ?? `DOCX: ${(err as Error).message}`;
  }

  try {
    const pdfBuf = await renderPdf(tailored);
    const p = await writeArtifact(db, job, "pdf", pdfBuf);
    artifacts.push({ format: "pdf", path: p.path, bytes: p.bytes });
  } catch (err) {
    renderError = renderError ?? `PDF: ${(err as Error).message}`;
  }

  const generatedAt = Date.now();
  const manifest: JobManifest = {
    jobId: job.id,
    title: job.title,
    company: job.company,
    url: job.url,
    capturedAt: job.first_seen_at,
    descriptionSource,
    jd: jd.slice(0, 50000),
    keyword_coverage: tailored.keyword_coverage,
    changes_summary: tailored.changes_summary,
    tailoredMode,
    requirement_coverage: tailored.requirement_coverage ?? null,
    generatedAt,
    artifacts: [...artifacts],
  };
  await writeManifest(db, job, manifest);

  return {
    jobId: job.id,
    dir,
    artifacts: (await listArtifacts(db, job.id)).map((a) => ({
      format: a.format,
      path: a.path,
      bytes: a.bytes ?? 0,
    })),
    keywordCoverage: tailored.keyword_coverage,
    changesSummary: tailored.changes_summary,
    tailoredMode,
    renderError,
    renderedResume: rendered,
    requirementCoverage: tailored.requirement_coverage ?? null,
  };
}
