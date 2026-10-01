// Salary floor + workplace classification (stamped at ingest, like
// employment_type). The floor is optional and OFF by default; set
// SALARY_FLOOR_HYBRID_CAD (hybrid / onsite) and SALARY_FLOOR_REMOTE_CAD
// (fully remote / placeless) in .env to turn it on.
// USD postings convert at a fixed rate. Jobs with NO parseable salary always
// PASS (hard-filtering unknowns would empty the queue) — they surface with a
// "salary?" tag instead. Only a KNOWN below-floor salary excludes a job from
// the apply queue / stream / notifications.
import { config } from "./config.js";

export type Workplace = "remote" | "hybrid" | "onsite" | "unknown";

export interface ParsedSalary {
  /** Annualized, CAD-normalized bounds. Single figures set min == max. */
  minCad: number;
  maxCad: number;
  currency: "CAD" | "USD";
}

const HOURS_PER_YEAR = 2080;
/** Sanity clamp — parses outside this annual range are discarded as noise. */
const MIN_PLAUSIBLE = 25_000;
const MAX_PLAUSIBLE = 1_500_000;

const CA_LOCATION_RE =
  /\b(canada|canadian|ontario|toronto|vancouver|montr[eé]al|ottawa|calgary|waterloo|mississauga|brampton|british columbia|qu[eé]bec|alberta|\bON\b|\bBC\b|\bQC\b|\bAB\b)\b/i;

/** One money token → annual amount (null = not salary-like). `hourly` from context. */
function tokenToAnnual(raw: string, hourly: boolean): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  const k = /k$/i.test(cleaned);
  const n = Number.parseFloat(cleaned.replace(/k$/i, ""));
  if (!Number.isFinite(n)) return null;
  let annual: number;
  if (k) annual = n * 1000;
  else if (hourly) annual = n * HOURS_PER_YEAR;
  else if (n >= 10_000) annual = n;
  else if (n >= 20 && n <= 200) annual = n * HOURS_PER_YEAR; // bare "45–60" next to /hour context
  else return null;
  return annual >= MIN_PLAUSIBLE && annual <= MAX_PLAUSIBLE ? Math.round(annual) : null;
}

/**
 * Parse a salary range out of free text. Only trusts money mentions that sit in
 * a salary CONTEXT (currency marker on the number, or salary/pay/compensation
 * wording nearby) so ordinal numbers in a JD can't become a "salary".
 * `trusted` skips the context requirement (salary_text snippets are already
 * salary by construction).
 */
export function parseSalary(
  text: string | null | undefined,
  opts: { defaultCurrency: "CAD" | "USD"; trusted?: boolean }
): ParsedSalary | null {
  if (!text) return null;
  const t = text.slice(0, 20_000);

  const NUM = String.raw`\$?\s*\d{1,3}(?:[, ]\d{3})+(?:\.\d+)?|\$?\s*\d+(?:\.\d+)?\s*[kK]|\$\s*\d+(?:\.\d+)?`;
  const RANGE = new RegExp(String.raw`(${NUM})\s*(?:-|–|—|~|to|up to)\s*(${NUM})`, "g");
  const SINGLE = new RegExp(String.raw`(${NUM})`, "g");

  const contextOk = (index: number, matchText: string): boolean => {
    if (opts.trusted) return true;
    if (/\$/.test(matchText)) return true; // an explicit dollar figure is its own context
    const around = t.slice(Math.max(0, index - 90), index + matchText.length + 90);
    return /salar|compensation|\bpay\b|remunerat|base range|\bctc\b|per (year|annum|hour)|annually|\/\s*(yr|year|hour|hr)/i.test(
      around
    );
  };

  const currencyFor = (index: number): "CAD" | "USD" => {
    const around = t.slice(Math.max(0, index - 60), index + 60);
    if (/\b(CAD|CA\$|C\$)\b|CA\$|C\$/i.test(around)) return "CAD";
    if (/\b(USD|US\$)\b|US\$/.test(around)) return "USD";
    return opts.defaultCurrency;
  };

  const hourlyAt = (index: number, len: number): boolean =>
    /per hour|\/\s*(hr|hour)|hourly/i.test(t.slice(Math.max(0, index - 40), index + len + 40));

  // Prefer an explicit range; fall back to the first plausible single figure.
  for (const m of t.matchAll(RANGE)) {
    if (!contextOk(m.index!, m[0])) continue;
    const hourly = hourlyAt(m.index!, m[0].length);
    const a = tokenToAnnual(m[1]!, hourly);
    const b = tokenToAnnual(m[2]!, hourly);
    if (a == null || b == null) continue;
    const currency = currencyFor(m.index!);
    const rate = currency === "USD" ? config.salary.usdToCad : 1;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return { minCad: Math.round(lo * rate), maxCad: Math.round(hi * rate), currency };
  }
  for (const m of t.matchAll(SINGLE)) {
    if (!contextOk(m.index!, m[0])) continue;
    const hourly = hourlyAt(m.index!, m[0].length);
    const v = tokenToAnnual(m[1]!, hourly);
    if (v == null) continue;
    const currency = currencyFor(m.index!);
    const rate = currency === "USD" ? config.salary.usdToCad : 1;
    return { minCad: Math.round(v * rate), maxCad: Math.round(v * rate), currency };
  }
  return null;
}

/** Bare-$ figures default to the posting's likely local currency. */
export function defaultCurrencyFor(location: string | null | undefined): "CAD" | "USD" {
  return CA_LOCATION_RE.test(location ?? "") ? "CAD" : "USD";
}

/**
 * Workplace classification. Location wins over description; "hybrid" wins over
 * "remote" wherever both appear ("remote 2 days a week" is hybrid).
 *
 * City-anchored fallback: a posting tied to a
 * specific place ("Mississauga, ON") with NO remote signals is office-bound in
 * practice — classify "onsite" so the full salary bar applies. Country-only
 * locations ("Canada", "United States") often mean remote-nationwide, so they
 * stay "unknown" (lenient bar).
 */
export function classifyWorkplace(
  location: string | null | undefined,
  description: string | null | undefined
): Workplace {
  const loc = location ?? "";
  if (/hybrid/i.test(loc)) return "hybrid";
  if (/on[- ]?site/i.test(loc)) return "onsite";
  if (/\bremote\b/i.test(loc)) return "remote";
  const d = (description ?? "").slice(0, 8000);
  if (/hybrid/i.test(d)) return "hybrid";
  if (/fully remote|100%\s*remote|remote[- ](first|only)|work from anywhere/i.test(d)) return "remote";
  if (/on[- ]?site|in[- ]office/i.test(d)) return "onsite";
  // "City, Region" pattern = anchored to a place. (Comma is the signal:
  // "Mississauga, ON" → onsite bar; bare "Toronto" or "Canada" → unknown.)
  if (loc.includes(",") && !/anywhere|flexible|multiple locations|various/i.test(loc)) return "onsite";
  return "unknown";
}

/** The floor that applies to a workplace. "unknown" is now only truly placeless
 *  postings (city-anchored ones classify onsite) — those keep the LENIENT
 *  remote bar, since an unlabeled placeless job is plausibly remote. */
export function floorFor(workplace: Workplace | null | undefined): number {
  return workplace === "remote" || workplace === "unknown" || workplace == null
    ? config.salary.floorRemoteCad
    : config.salary.floorHybridCad;
}

/** Known-below-floor check for in-memory rows (stream start, tests). */
export function belowSalaryFloor(job: {
  salary_max_cad?: number | null;
  workplace?: Workplace | null;
}): boolean {
  if (job.salary_max_cad == null) return false; // unknown salary always passes
  return job.salary_max_cad < floorFor(job.workplace);
}

/**
 * SQL fragment implementing the same rule (queue filter + notify gate).
 * Returns [whereClause, params].
 */
export function salaryFloorSql(): [string, number[]] {
  if (!config.salary.floorHybridCad && !config.salary.floorRemoteCad) return ["1=1", []];
  // CAST gives Postgres a type for the CASE branches (params arrive as text →
  // "integer >= text" without it); SQLite accepts the same standard syntax.
  return [
    `(salary_max_cad IS NULL OR salary_max_cad >= (CASE WHEN workplace IN ('hybrid','onsite') THEN CAST(? AS INTEGER) ELSE CAST(? AS INTEGER) END))`,
    [config.salary.floorHybridCad, config.salary.floorRemoteCad],
  ];
}
