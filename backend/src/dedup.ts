import { createHash } from "node:crypto";
import type { RawJob } from "./types.js";

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function norm(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Dedup key per §12:
 *  1. externalId present  → `${source}:${externalId}`
 *  2. else fuzzy on company|title|location → `fuzzy:${sha1(...)}`
 *
 * The same logic must run in the extension (cardKey) so badges line up with stored rows.
 */
export function dedupKey(job: Pick<RawJob, "source" | "externalId" | "company" | "title" | "location">): string {
  if (job.externalId && String(job.externalId).trim() !== "") {
    return `${job.source}:${String(job.externalId).trim()}`;
  }
  const composite = `${norm(job.company)}|${norm(job.title)}|${norm(job.location)}`;
  return `fuzzy:${sha1(composite)}`;
}

/** Stable job id derived from the dedup key (deterministic, collision-free per key). */
export function jobIdFromDedupKey(key: string): string {
  return sha1(key).slice(0, 16);
}
