import type { Preferences } from "./types.js";

export type AllowedRegion = "US" | "CA";

export interface RegionPolicy {
  allowedRegions: AllowedRegion[];
}

export interface RegionCheck {
  allowed: boolean;
  reason: string;
}

/** Default: US + Canada only. Onsite and remote within those countries are both fine. */
export function regionPolicyFromPrefs(prefs: Preferences): RegionPolicy {
  const raw = prefs.allowedRegions;
  if (Array.isArray(raw) && raw.length > 0) {
    const allowed = raw.filter((r): r is AllowedRegion => r === "US" || r === "CA");
    if (allowed.length > 0) return { allowedRegions: allowed };
  }
  return { allowedRegions: ["US", "CA"] };
}

const NON_NA_RE =
  /\b(ireland|dublin|cork|galway|united kingdom|\buk\b|england|scotland|wales|london|manchester|birmingham|edinburgh|germany|berlin|munich|hamburg|frankfurt|france|paris|lyon|netherlands|amsterdam|rotterdam|spain|madrid|barcelona|italy|rome|milan|sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki|poland|warsaw|krakow|portugal|lisbon|austria|vienna|switzerland|zurich|geneva|belgium|brussels|romania|bucharest|hungary|budapest|czech|prague|india|bangalore|bengaluru|mumbai|hyderabad|pune|delhi|noida|singapore|australia|sydney|melbourne|brisbane|tokyo|japan|osaka|china|beijing|shanghai|shenzhen|korea|seoul|taiwan|taipei|hong kong|brazil|são paulo|sao paulo|mexico city|buenos aires|argentina|colombia|bogotá|bogota|chile|santiago|israel|tel aviv|uae|dubai|abu dhabi|saudi|riyadh|jeddah|south africa|johannesburg|philippines|manila|vietnam|hanoi|ho chi minh|indonesia|jakarta|thailand|bangkok|emea|apac|latam|latin america|europe\b|european union|\beu\b|middle east|africa|asia pacific)\b/i;

const US_RE =
  /\b(united states|\busa\b|\bu\.s\.?\b|\bus\b|us-remote|remote\s*[-–—]?\s*us|remote,\s*us|north america)\b|,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)(?:\s|,|$)|\b(seattle|san francisco|los angeles|new york|nyc|chicago|boston|austin|denver|atlanta|miami|portland|san diego|san jose|dallas|houston|phoenix|philadelphia|washington|dc|bay area|silicon valley)\b/i;

const CA_RE =
  /\b(canada|\bcan\b|canadian|can-remote|remote\s*[-–—]?\s*can(?:ada)?|remote,\s*can(?:ada)?)\b|\b(toronto|vancouver|montreal|montréal|calgary|edmonton|ottawa|waterloo|mississauga|gta|ontario|british columbia|quebec|québec|alberta|manitoba|saskatchewan|nova scotia|new brunswick|winnipeg|hamilton|kitchener)\b|,\s*(ON|BC|QC|AB)(?:\s|,|$)/i;

const REMOTE_ONLY_RE = /^(remote|hybrid remote|fully remote|work from home|wfh)$/i;

function matchesUS(text: string): boolean {
  return US_RE.test(text);
}

function matchesCA(text: string): boolean {
  return CA_RE.test(text);
}

function matchesNonNa(text: string): boolean {
  return NON_NA_RE.test(text);
}

/**
 * Returns whether a job is within allowed regions. Remote with no country is allowed
 * (common for US/CA remote postings). Clear non-US/CA locations are blocked.
 */
export function checkJobRegion(
  location: string | null | undefined,
  description: string | null | undefined,
  policy: RegionPolicy
): RegionCheck {
  const allowsUS = policy.allowedRegions.includes("US");
  const allowsCA = policy.allowedRegions.includes("CA");
  if (!allowsUS && !allowsCA) return { allowed: true, reason: "No region restriction" };

  const loc = (location ?? "").trim();
  const desc = (description ?? "").slice(0, 4000);

  // A specific non-US/CA location always wins — don't let JD boilerplate about other offices override.
  if (loc && matchesNonNa(loc)) {
    return {
      allowed: false,
      reason: `Outside allowed regions (${policy.allowedRegions.join("/")} only): ${loc}`,
    };
  }

  const inUS = allowsUS && matchesUS(loc);
  const inCA = allowsCA && matchesCA(loc);
  if (inUS || inCA) {
    const parts = [inUS && "US", inCA && "Canada"].filter(Boolean);
    return { allowed: true, reason: `In allowed region: ${parts.join(", ")}` };
  }

  const hay = `${loc} ${desc}`;

  if (loc && (matchesUS(hay) || matchesCA(hay))) {
    const parts = [allowsUS && matchesUS(hay) && "US", allowsCA && matchesCA(hay) && "Canada"].filter(Boolean);
    return { allowed: true, reason: `In allowed region: ${parts.join(", ")}` };
  }

  if (!loc || REMOTE_ONLY_RE.test(loc)) {
    if (matchesNonNa(hay) && !matchesUS(hay) && !matchesCA(hay)) {
      return {
        allowed: false,
        reason: `Outside allowed regions (${policy.allowedRegions.join("/")} only)`,
      };
    }
    return { allowed: true, reason: "Remote / unspecified location (allowed)" };
  }

  if (matchesNonNa(hay)) {
    return {
      allowed: false,
      reason: `Outside allowed regions (${policy.allowedRegions.join("/")} only): ${loc}`,
    };
  }

  return { allowed: true, reason: "Location not restricted" };
}

export function isJobInAllowedRegions(
  location: string | null | undefined,
  description: string | null | undefined,
  prefs: Preferences
): boolean {
  return checkJobRegion(location, description, regionPolicyFromPrefs(prefs)).allowed;
}
