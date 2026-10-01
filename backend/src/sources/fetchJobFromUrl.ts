/**
 * Server-side job extraction from a posting URL. Used by the dashboard "Fetch from
 * URL" button and the iOS Share-sheet Shortcut so a device without the browser
 * extension (iPad / phone) can capture a job with just its link.
 *
 * Layers, most reliable first:
 *   1. ATS JSON APIs (Greenhouse, Lever) when the URL matches — clean title/JD/location.
 *   2. schema.org JobPosting JSON-LD in the HTML (Ashby and many company sites).
 *   3. Readable body-text fallback (rough) — prefilled for the user to trim.
 *
 * "clean" results (1 & 2) are auto-captured; "rough" results (3) are returned for review.
 * SPA-only or bot-blocked sites (e.g. Indeed, LinkedIn) may yield little — the caller
 * then falls back to manual paste.
 */

import { atsBoardFromUrl } from "./atsSlugFromUrl.js";

export interface ExtractedJob {
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
  salaryText: string | null;
  postedAt: number | null;
}

export interface FetchJobResult {
  ok: boolean;
  quality: "clean" | "rough" | "none";
  error?: string;
  extracted: ExtractedJob;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const JD_MAX = 20_000;

function emptyJob(): ExtractedJob {
  return { title: null, company: null, location: null, description: null, salaryText: null, postedAt: null };
}

export async function fetchJobFromUrl(url: string, timeoutMs = 12_000): Promise<FetchJobResult> {
  // 1. ATS JSON API (clean).
  try {
    const viaAts = await fromAtsApi(url, timeoutMs);
    if (viaAts && viaAts.description && viaAts.description.length >= 40) {
      return { ok: true, quality: "clean", extracted: viaAts };
    }
  } catch {
    /* fall through to HTML */
  }

  // 1b. LinkedIn — logged-in URLs hit a sign-in wall; use the public guest endpoint.
  try {
    const viaLi = await fromLinkedIn(url, timeoutMs);
    if (viaLi && viaLi.description && viaLi.description.length >= 40) {
      return { ok: true, quality: "clean", extracted: viaLi };
    }
  } catch {
    /* fall through to HTML */
  }

  // 2 & 3. Fetch HTML, then JSON-LD → readable text.
  let html = "";
  try {
    html = await fetchText(url, timeoutMs);
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const msg =
      e.name === "AbortError"
        ? "The page took too long to load."
        : e.cause?.code === "ENOTFOUND"
          ? "Couldn't resolve that address."
          : e.message || "Couldn't fetch that page.";
    return { ok: false, quality: "none", error: msg, extracted: emptyJob() };
  }

  const extracted = emptyJob();
  let quality: "clean" | "rough" | "none" = "none";

  const jp = findJobPosting(collectJsonLd(html));
  if (jp) {
    extracted.title = clean(strFrom(jp.title));
    extracted.company = clean(orgName(jp.hiringOrganization));
    extracted.location = clean(locationString(jp.jobLocation) ?? remoteHint(jp));
    extracted.description = normalizeText(htmlToText(strFrom(jp.description)));
    extracted.salaryText = clean(salaryString(jp.baseSalary));
    extracted.postedAt = parseDate(jp.datePosted);
    if (extracted.description && extracted.description.length >= 40) quality = "clean";
  }

  if (!extracted.title) extracted.title = clean(metaContent(html, "og:title") ?? titleTag(html));
  if (!extracted.company) extracted.company = clean(metaContent(html, "og:site_name"));

  // Readable body text as a rough fallback the user can trim before capturing.
  if (!extracted.description || quality !== "clean") {
    const body = normalizeText(readableText(html));
    if (body && body.length >= 200) {
      extracted.description = body.slice(0, JD_MAX);
      if (quality !== "clean") quality = "rough";
    } else if (!extracted.description) {
      const meta = clean(metaContent(html, "og:description") ?? metaContent(html, "description"));
      extracted.description = meta ? normalizeText(meta) : null;
      if (extracted.description) quality = "rough";
    }
  }

  const ok = quality === "clean" && !!extracted.description && extracted.description.length >= 40;
  return {
    ok,
    quality,
    extracted,
    error: ok ? undefined : "Couldn't cleanly read the description — review the text below and capture.",
  };
}

// ---- ATS JSON APIs ---------------------------------------------------------
async function fromAtsApi(url: string, timeoutMs: number): Promise<ExtractedJob | null> {
  const board = atsBoardFromUrl(url);
  if (!board) return null;
  const u = new URL(url);

  if (board.ats === "greenhouse") {
    const idMatch = u.pathname.match(/\/jobs\/(\d+)/) ?? u.search.match(/gh_jid=(\d+)/);
    const id = idMatch?.[1];
    if (!id) return null;
    const api = `https://boards-api.greenhouse.io/v1/boards/${board.boardToken}/jobs/${id}`;
    const j = JSON.parse(await fetchText(api, timeoutMs)) as Record<string, any>;
    return {
      title: clean(strFrom(j.title)),
      company: clean(strFrom(j.company_name)),
      location: clean(strFrom(j.location?.name)),
      description: normalizeText(htmlToText(decodeEntities(strFrom(j.content) ?? ""))),
      salaryText: null,
      postedAt: parseDate(j.first_published ?? j.updated_at),
    };
  }

  if (board.ats === "lever") {
    const seg = u.pathname.split("/").filter(Boolean); // [company, id]
    const id = seg[1];
    if (!id) return null;
    const api = `https://api.lever.co/v0/postings/${board.boardToken}/${id}?mode=json`;
    const j = JSON.parse(await fetchText(api, timeoutMs)) as Record<string, any>;
    const cat = j.categories ?? {};
    const parts = [
      j.descriptionPlain ?? htmlToText(strFrom(j.description)),
      ...(Array.isArray(j.lists) ? j.lists.map((l: any) => `${l.text ?? ""}\n${htmlToText(strFrom(l.content)) ?? ""}`) : []),
      j.additionalPlain ?? htmlToText(strFrom(j.additional)),
    ].filter(Boolean);
    return {
      title: clean(strFrom(j.text)),
      company: null,
      location: clean(strFrom(cat.location)),
      description: normalizeText(parts.join("\n\n")),
      salaryText: clean(strFrom(j.salaryDescriptionPlain)),
      postedAt: typeof j.createdAt === "number" ? j.createdAt : null,
    };
  }

  return null;
}

// ---- LinkedIn (guest job posting, no login) --------------------------------
async function fromLinkedIn(url: string, timeoutMs: number): Promise<ExtractedJob | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!u.hostname.toLowerCase().includes("linkedin.com")) return null;

  const id =
    (u.searchParams.get("currentJobId") && /^\d+$/.test(u.searchParams.get("currentJobId")!)
      ? u.searchParams.get("currentJobId")
      : null) ??
    u.pathname.match(/\/jobs\/view\/(\d+)/)?.[1] ??
    u.pathname.match(/jobPosting\/(\d+)/)?.[1] ??
    u.pathname.match(/-(\d{6,})(?:\/|$)/)?.[1] ??
    null;
  if (!id) return null;

  const guest = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`;
  const html = await fetchText(guest, timeoutMs);

  // Prefer the description markup block; fall back to any JSON-LD in the fragment.
  const descHtml =
    matchClass(html, "show-more-less-html__markup") ?? matchClass(html, "description__text");
  let description = normalizeText(htmlToText(descHtml));
  const title = clean(matchClass(html, "top-card-layout__title") ?? matchClass(html, "topcard__title"));
  const company = clean(
    matchClass(html, "topcard__org-name-link") ?? matchClass(html, "top-card-layout__second-subline")
  );
  const location = clean(matchClass(html, "topcard__flavor--bullet"));

  if (!description) {
    const jp = findJobPosting(collectJsonLd(html));
    if (jp) description = normalizeText(htmlToText(strFrom(jp.description)));
  }

  if (!description) return null;
  return { title, company, location, description, salaryText: null, postedAt: null };
}

/** Grab the inner HTML of the first element carrying `cls`, closing on the SAME tag
 *  it opened (so a container div isn't truncated at the first inner </p>/</span>). */
function matchClass(html: string, cls: string): string | null {
  const re = new RegExp(
    `<(div|span|a|h[1-6]|p|li)\\b[^>]*class=["'][^"']*${escapeRe(cls)}[^"']*["'][^>]*>([\\s\\S]*?)</\\1>`,
    "i"
  );
  const m = html.match(re);
  return m?.[2] ?? null;
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`The site returned HTTP ${res.status}.`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---- JSON-LD ---------------------------------------------------------------
function collectJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = (m[1] ?? "").trim();
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      /* ignore malformed block */
    }
  }
  return out;
}

function findJobPosting(nodes: unknown[]): Record<string, any> | null {
  const stack = [...nodes];
  const seen = new Set<unknown>();
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object" || seen.has(n)) continue;
    seen.add(n);
    if (Array.isArray(n)) {
      stack.push(...n);
      continue;
    }
    const obj = n as Record<string, any>;
    const t = obj["@type"];
    if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) return obj;
    if (Array.isArray(obj["@graph"])) stack.push(...obj["@graph"]);
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

function orgName(org: unknown): string | null {
  if (!org) return null;
  if (typeof org === "string") return org;
  if (typeof org === "object") return strFrom((org as Record<string, any>).name);
  return null;
}

function locationString(loc: unknown): string | null {
  if (!loc) return null;
  const one = Array.isArray(loc) ? loc[0] : loc;
  if (typeof one === "string") return one;
  const addr = (one as Record<string, any>)?.address ?? one;
  if (typeof addr === "string") return addr;
  if (addr && typeof addr === "object") {
    const a = addr as Record<string, any>;
    const parts = [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean);
    if (parts.length) return parts.join(", ");
  }
  return null;
}

function remoteHint(jp: Record<string, any>): string | null {
  const t = jp.jobLocationType;
  if (typeof t === "string" && /telecommute|remote/i.test(t)) return "Remote";
  return null;
}

function salaryString(bs: unknown): string | null {
  if (!bs || typeof bs !== "object") return null;
  const b = bs as Record<string, any>;
  const val = b.value && typeof b.value === "object" ? b.value : b;
  const min = val.minValue ?? val.value;
  const max = val.maxValue;
  const cur = b.currency ?? val.currency ?? "";
  const unit = val.unitText ? ` /${String(val.unitText).toLowerCase()}` : "";
  if (min == null && max == null) return null;
  const range = max && max !== min ? `${min}–${max}` : `${min ?? max}`;
  return `${cur} ${range}${unit}`.trim();
}

// ---- HTML helpers ----------------------------------------------------------
function strFrom(v: unknown): string | null {
  return typeof v === "string" ? v : v == null ? null : String(v);
}

function metaContent(html: string, name: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRe(name)}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escapeRe(name)}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1]);
  }
  return null;
}

function titleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1] ? decodeEntities(m[1]).trim() : null;
}

/** Strip HTML tags to text (assumes real tags, not entity-encoded). */
function stripHtml(s: string | null): string | null {
  if (!s) return null;
  return decodeEntities(
    s
      .replace(/<\s*(br|\/p|\/li|\/div|\/h[1-6]|\/tr)\s*>/gi, "\n")
      .replace(/<\s*li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, "")
  );
}

const htmlToText = stripHtml;

/** Rough main-content text: drop non-content elements, prefer <main>/<article>. */
function readableText(html: string): string | null {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head|nav|header|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const main = h.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) ?? h.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (main?.[1]) h = main[1];
  return stripHtml(h);
}

function normalizeText(s: string | null): string | null {
  if (!s) return null;
  const out = s
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return out || null;
}

function clean(s: string | null): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t || null;
}

function parseDate(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => safeCp(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCp(parseInt(h, 16)));
}

function safeCp(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}
