import { z } from "zod";
import type { LlmClient } from "./client.js";
import { LlmUnavailableError } from "./client.js";

/** A candidate (ats, boardToken) pair for a broken company board. Candidates
 *  are only ever PROBED against the public ATS APIs — an LLM guess is never
 *  written to the companies table without a live board answering with jobs. */
export interface BoardCandidate {
  ats: "greenhouse" | "lever" | "ashby";
  boardToken: string;
}

const OutputSchema = z.object({
  candidates: z
    .array(
      z.object({
        ats: z.enum(["greenhouse", "lever", "ashby"]),
        boardToken: z.string().min(1).max(80),
      })
    )
    .max(8),
});

/** Deterministic slug variants — tried even when the LLM is down. */
export function heuristicBoardCandidates(company: string): BoardCandidate[] {
  const joined = company.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const dashed = company
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const bases = [...new Set([joined, dashed])].filter(Boolean);
  const out: BoardCandidate[] = [];
  for (const boardToken of bases) {
    for (const ats of ["greenhouse", "lever", "ashby"] as const) out.push({ ats, boardToken });
  }
  return out;
}

/**
 * DeepSeek proposes where a company's hosted board might live now (companies
 * migrate ATSes — a permanent 404 on Lever often means "moved to Greenhouse").
 * Fail soft: [] when the LLM is unavailable; heuristics still run.
 */
export async function suggestBoardTokens(
  llm: LlmClient,
  input: { company: string; oldAts: string; oldToken: string; error: string | null }
): Promise<BoardCandidate[]> {
  if (!llm.enabled) return [];
  try {
    const out = await llm.completeJson(
      [
        {
          role: "user",
          content: [
            `The hosted job board for "${input.company}" stopped working.`,
            `It was: ats=${input.oldAts}, boardToken=${input.oldToken}. Error: ${input.error ?? "unknown"}.`,
            "Companies migrate ATS vendors. Suggest up to 6 candidate (ats, boardToken) pairs where",
            "this company's PUBLIC hosted board might live now, restricted to these APIs:",
            "  greenhouse → https://boards-api.greenhouse.io/v1/boards/<boardToken>/jobs",
            "  lever      → https://api.lever.co/v0/postings/<boardToken>",
            "  ashby      → https://api.ashbyhq.com/posting-api/job-board/<boardToken>",
            "boardToken is the company slug in those URLs (lowercase, no spaces).",
            "Include plausible slug variants (short name, no punctuation, dashed).",
            'JSON: { "candidates": [{"ats": "greenhouse"|"lever"|"ashby", "boardToken": string}] }',
          ].join("\n"),
        },
      ],
      OutputSchema
    );
    return out.candidates;
  } catch (err) {
    if (!(err instanceof LlmUnavailableError)) {
      console.warn("[suggestBoardTokens] LLM failed:", (err as Error).message);
    }
    return [];
  }
}
