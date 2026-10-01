import type { TailoredResume } from "../llm/tailorResume.js";
import { normalizeDates } from "../llm/renderResume.js";
import {
  toResumeDoc,
  contactHeaderLines,
  roleHeaderLine,
  educationLine,
  type ResumeContact,
  type ResumeDoc,
} from "./resumeDoc.js";

export interface LayoutSection {
  heading: string;
  items: string[];
}

export interface ResumeLayout {
  sections: LayoutSection[];
  accentColor: string;
  fontFamily: string;
  headingSizePt: number;
  bodySizePt: number;
  lineHeight: number;
}

const ACCENT = "#2b579a";
const FONT = "'Segoe UI', Calibri, Arial, sans-serif";

/** Shared layout model for DOCX + PDF — single column, standard section order. */
export function buildLayout(tailored: TailoredResume): ResumeLayout {
  const order = ["summary", "skills", "experience", "education"];
  const sorted = [...tailored.sections].sort((a, b) => {
    const ai = order.findIndex((o) => a.heading.toLowerCase().includes(o));
    const bi = order.findIndex((o) => b.heading.toLowerCase().includes(o));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return {
    sections: sorted.map((s) => ({
      heading: s.heading,
      items: s.items.map((i) => normalizeDates(i)),
    })),
    accentColor: ACCENT,
    fontFamily: FONT,
    headingSizePt: 12,
    bodySizePt: 10.5,
    lineHeight: 1.35,
  };
}

/** HTML template for PDF rendering — mirrors DOCX styling. */
export function layoutHtml(layout: ResumeLayout): string {
  const sections = layout.sections
    .map(
      (s) => `
    <section>
      <h2>${escapeHtml(s.heading.toUpperCase())}</h2>
      <ul>${s.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>
    </section>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  @page { size: Letter; margin: 0.75in; }
  body {
    font-family: ${layout.fontFamily};
    font-size: ${layout.bodySizePt}pt;
    line-height: ${layout.lineHeight};
    color: #1a1a1a;
    max-width: 100%;
  }
  h2 {
    font-size: ${layout.headingSizePt}pt;
    color: ${layout.accentColor};
    border-bottom: 1px solid ${layout.accentColor};
    padding-bottom: 2px;
    margin: 14px 0 6px;
    letter-spacing: 0.04em;
  }
  ul { margin: 0 0 8px 0; padding-left: 18px; }
  li { margin-bottom: 4px; }
</style></head>
<body>${sections}</body></html>`;
}

/**
 * Structured, ATS-clean HTML for PDF rendering. Single column, contact in the
 * body, one EXPERIENCE section with bold (non-bulleted) role headers, and a
 * comma-separated skills list. Falls back to flat-section HTML when no doc.
 */
export function tailoredHtml(tailored: TailoredResume): string {
  const structured = toResumeDoc(tailored);
  if (!structured) return layoutHtml(buildLayout(tailored));
  return docHtml(structured.contact, structured.doc);
}

function docHtml(contact: ResumeContact | undefined, doc: ResumeDoc): string {
  const accent = ACCENT;
  const header = contactHeaderLines(contact);
  const name = header[0] ? `<h1>${escapeHtml(header[0])}</h1>` : "";
  const contactLine = header[1] ? `<p class="contact">${escapeHtml(header[1])}</p>` : "";

  const parts: string[] = [];
  if (doc.summary) {
    parts.push(
      `<section><h2>SUMMARY</h2><p>${escapeHtml(normalizeDates(doc.summary))}</p></section>`
    );
  }
  if (doc.skills?.length) {
    const rows = doc.skills
      .map((s) => `<p class="skill"><strong>${escapeHtml(s.label)}:</strong> ${escapeHtml(s.value)}</p>`)
      .join("");
    parts.push(`<section><h2>SKILLS</h2>${rows}</section>`);
  }
  if (doc.experience?.length) {
    const roles = doc.experience
      .map((e) => {
        const bullets = e.bullets
          .map((b) => `<li>${escapeHtml(normalizeDates(b))}</li>`)
          .join("");
        return `<p class="role">${escapeHtml(roleHeaderLine(e))}</p><ul>${bullets}</ul>`;
      })
      .join("");
    parts.push(`<section><h2>EXPERIENCE</h2>${roles}</section>`);
  }
  if (doc.education?.length) {
    const rows = doc.education.map((ed) => `<p class="edu">${escapeHtml(educationLine(ed))}</p>`).join("");
    parts.push(`<section><h2>EDUCATION</h2>${rows}</section>`);
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  @page { size: Letter; margin: 0.6in 0.75in; }
  body { font-family: ${FONT}; font-size: 10.5pt; line-height: 1.35; color: #1a1a1a; }
  h1 { font-size: 18pt; margin: 0 0 2px; color: #111; }
  p.contact { margin: 0 0 4px; color: #333; font-size: 10pt; }
  h2 {
    font-size: 12pt; color: ${accent};
    border-bottom: 1px solid ${accent};
    padding-bottom: 2px; margin: 14px 0 6px; letter-spacing: 0.04em;
  }
  p { margin: 0 0 4px; }
  p.role { font-weight: 700; margin: 8px 0 2px; }
  p.skill, p.edu { margin: 0 0 3px; }
  ul { margin: 0 0 6px 0; padding-left: 18px; }
  li { margin-bottom: 3px; }
</style></head>
<body>${name}${contactLine}${parts.join("\n")}</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
