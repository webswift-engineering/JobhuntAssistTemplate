import { normalizeDates } from "../llm/renderResume.js";
import { contactItems, type ResumeContact, type ResumeDoc } from "./resumeDoc.js";

const ACCENT = "#1f3a5f";
const FONT = "Calibri, 'Segoe UI', Arial, sans-serif";

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Single-column, ATS-safe, single-page HTML for the PDF. Strict parsers
 * (Workday, Taleo, iCIMS) read the text stream linearly, so the layout avoids
 * columns, floats, tables, and icons, keeps contact details in the body, and
 * orders sections the way ATS field-mappers expect: contact → summary →
 * skills → experience → projects → education, under standard headings.
 */
export function onePageHtml(contact: ResumeContact | undefined, doc: ResumeDoc): string {
  const items = contactItems(contact);
  const name = contact?.name ? `<div class="name">${esc(contact.name)}</div>` : "";
  const contactLine = items.length
    ? `<div class="contact">${items
        .map((i) => `<span class="item"><span class="k">${esc(i.k)}:</span> ${esc(i.v)}</span>`)
        .join("")}</div>`
    : "";

  const summarySection = doc.summary
    ? `<h2>Summary</h2><div class="summary">${esc(normalizeDates(doc.summary))}</div>`
    : "";

  const skillsHtml = (doc.skills ?? [])
    .map(
      (s) => `<div class="skill"><span class="k">${esc(s.label)}:</span> ${esc(s.value)}</div>`
    )
    .join("");
  const skillsSection = skillsHtml ? `<h2>Skills</h2>${skillsHtml}` : "";

  const expHtml = (doc.experience ?? [])
    .map((e) => {
      const meta = [e.dates, e.location].filter((x) => x && x.trim()).join(" \u00b7 ");
      const lis = e.bullets.map((b) => `<li>${esc(normalizeDates(b))}</li>`).join("");
      return `
      <div class="job">
        <div class="job-head"><span class="job-co">${esc(e.company)}</span><span class="job-meta">${esc(meta)}</span></div>
        <div class="job-role">${esc(e.title)}</div>
        <ul>${lis}</ul>
      </div>`;
    })
    .join("");
  const experienceSection = expHtml ? `<h2>Experience</h2>${expHtml}` : "";

  const projHtml = (doc.projects ?? [])
    .map((p) => {
      const ctx = p.context ? `<span class="job-meta">${esc(p.context)}</span>` : "";
      const head = ctx
        ? `<div class="job-head"><span class="job-co">${esc(p.name)}</span>${ctx}</div>`
        : `<div class="job-co">${esc(p.name)}</div>`;
      const stack = p.stack ? `<div class="job-role">${esc(p.stack)}</div>` : "";
      const lis = (p.bullets ?? []).map((b) => `<li>${esc(normalizeDates(b))}</li>`).join("");
      return `<div class="job">${head}${stack}<ul>${lis}</ul></div>`;
    })
    .join("");
  const projectsSection = projHtml ? `<h2>Projects</h2>${projHtml}` : "";

  const eduHtml = (doc.education ?? [])
    .map((e) => {
      const yr = e.year && e.year.trim() ? `<span class="job-meta">${esc(e.year)}</span>` : "";
      return `
      <div class="edu">
        <div class="job-head"><span class="edu-deg">${esc(e.degree)}</span>${yr}</div>
        <div class="edu-school">${esc(e.school)}</div>
      </div>`;
    })
    .join("");
  const educationSection = eduHtml ? `<h2>Education</h2>${eduHtml}` : "";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  :root { --accent: ${ACCENT}; --muted: #5a6472; --line: #d7dce3; }
  * { box-sizing: border-box; }
  @page { size: Letter; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { font-family: ${FONT}; color: #1c2330; font-size: 10pt; line-height: 1.3; padding: 0.45in 0.6in 0.4in; }
  .name { font-size: 21pt; font-weight: 800; letter-spacing: 0.04em; color: var(--accent); }
  .contact { font-size: 9pt; color: var(--muted); margin-top: 4px; }
  .contact .item:not(:last-child)::after { content: "\\00b7"; color: #aeb6c2; margin: 0 7px; }
  .k { font-weight: 700; color: #3a4456; }
  h2 { font-size: 10.5pt; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); border-bottom: 1px solid var(--line); padding-bottom: 2px; margin: 12px 0 6px; }
  .summary { color: #2a3240; }
  .skill { margin-bottom: 3px; }
  ul { margin: 0; padding-left: 16px; }
  li { margin-bottom: 2.5px; }
  .job { margin-bottom: 8px; }
  .job-head { display: flex; justify-content: space-between; align-items: baseline; }
  .job-co { font-weight: 800; font-size: 10.5pt; color: #16202e; }
  .job-meta { font-size: 9pt; color: var(--muted); white-space: nowrap; padding-left: 8px; }
  .job-role { font-size: 9.8pt; font-style: italic; color: var(--accent); margin: 0 0 3px; }
  .edu { margin-bottom: 6px; }
  .edu-deg { font-weight: 700; }
  .edu-school { color: #2a3240; }
</style></head>
<body>
  ${name}
  ${contactLine}
  ${summarySection}
  ${skillsSection}
  ${experienceSection}
  ${projectsSection}
  ${educationSection}
</body></html>`;
}
