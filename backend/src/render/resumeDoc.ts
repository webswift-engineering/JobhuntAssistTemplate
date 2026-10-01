import type {
  TailoredResume,
  ResumeContact,
  ResumeDoc,
  ResumeDocEntry,
  ResumeDocProject,
} from "../llm/tailorResume.js";

export type { ResumeContact, ResumeDoc, ResumeDocEntry, ResumeDocProject };

/**
 * Minimum bullets to keep per experience role. The one-page fit loop will trim
 * projects and excess bullets, but never take a real role below this floor —
 * a role with only 1–2 bullets reads thin. Shared by the tailor and the PDF trimmer.
 */
export const MIN_BULLETS_PER_ROLE = 3;

/**
 * Return the structured, ATS-clean document for a tailored resume when present.
 * The profile-based tailor produces this; the legacy string/master-text path
 * does not, in which case renderers fall back to flat sections.
 */
export function toResumeDoc(
  tailored: TailoredResume
): { contact?: ResumeContact; doc: ResumeDoc } | null {
  if (!tailored.doc) return null;
  return { contact: tailored.contact, doc: tailored.doc };
}

export interface ContactItem {
  k: string;
  v: string;
}

/** Keep the full https:// URL (clearer for readers); drop any trailing slash. */
function cleanUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Label a contact URL by type. Labels read clearly for humans and don't affect
 * ATS link detection (Workday/Greenhouse match the URL pattern, not the label).
 * `sort` orders professional profiles (LinkedIn, GitHub) before a personal site.
 */
function labelLink(url: string): ContactItem & { sort: number } {
  const v = cleanUrl(url);
  if (/linkedin\.com/i.test(v)) return { k: "LinkedIn", v, sort: 0 };
  if (/github\.com/i.test(v)) return { k: "GitHub", v, sort: 1 };
  if (/gitlab\.com/i.test(v)) return { k: "GitLab", v, sort: 1 };
  return { k: "Website", v, sort: 2 };
}

/**
 * Labeled contact items in body order: Email, Phone, Location, then profile
 * links (LinkedIn/GitHub before a personal site). Used by every renderer so the
 * contact block is consistent across TXT/DOCX/PDF.
 */
export function contactItems(contact?: ResumeContact): ContactItem[] {
  if (!contact) return [];
  const items: ContactItem[] = [];
  if (contact.email?.trim()) items.push({ k: "Email", v: contact.email.trim() });
  if (contact.phone?.trim()) items.push({ k: "Phone", v: contact.phone.trim() });
  if (contact.location?.trim()) items.push({ k: "Location", v: contact.location.trim() });
  const links = (contact.links ?? [])
    .filter((l) => !!l && l.trim().length > 0)
    .map(labelLink)
    .sort((a, b) => a.sort - b.sort)
    .map(({ k, v }) => ({ k, v }));
  items.push(...links);
  return items;
}

/**
 * Contact block for the document BODY (never a header/footer — those are
 * skipped by Workday/Greenhouse). Line 1 = name, line 2 = labeled details.
 */
export function contactHeaderLines(contact?: ResumeContact): string[] {
  if (!contact) return [];
  const lines: string[] = [];
  if (contact.name) lines.push(contact.name);
  const items = contactItems(contact);
  if (items.length) lines.push(items.map((i) => `${i.k}: ${i.v}`).join(" \u00b7 "));
  return lines;
}

/**
 * Single-line role header: "Title — Company, Location (Dates)". Title + company
 * + a parseable date range on one line is what Workday/Greenhouse expect for a
 * work-history entry. Avoids pipes (read as table cells by our parser-safety lint).
 */
export function roleHeaderLine(entry: ResumeDocEntry): string {
  const loc = entry.location && entry.location.trim() ? `, ${entry.location.trim()}` : "";
  const dates = entry.dates && entry.dates.trim() ? ` (${entry.dates.trim()})` : "";
  return `${entry.title} \u2014 ${entry.company}${loc}${dates}`;
}

/** Education line: "Degree, School (Year)" — year omitted cleanly when absent. */
export function educationLine(ed: { degree: string; school: string; year?: string }): string {
  const yr = ed.year && ed.year.trim() ? ` (${ed.year.trim()})` : "";
  return `${ed.degree}, ${ed.school}${yr}`;
}

/** Project header for single-column renderers: "Name — Context". */
export function projectHeaderLine(p: ResumeDocProject): string {
  return p.context && p.context.trim() ? `${p.name} \u2014 ${p.context.trim()}` : p.name;
}
