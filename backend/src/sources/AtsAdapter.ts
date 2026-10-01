import type { RawJob } from "../types.js";

export interface CompanyRef {
  name: string;
  boardToken: string;
}

export interface AtsAdapter {
  ats: string;
  fetchJobs(company: CompanyRef): Promise<RawJob[]>;
}

/** Polite fetch with timeout + normal User-Agent. Returns parsed JSON or throws. */
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 20000
): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: ctrl.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted && attempt === 0) continue;
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** HTML fetch for career-page watches (non-JSON). */
export async function fetchText(url: string, timeoutMs = 20000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}
