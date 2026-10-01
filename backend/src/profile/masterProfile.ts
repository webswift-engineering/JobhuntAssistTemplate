import { z } from "zod";

export const ProfileBulletSchema = z.object({
  id: z.string(),
  text: z.string(),
  tags: z.array(z.string()).optional(),
});

export const ProfileExperienceSchema = z.object({
  company: z.string(),
  title: z.string(),
  location: z.string().optional(),
  start: z.string(),
  end: z.string(),
  bullets: z.array(ProfileBulletSchema),
});

export const MasterProfileSchema = z.object({
  contact: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    location: z.string().optional(),
    links: z.array(z.string()).optional(),
  }),
  summary: z.string().optional(),
  /**
   * Years of experience relevant to the target roles, set at profile-compile
   * time. Overrides the title-overlap heuristic in matchFacts for career
   * changers whose relevant work hides under unrelated job titles.
   */
  relevantYears: z.number().nonnegative().optional(),
  skills: z.record(z.array(z.string())).optional(),
  experience: z.array(ProfileExperienceSchema),
  education: z
    .array(z.object({ school: z.string(), degree: z.string(), year: z.string() }))
    .optional(),
  projects: z
    .array(
      z.object({
        name: z.string(),
        context: z.string().optional(),
        stack: z.string().optional(),
        bullets: z.array(z.string()),
        // Experience bullet ids this project is derived from — excluded from the
        // Experience section to avoid showing the same accomplishment twice.
        sourceBulletIds: z.array(z.string()).optional(),
      })
    )
    .optional(),
});

export type MasterProfile = z.infer<typeof MasterProfileSchema>;
export type ProfileBullet = z.infer<typeof ProfileBulletSchema>;

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Normalize a single date token to an ATS-friendly form. Workday/Greenhouse
 * date extractors are strict: "Month YYYY" and bare "YYYY" parse reliably,
 * but raw ISO "2024-09" does not. Converts "2024-09" → "Sep 2024",
 * "present"/"current" → "Present", and leaves already-formatted text as-is.
 */
export function formatMonthYear(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (/^(present|current|now)$/i.test(s)) return "Present";
  const iso = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (iso) {
    const mo = Number(iso[2]);
    return mo >= 1 && mo <= 12 ? `${MONTHS_SHORT[mo - 1]} ${iso[1]}` : iso[1];
  }
  const year = s.match(/^(\d{4})$/);
  if (year) return year[1];
  return s;
}

/** Build an ATS-friendly date range, e.g. "Sep 2024 – Present". */
export function formatDateRange(start: string | undefined, end: string | undefined): string {
  const a = formatMonthYear(start);
  const b = formatMonthYear(end);
  if (a && b) return `${a} \u2013 ${b}`;
  return a || b || "";
}

/** Flat index of all bullets by id for fabrication checks. */
export function bulletIndex(profile: MasterProfile): Map<string, string> {
  const map = new Map<string, string>();
  for (const exp of profile.experience) {
    for (const b of exp.bullets) {
      map.set(b.id, b.text);
    }
  }
  return map;
}

/** Serialize profile to a master-resume-like string (fallback / LLM context). */
export function profileToMasterText(profile: MasterProfile): string {
  const lines: string[] = [];
  if (profile.summary) {
    lines.push("SUMMARY", profile.summary, "");
  }
  if (profile.skills && Object.keys(profile.skills).length) {
    lines.push("SKILLS");
    for (const [cat, items] of Object.entries(profile.skills)) {
      lines.push(`${cat}: ${items.join(", ")}`);
    }
    lines.push("");
  }
  lines.push("EXPERIENCE");
  for (const exp of profile.experience) {
    lines.push(`${exp.title} — ${exp.company} (${exp.start}–${exp.end})`);
    for (const b of exp.bullets) {
      lines.push(`- ${b.text}`);
    }
    lines.push("");
  }
  if (profile.education?.length) {
    lines.push("EDUCATION");
    for (const ed of profile.education) {
      lines.push(`${ed.degree}, ${ed.school} (${ed.year})`);
    }
  }
  return lines.join("\n").trim();
}
