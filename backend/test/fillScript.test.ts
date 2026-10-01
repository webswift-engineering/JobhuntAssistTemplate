import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import type { DB } from "../src/db/client.js";
import { createTestDb } from "./helpers.js";
import { ingestJob, findJobByPostingUrl, normalizePostingUrl } from "../src/store.js";
import { buildFillScript, type FillPayload } from "../src/apply/fillScript.js";
import type { RawJob } from "../src/types.js";

const job = (o: Partial<RawJob> = {}): RawJob => ({
  source: "ashby",
  sourceKind: "ats",
  company: "Acme",
  title: "Backend Engineer",
  url: "https://jobs.ashbyhq.com/acme/2b1f0c44-7c11-4f1e-8a0d-9c5e1a2b3c4d",
  externalId: "2b1f0c44-7c11-4f1e-8a0d-9c5e1a2b3c4d",
  description: "go backend",
  ...o,
});

describe("findJobByPostingUrl — the phone only has the address bar", () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it("strips the form sub-path, the query string and the hash", () => {
    expect(normalizePostingUrl("https://jobs.ashbyhq.com/acme/abc/application?utm=x#jh-apply=1")).toBe(
      "https://jobs.ashbyhq.com/acme/abc"
    );
    expect(normalizePostingUrl("https://jobs.lever.co/acme/abc/apply")).toBe("https://jobs.lever.co/acme/abc");
    expect(normalizePostingUrl("https://job-boards.greenhouse.io/acme/jobs/123/")).toBe(
      "https://job-boards.greenhouse.io/acme/jobs/123"
    );
  });

  it("resolves the job from the posting page, the form page, and a tracked link", async () => {
    const ingested = await ingestJob(db, 1, job());
    for (const url of [
      "https://jobs.ashbyhq.com/acme/2b1f0c44-7c11-4f1e-8a0d-9c5e1a2b3c4d",
      "https://jobs.ashbyhq.com/acme/2b1f0c44-7c11-4f1e-8a0d-9c5e1a2b3c4d/application",
      "https://jobs.ashbyhq.com/acme/2b1f0c44-7c11-4f1e-8a0d-9c5e1a2b3c4d?utm_source=slack",
    ]) {
      expect((await findJobByPostingUrl(db, 1, url))?.id).toBe(ingested.id);
    }
  });

  it("falls back to the ATS posting id when the host was rewritten", async () => {
    const ingested = await ingestJob(
      db,
      1,
      job({ source: "greenhouse", url: "https://job-boards.greenhouse.io/acme/jobs/8041376", externalId: "8041376" })
    );
    // Branded board: different host and board token, same posting id.
    expect((await findJobByPostingUrl(db, 1, "https://careers.acme.com/jobs/8041376"))?.id).toBe(ingested.id);
  });

  it("never leaks another account's job", async () => {
    await ingestJob(db, 1, job());
    expect(await findJobByPostingUrl(db, 2, job().url!)).toBeUndefined();
  });

  it("returns nothing for an unknown page instead of guessing", async () => {
    await ingestJob(db, 1, job());
    expect(await findJobByPostingUrl(db, 1, "https://jobs.ashbyhq.com/other/deadbeef-0000")).toBeUndefined();
  });
});

const payload = (o: Partial<FillPayload> = {}): FillPayload => ({
  jobId: "job1",
  title: "Backend Engineer",
  company: "Acme",
  fields: {
    fullName: "Jane Roe",
    firstName: "Jane",
    lastName: "Roe",
    email: "jane@example.com",
    phone: "+1 416 555 0100",
    location: "Toronto, ON, Canada",
    linkedinUrl: "https://linkedin.com/in/janeroe",
    websiteUrl: "https://janeroe.dev",
    currentCompany: "Acme",
    currentTitle: "Senior Engineer",
    school: "University of Toronto",
    degree: "BSc Computer Science",
    answers: { "have you worked remotely before": "Yes" },
  },
  coverLetter: "Dear Acme — I have shipped Go services for six years.",
  resumeBase64: null,
  resumeUrl: "http://pc.tailnet.ts.net:8787/jobs/job1/resume/file?format=pdf",
  recordUrl: "http://pc.tailnet.ts.net:8787/?applied=job1",
  ...o,
});

const ASHBY_FORM = `
  <form class="_jobPostingForm_1">
    <label for="_systemfield_name">Name</label><input id="_systemfield_name" type="text" required>
    <label for="_systemfield_email">Email</label><input id="_systemfield_email" type="email" required>
    <label for="li">LinkedIn</label><input id="li" type="text">
    <label for="why">Why do you want to work at Acme?</label><textarea id="why"></textarea>
    <label for="visa">Do you require visa sponsorship?</label><input id="visa" type="text" required>
    <input id="_systemfield_resume" type="file">
  </form>`;

/**
 * Run the assembled script exactly the way the iOS Shortcut does: as the body of
 * `new Function("done", …)`, with `completion` passed in as `done`. This is the
 * integration point that unit tests on either half would miss — a bad
 * concatenation or a stray top-level `return` only shows up here.
 */
async function runInPage(script: string, html: string, url: string): Promise<{ summary: string; dom: JSDOM }> {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url,
  });
  dom.window.Element.prototype.getClientRects = function (this: Element) {
    return (this.isConnected ? [{ width: 1, height: 1 }] : []) as unknown as DOMRectList;
  };
  const fn = new (dom.window as unknown as { Function: FunctionConstructor }).Function("done", script);
  const summary = await new Promise<string>((resolve) => fn(resolve));
  return { summary, dom };
}

describe("buildFillScript — the self-contained phone payload", () => {
  it("survives the URL-encoding round trip the Shortcut puts it through", () => {
    const script = buildFillScript(payload());
    expect(decodeURIComponent(encodeURIComponent(script))).toBe(script);
    // encodeURIComponent leaves no quote/backslash/newline that could break the
    // `new Function(decodeURIComponent("…"))` wrapper's string literal.
    expect(encodeURIComponent(script)).not.toMatch(/["\\\n]/);
  });

  it("bundles the adapters, the core and the driver in one script", () => {
    const script = buildFillScript(payload());
    expect(script).toContain("JC_APPLY_ADAPTERS");
    expect(script).toContain("JC_APPLY_CORE");
    expect(script).toContain("JC_APPLY_ASSIST");
    expect(script).toContain("JC_APPLY_MOBILE");
    expect(script).toContain("__JH_APPLY_PAYLOAD");
  });

  it("fills a real form and hands a summary back to Shortcuts", async () => {
    const { summary, dom } = await runInPage(
      buildFillScript(payload()),
      ASHBY_FORM,
      "https://jobs.ashbyhq.com/acme/abc/application"
    );
    const value = (sel: string) => (dom.window.document.querySelector(sel) as HTMLInputElement).value;

    expect(value("#_systemfield_name")).toBe("Jane Roe");
    expect(value("#_systemfield_email")).toBe("jane@example.com");
    expect(value("#li")).toBe("https://linkedin.com/in/janeroe");
    // Cover letter seeds the motivation box as a reviewable draft.
    expect(value("#why")).toContain("shipped Go services");
    // Sensitive question with no banked answer stays for the human, and the
    // summary says so instead of quietly reporting success.
    expect(value("#visa")).toBe("");
    expect(summary).toMatch(/sponsorship/i);
    expect(summary).toMatch(/unanswered/);
  }, 20000);

  it("tells the human where the résumé is when it cannot attach one", async () => {
    const { summary, dom } = await runInPage(
      buildFillScript(payload()),
      ASHBY_FORM,
      "https://jobs.ashbyhq.com/acme/abc/application"
    );
    expect(summary).toContain("résumé: unavailable");
    const sheet = dom.window.document.getElementById("jh-fill-sheet")!.shadowRoot!;
    expect(sheet.textContent).toContain("Files ▸ JobHunt");
    expect([...sheet.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toContain(
      "http://pc.tailnet.ts.net:8787/?applied=job1"
    );
  }, 20000);

  it("sends the human to the form when the shortcut ran on the posting page", async () => {
    const { summary } = await runInPage(
      buildFillScript(payload()),
      `<h1>Backend Engineer</h1><a>Apply for this job</a>`,
      "https://jobs.ashbyhq.com/acme/abc"
    );
    expect(summary).toBe("opened the application form — run the shortcut again");
  }, 20000);

  it("still offers the field helper on hosts with no adapter", async () => {
    const { summary, dom } = await runInPage(
      buildFillScript(payload()),
      ASHBY_FORM,
      "https://acme.wd1.myworkdayjobs.com/en-US/External/job/123"
    );
    expect(summary).toMatch(/field helper only/);
    expect(summary).toMatch(/no adapter/);
    expect(dom.window.JC_APPLY_ASSIST).toBeTruthy();
  }, 20000);
});
