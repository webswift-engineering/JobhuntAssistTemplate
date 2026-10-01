import type { Preferences } from "../types.js";
import { regionPolicyFromPrefs, type AllowedRegion } from "../regionFilter.js";
import type { MasterProfile } from "./masterProfile.js";

/**
 * Compact, machine-readable summary of the candidate used to triage job lists.
 * Derived from the structured master profile plus saved preferences; it is the
 * yardstick every scanned job card is measured against.
 */
export interface MatchFacts {
  /** Total merged work history, any field (an unrelated prior career counts). */
  yearsExperience: number;
  /**
   * Years spent in roles relevant to the target titles — the honest number for
   * years knockouts and LLM facts. Optional so hand-built fixtures and old
   * callers fall back to yearsExperience; computeMatchFacts always sets it.
   */
  relevantYearsExperience?: number;
  languages: string[];
  skills: string[];
  titles: string[];
  dealbreakers: string[];
  allowedRegions: AllowedRegion[];
}

/** Common programming-language / stack names we can recognize inside a skills list. */
const KNOWN_LANGUAGES = [
  "java", "python", "typescript", "javascript", "go", "golang", "rust", "c++", "c#",
  "ruby", "php", "scala", "kotlin", "swift", "objective-c", "elixir", "erlang", "clojure",
  "haskell", "perl", "r", "matlab", "sql", "bash", "shell", "dart", "lua", "groovy",
  "node", "nodejs", "node.js",
];

/** Parse "2024-09" / "Sep 2024" / "2024" / "Present" into a fractional year number. */
function toYearNumber(raw: string | undefined, now: Date): number | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (/^(present|current|now)$/i.test(s)) return now.getFullYear() + now.getMonth() / 12;
  const iso = s.match(/^(\d{4})-(\d{1,2})/);
  if (iso) return Number(iso[1]) + (Number(iso[2]) - 1) / 12;
  const monthName = s.match(/^([A-Za-z]{3,})\s+(\d{4})/);
  if (monthName) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mi = months.indexOf(monthName[1]!.slice(0, 3).toLowerCase());
    if (mi >= 0) return Number(monthName[2]) + mi / 12;
  }
  const year = s.match(/(\d{4})/);
  return year ? Number(year[1]) : null;
}

/** Sum a set of [start, end] year intervals, merging overlaps so concurrent roles are not double-counted. */
function sumMergedIntervals(intervals: [number, number][]): number {
  intervals.sort((a, b) => a[0] - b[0]);

  let total = 0;
  let curStart: number | null = null;
  let curEnd = 0;
  for (const [s, e] of intervals) {
    if (curStart == null) {
      curStart = s;
      curEnd = e;
    } else if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  if (curStart != null) total += curEnd - curStart;
  return Math.round(total * 10) / 10;
}

function experienceIntervals(
  entries: MasterProfile["experience"],
  now: Date
): [number, number][] {
  const intervals: [number, number][] = [];
  for (const exp of entries) {
    const start = toYearNumber(exp.start, now);
    const end = toYearNumber(exp.end, now);
    if (start == null || end == null || end < start) continue;
    intervals.push([start, end]);
  }
  return intervals;
}

/**
 * Total years of experience, merging overlapping roles so concurrent positions
 * are not double-counted. Rounded to one decimal.
 */
export function totalYearsExperience(profile: MasterProfile, now = new Date()): number {
  return sumMergedIntervals(experienceIntervals(profile.experience, now));
}

/** Seniority/filler words in target titles that say nothing about the field itself. */
const TITLE_NOISE_WORDS = new Set([
  "senior", "junior", "jr", "sr", "lead", "staff", "principal", "head",
  "intern", "internship", "entry", "level", "associate", "assistant",
  "i", "ii", "iii", "iv", "the", "and", "of", "for",
]);

function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length >= 2 && !TITLE_NOISE_WORDS.has(w));
}

/**
 * Years spent in roles whose titles share a field word with the target titles
 * (e.g. "Marketing Intern" vs target "Marketing Analyst"). This is what keeps a
 * career-changer's unrelated history (e.g. retail) from inflating the years
 * used in knockouts and LLM facts. An explicit profile.relevantYears overrides it.
 */
export function relevantYearsFromTitles(
  profile: MasterProfile,
  targetTitles: string[],
  now = new Date()
): number {
  const signal = new Set(targetTitles.flatMap(titleWords));
  if (!signal.size) return totalYearsExperience(profile, now);
  const relevant = profile.experience.filter((exp) =>
    titleWords(exp.title).some((w) => signal.has(w))
  );
  return sumMergedIntervals(experienceIntervals(relevant, now));
}

/** Case-insensitive dedup preserving the first-seen original casing. */
function dedupPreserveCase(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function extractLanguages(skills: string[]): string[] {
  return skills.filter((s) => KNOWN_LANGUAGES.includes(s.trim().toLowerCase()));
}

/** Build the triage yardstick from the structured profile (if any) and preferences. */
export function computeMatchFacts(
  profile: MasterProfile | null,
  prefs: Preferences,
  now = new Date()
): MatchFacts {
  const skillValues: string[] = [];
  const explicitLanguages: string[] = [];

  if (profile?.skills) {
    for (const [category, items] of Object.entries(profile.skills)) {
      skillValues.push(...items);
      if (/language/i.test(category)) explicitLanguages.push(...items);
    }
  }
  // Bullet tags are a rich, JD-aligned skill signal.
  if (profile?.experience) {
    for (const exp of profile.experience) {
      for (const b of exp.bullets) {
        if (b.tags) skillValues.push(...b.tags);
      }
    }
  }

  const skills = dedupPreserveCase(skillValues);
  const languages = dedupPreserveCase(
    explicitLanguages.length ? explicitLanguages : extractLanguages(skills)
  );

  const dealbreakersRaw = Array.isArray((prefs as { dealbreakers?: unknown }).dealbreakers)
    ? ((prefs as { dealbreakers?: string[] }).dealbreakers ?? [])
    : [];

  const titles = dedupPreserveCase(prefs.titles ?? []);

  return {
    yearsExperience: profile ? totalYearsExperience(profile, now) : 0,
    relevantYearsExperience: profile
      ? profile.relevantYears ?? relevantYearsFromTitles(profile, titles, now)
      : 0,
    languages,
    skills,
    titles,
    dealbreakers: dedupPreserveCase(dealbreakersRaw),
    allowedRegions: regionPolicyFromPrefs(prefs).allowedRegions,
  };
}
