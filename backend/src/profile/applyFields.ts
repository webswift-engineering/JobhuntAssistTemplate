import type { MasterProfile } from "./masterProfile.js";

/** Flat, form-ready contact fields for apply autofill (extension Easy Apply assist,
 *  /apply skill). Derived from master-profile.json contact + the screening-answer
 *  bank; the consumer matches question labels against `answers` keys (normalized). */
export interface ApplyFields {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedinUrl: string;
  websiteUrl: string;
  /** Most recent role (experience[0]) — for "current company/title" questions. */
  currentCompany: string;
  currentTitle: string;
  /** Most recent education entry — for "School" comboboxes. */
  school: string;
  degree: string;
  /** User-curated screening answers, keys normalized lowercase. */
  answers: Record<string, string>;
}

const normalizeKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export function buildApplyFields(
  profile: MasterProfile | null,
  screeningAnswers: Record<string, string>
): ApplyFields {
  const c = profile?.contact ?? {};
  const name = (c.name ?? "").trim();
  const lastSpace = name.lastIndexOf(" ");
  const links = c.links ?? [];
  const linkedinUrl = links.find((l) => /linkedin\.com/i.test(l)) ?? "";
  const websiteUrl = links.find((l) => !/linkedin\.com/i.test(l)) ?? "";
  const answers: Record<string, string> = {};
  for (const [k, v] of Object.entries(screeningAnswers)) {
    const nk = normalizeKey(k);
    if (nk) answers[nk] = v;
  }
  const latest = profile?.experience?.[0];
  return {
    fullName: name,
    firstName: lastSpace > 0 ? name.slice(0, lastSpace) : name,
    lastName: lastSpace > 0 ? name.slice(lastSpace + 1) : "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    location: c.location ?? "",
    linkedinUrl,
    websiteUrl,
    currentCompany: latest?.company ?? "",
    currentTitle: latest?.title ?? "",
    school: profile?.education?.[0]?.school ?? "",
    degree: profile?.education?.[0]?.degree ?? "",
    answers,
  };
}
