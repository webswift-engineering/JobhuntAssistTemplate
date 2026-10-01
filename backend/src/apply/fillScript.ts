import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { ApplyFields } from "../profile/applyFields.js";

/**
 * The phone apply payload: everything the fill script needs, pre-inlined.
 *
 * Nothing here can be fetched at run time — the script executes as page
 * JavaScript on the ATS host, whose `connect-src` blocks this backend (the same
 * CSP that forced the desktop engine to proxy through the extension's
 * background worker). So the profile, the cover letter and the résumé bytes all
 * travel inside the script itself. See docs/phone-apply-design.md.
 */
export interface FillPayload {
  jobId: string | null;
  title: string | null;
  company: string | null;
  fields: ApplyFields;
  coverLetter: string;
  /** Tailored PDF, inlined when small enough to attach programmatically. */
  resumeBase64: string | null;
  /** Download link for the phone's Files app when inlining is off or failed. */
  resumeUrl: string | null;
  /** Dashboard deep link that records the application after the human submits. */
  recordUrl: string | null;
}

/**
 * Inlining the PDF is what makes a one-tap attach possible, but it lands in a
 * URL-encoded string that iOS Shortcuts has to carry through three actions.
 * Tailored one-pagers run 30–80 KB; anything past this cap is a sign the
 * résumé pipeline produced something unusual, and the Files fallback is better
 * than a multi-megabyte shortcut payload.
 */
export const MAX_INLINE_RESUME_BYTES = 256 * 1024;

/** Concatenated in this order; each part is an IIFE that publishes onto window. */
const PARTS = ["applyAdapters.js", "applyCore.js", "assist.js", path.join("mobile", "fillDriver.js")] as const;

const cache = new Map<string, { mtimeMs: number; source: string }>();

function readPart(rel: string): string {
  const abs = path.join(config.extensionDir, rel);
  const { mtimeMs } = fs.statSync(abs);
  const hit = cache.get(abs);
  if (hit && hit.mtimeMs === mtimeMs) return hit.source;
  const source = fs.readFileSync(abs, "utf8");
  cache.set(abs, { mtimeMs, source });
  return source;
}

/**
 * Assemble the self-contained fill script.
 *
 * The result is a *function body*, not a standalone script: the iOS Shortcut
 * runs `new Function("done", <body>)(completion)` so that the driver can hand
 * its summary back to Shortcuts when the fill finishes rather than the instant
 * the script is evaluated. That is also why the trailing `return` is legal.
 */
export function buildFillScript(payload: FillPayload): string {
  return [
    ...PARTS.map(readPart),
    `window.__JH_APPLY_PAYLOAD=${JSON.stringify(payload)};`,
    "return window.JC_APPLY_MOBILE.run(window.__JH_APPLY_PAYLOAD)" +
      '.then(done,function(e){done("apply assist failed: "+(e&&e.message||e))});',
  ].join("\n;\n");
}
