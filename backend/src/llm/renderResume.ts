import type { TailoredResume } from "./tailorResume.js";
import {
  toResumeDoc,
  contactHeaderLines,
  roleHeaderLine,
  educationLine,
  projectHeaderLine,
} from "../render/resumeDoc.js";

export class ParserSafetyError extends Error {
  constructor(msg: string) {
    super(`Parser-safety lint failed: ${msg}`);
    this.name = "ParserSafetyError";
  }
}

/**
 * Deterministic, no-LLM render (§8.3). Single column, standard headings, plain text,
 * normalized dates, no tables/text-boxes/images/header-footer. A lint asserts the
 * invariants both legacy ATS keyword parsers and LLM screeners read reliably.
 *
 * When a structured doc is present (profile path) it renders the ATS-clean layout:
 * a contact block in the body, one EXPERIENCE section with parseable role headers,
 * and normalized dates. Otherwise it falls back to flat sections.
 */
export function renderResume(tailored: TailoredResume): string {
  const structured = toResumeDoc(tailored);
  const text = structured
    ? renderStructured(structured.contact, structured.doc)
    : renderSections(tailored);
  lintParserSafe(text);
  return text;
}

function renderSections(tailored: TailoredResume): string {
  const out: string[] = [];
  for (const section of tailored.sections) {
    out.push(section.heading.toUpperCase());
    for (const item of section.items) {
      out.push(`- ${normalizeDates(collapse(item))}`);
    }
    out.push(""); // blank line between sections
  }
  return out.join("\n").trim() + "\n";
}

function renderStructured(
  contact: Parameters<typeof contactHeaderLines>[0],
  doc: NonNullable<ReturnType<typeof toResumeDoc>>["doc"]
): string {
  const out: string[] = [];
  const header = contactHeaderLines(contact);
  if (header.length) {
    out.push(...header, "");
  }
  if (doc.summary) {
    out.push("SUMMARY", normalizeDates(collapse(doc.summary)), "");
  }
  if (doc.skills?.length) {
    out.push("SKILLS");
    for (const s of doc.skills) out.push(`${s.label}: ${s.value}`);
    out.push("");
  }
  if (doc.experience?.length) {
    out.push("EXPERIENCE");
    for (const e of doc.experience) {
      out.push(roleHeaderLine(e));
      for (const b of e.bullets) out.push(`- ${normalizeDates(collapse(b))}`);
      out.push("");
    }
  }
  if (doc.projects?.length) {
    out.push("PROJECTS");
    for (const p of doc.projects) {
      out.push(projectHeaderLine(p));
      if (p.stack) out.push(p.stack);
      for (const b of p.bullets) out.push(`- ${normalizeDates(collapse(b))}`);
      out.push("");
    }
  }
  if (doc.education?.length) {
    out.push("EDUCATION");
    for (const ed of doc.education) out.push(educationLine(ed));
    out.push("");
  }
  return out.join("\n").trim() + "\n";
}

function collapse(s: string): string {
  return s.replace(/\t/g, " ").replace(/[ ]{2,}/g, " ").trim();
}

const MONTHS: Record<string, string> = {
  january: "Jan", february: "Feb", march: "Mar", april: "Apr", may: "May",
  june: "Jun", july: "Jul", august: "Aug", september: "Sep", october: "Oct",
  november: "Nov", december: "Dec",
};

/** Normalize dates: full month names → 3-letter; "2021 - 2022" → "2021–2022". */
export function normalizeDates(s: string): string {
  let out = s.replace(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi,
    (m) => MONTHS[m.toLowerCase()] ?? m
  );
  out = out.replace(/\b(\d{4})\s*[-–—to]+\s*(\d{4}|present|current)\b/gi, "$1–$2");
  return out;
}

/** Reject tables, multi-column, images, header/footer markers. */
export function lintParserSafe(text: string): void {
  if (/\t/.test(text)) throw new ParserSafetyError("contains tab characters (table layout)");
  if (/\|.*\|/.test(text)) throw new ParserSafetyError("contains pipe-delimited table row");
  if (/!\[[^\]]*\]\([^)]*\)/.test(text)) throw new ParserSafetyError("contains an image");
  if (/<img|<table|<div|<span|style=/i.test(text)) throw new ParserSafetyError("contains HTML/markup");
  if (/\S {4,}\S/.test(text)) throw new ParserSafetyError("looks multi-column (wide gap)");
  if (/\f/.test(text)) throw new ParserSafetyError("contains form-feed / page break");
}
