import { z } from "zod";
import type { LlmClient } from "./client.js";
import { LlmUnavailableError } from "./client.js";

export const ExtractedReferralSchema = z.object({
  company: z.string().nullable().optional(),
  roles: z.array(z.string()).default([]),
  referrer: z.string().nullable().optional(),
  contact: z.string().nullable().optional(),
  deadline: z.string().nullable().optional(),
});
export type ExtractedReferral = z.infer<typeof ExtractedReferralSchema>;

const OutputSchema = z.object({
  referrals: z.array(ExtractedReferralSchema),
});

const SYSTEM = [
  "Extract referral opportunities from a forum post or message (any language).",
  "Output STRICT JSON only. Extract ONLY what is present — never invent a company,",
  "contact, or role. One post may list multiple companies/roles → emit multiple referrals.",
  'Format: { "referrals": [ { "company": string|null, "roles": [string],',
  '"referrer": string|null, "contact": string|null, "deadline": string|null } ] }',
].join(" ");

/**
 * Referral extractor (§8.4). LLM when available; otherwise a regex fallback that at
 * least pulls a contact and stores the raw text. Fail soft: ALWAYS returns at least
 * one referral so the lead is never lost (the human can read raw_text).
 */
export async function extractReferral(
  llm: LlmClient,
  rawText: string
): Promise<ExtractedReferral[]> {
  if (llm.enabled) {
    try {
      const out = await llm.completeJson(
        [
          { role: "system", content: SYSTEM },
          { role: "user", content: rawText.slice(0, 6000) },
        ],
        OutputSchema
      );
      const referrals = out.referrals.length > 0 ? out.referrals : [emptyReferral()];
      return referrals.map((r) => ({ ...r, roles: r.roles ?? [] }));
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) {
        console.warn("[extractReferral] LLM failed, using regex fallback:", (err as Error).message);
      }
    }
  }
  return [regexFallback(rawText)];
}

function emptyReferral(): ExtractedReferral {
  return { company: null, roles: [], referrer: null, contact: null, deadline: null };
}

/** Pull an email / wechat-ish handle from raw text. No fabrication. */
export function regexFallback(rawText: string): ExtractedReferral {
  const email = rawText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? null;
  const wechat = rawText.match(/(?:wechat|微信|vx|v信)[:：\s]*([A-Za-z0-9_-]{4,})/i)?.[1] ?? null;
  return {
    company: null,
    roles: [],
    referrer: null,
    contact: email ?? wechat ?? null,
    deadline: null,
  };
}
