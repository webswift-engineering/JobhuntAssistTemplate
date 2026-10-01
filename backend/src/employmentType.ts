/**
 * Employment-type classification (full-time vs contract vs part-time vs intern).
 * Structured source fields (JSearch job_employment_type, Adzuna contract_type/
 * contract_time, Lever categories.commitment, Ashby employmentType) always win;
 * a regex pass over title+description is the fallback for sources that expose
 * nothing structured (Greenhouse, Workday, extension captures). "unknown" means
 * no signal either way — notification treats it as FTE-probable but flags it.
 */

export type EmploymentType = "full_time" | "contract" | "part_time" | "intern" | "unknown";

export const EMPLOYMENT_TYPES: EmploymentType[] = [
  "full_time",
  "contract",
  "part_time",
  "intern",
  "unknown",
];

/** Map a raw structured field value (any casing/punctuation) to a type, or null. */
function fromStructured(raw: string): EmploymentType | null {
  const v = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (/^(fulltime|permanent|fte)$/.test(v)) return "full_time";
  if (/^(contractor|contract|temporary|temp|freelance)$/.test(v)) return "contract";
  if (/^(parttime)$/.test(v)) return "part_time";
  if (/^(intern|internship)$/.test(v)) return "intern";
  return null; // unrecognized structured value → fall through to regex
}

// Contract markers strong enough to trust anywhere (title or description).
const CONTRACT_STRONG =
  /\bc2c\b|corp[\s-]*to[\s-]*corp\b|\b1099\b|\bw-?2\s+hourly\b|\bcontract[\s-]*to[\s-]*hire\b|\btemp[\s-]*to[\s-](hire|perm)\b|\bstaffing\s+(agency|firm)\b|\b(3|6|9|12|18|24)[\s-]*month(s)?\s+(contract|term|engagement|assignment)\b/i;

// "contract"/"contractor" as words — decisive in the title; in the description
// only when clearly describing the position (avoid e.g. "smart contract" is rare
// in this corpus, but "contract with vendors" happens).
const CONTRACT_WORD_TITLE = /\bcontract(or)?\b|\binterim\b|\bfreelance\b/i;
const CONTRACT_WORD_DESC =
  /\b(this|the)\s+(role|position|opportunity)\s+is\s+(a\s+)?(\d+[\s-]*month\s+)?contract\b|\bcontract\s+(role|position|opportunity|assignment|engagement)\b|\bcontractor\s+(role|position)\b/i;

const INTERN_TITLE = /\bintern(ship)?\b|\bco[\s-]?op\b/i;
const PART_TIME = /\bpart[\s-]*time\b/i;
const FULL_TIME = /\bfull[\s-]*time\b|\bfte\b|\bpermanent\s+(role|position|full|placement|employee)?\b/i;

/** Classify from an optional structured field plus title/description text. */
export function classifyEmployment(input: {
  structured?: string | null;
  title: string;
  description?: string | null;
}): EmploymentType {
  if (input.structured?.trim()) {
    const mapped = fromStructured(input.structured.trim());
    if (mapped) return mapped;
  }
  const title = input.title ?? "";
  const desc = input.description ?? "";
  const both = `${title}\n${desc}`;

  // Title signals are decisive.
  if (INTERN_TITLE.test(title)) return "intern";
  if (CONTRACT_WORD_TITLE.test(title) || CONTRACT_STRONG.test(title)) return "contract";
  if (PART_TIME.test(title) && !FULL_TIME.test(title)) return "part_time";

  // Description signals: strong contract markers beat a generic "full-time" mention
  // ("W2 hourly, full-time hours" is still a contract).
  if (CONTRACT_STRONG.test(desc) || CONTRACT_WORD_DESC.test(desc)) return "contract";
  if (FULL_TIME.test(both)) return "full_time";
  if (PART_TIME.test(desc)) return "part_time";
  return "unknown";
}
