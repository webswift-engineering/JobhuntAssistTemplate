import puppeteer from "puppeteer-core";
import fs from "node:fs";
import type { TailoredResume } from "../llm/tailorResume.js";
import { config } from "../config.js";
import { tailoredHtml } from "./layout.js";
import { toResumeDoc, MIN_BULLETS_PER_ROLE, type ResumeDoc } from "./resumeDoc.js";
import { onePageHtml } from "./onePageHtml.js";

type PageLike = Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>;

/** Render the structured doc to a Letter PDF (no page clipping — used to count pages). */
async function renderDocPdf(
  page: PageLike,
  contact: Parameters<typeof onePageHtml>[0],
  doc: ResumeDoc
): Promise<Uint8Array> {
  await page.setContent(onePageHtml(contact, doc), { waitUntil: "domcontentloaded" });
  return page.pdf({ format: "Letter", printBackground: true });
}

/** Count rendered pages in a Chrome-generated PDF (one "/Type /Page" object per page). */
function countPdfPages(pdf: Buffer): number {
  const matches = pdf.toString("latin1").match(/\/Type\s*\/Page(?![s])/g);
  return matches ? matches.length : 1;
}

/**
 * Remove one bullet to reduce height. Projects are fillers, so they go FIRST
 * (last project, last bullet). Only then do we trim experience — from the largest
 * role — and never below MIN_BULLETS_PER_ROLE so no real role is left looking thin.
 * Returns null when nothing more can be trimmed without violating that floor.
 */
function trimOneBullet(doc: ResumeDoc): ResumeDoc | null {
  // 1. Trim projects first (page-fillers).
  const projects = (doc.projects ?? []).map((p) => ({ ...p, bullets: [...p.bullets] }));
  for (let i = projects.length - 1; i >= 0; i--) {
    if (projects[i].bullets.length > 0) {
      projects[i].bullets.pop();
      if (projects[i].bullets.length === 0) projects.splice(i, 1);
      return { ...doc, projects };
    }
  }
  // 2. Then trim the largest experience role, but keep the per-role floor.
  const experience = (doc.experience ?? []).map((e) => ({ ...e, bullets: [...e.bullets] }));
  let idx = -1;
  let max = MIN_BULLETS_PER_ROLE;
  experience.forEach((e, i) => {
    if (e.bullets.length > max) {
      max = e.bullets.length;
      idx = i;
    }
  });
  if (idx >= 0) {
    experience[idx].bullets.pop();
    return { ...doc, experience };
  }
  return null;
}

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;

let browserPromise: Promise<Browser> | null = null;
let exitHookInstalled = false;

function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /connection closed|target closed|browser has been closed|session closed|protocol error/i.test(
    msg
  );
}

async function launchBrowser(): Promise<Browser> {
  if (!fs.existsSync(config.chromePath)) {
    throw new Error(`Chrome not found at ${config.chromePath} — set CHROME_PATH`);
  }
  const browser = await puppeteer.launch({
    executablePath: config.chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  browser.on("disconnected", () => {
    // Drop the cache so the next render relaunches Chrome.
    browserPromise = null;
  });
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      browserPromise?.then((b) => b.close()).catch(() => {});
    });
  }
  return browser;
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  const browser = await browserPromise;
  if (!browser.connected) {
    browserPromise = null;
    return getBrowser();
  }
  return browser;
}

/** Close shared browser and clear cache (tests / recovery). */
export async function closePdfBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  try {
    const b = await pending;
    if (b.connected) await b.close();
  } catch {
    /* already dead */
  }
}

async function renderPdfOnce(tailored: TailoredResume): Promise<Buffer> {
  const structured = toResumeDoc(tailored);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    if (structured) {
      // Polished, two-column human-facing PDF. Fill the page, then trim from the
      // bottom only when the content actually spills onto a 2nd page — judged by
      // Chrome's real print pagination (accurate), not screen-pixel guesses.
      // HTML is self-contained (inline CSS, system fonts), so "domcontentloaded".
      let doc: ResumeDoc = structured.doc;
      let pdf = Buffer.from(await renderDocPdf(page, structured.contact, doc));
      for (let i = 0; i < 14 && countPdfPages(pdf) > 1; i++) {
        const trimmed = trimOneBullet(doc);
        if (!trimmed) break;
        doc = trimmed;
        pdf = Buffer.from(await renderDocPdf(page, structured.contact, doc));
      }
      // Final safety: hard-clip to one page if still overflowing.
      if (countPdfPages(pdf) > 1) {
        await page.setContent(onePageHtml(structured.contact, doc), {
          waitUntil: "domcontentloaded",
        });
        pdf = Buffer.from(
          await page.pdf({ format: "Letter", printBackground: true, pageRanges: "1" })
        );
      }
      return pdf;
    }
    // Legacy fallback (no structured doc): single-column.
    await page.setContent(tailoredHtml(tailored), { waitUntil: "domcontentloaded" });
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      margin: { top: "0.75in", bottom: "0.75in", left: "0.75in", right: "0.75in" },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

export async function renderPdf(tailored: TailoredResume): Promise<Buffer> {
  try {
    return await renderPdfOnce(tailored);
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    // Stale shared Chrome (e.g. process died after days of uptime) — relaunch once.
    console.warn("[renderPdf] Chrome connection lost, relaunching:", (err as Error).message);
    await closePdfBrowser();
    return renderPdfOnce(tailored);
  }
}
