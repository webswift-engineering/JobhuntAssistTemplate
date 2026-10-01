import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { config } from "../src/config.js";

/**
 * The apply-fill core is plain browser JavaScript shared by the desktop
 * extension engine and the phone fill script (docs/phone-apply-design.md).
 * These tests are the safety net for that sharing: they pin the field
 * detection, value resolution and protected-question guards that were tuned
 * against live Greenhouse / Ashby / Lever forms, so a refactor on either
 * surface can't quietly change what gets filled.
 */

interface Core {
  norm: (s: string) => string;
  cleanLabel: (s: string) => string;
  labelTextFor: (el: Element) => string;
  isCombobox: (el: Element) => boolean;
  isProtectedQuestion: (adapter: unknown, el: Element, label: string) => boolean;
  bankFor: (l: string, fields: unknown) => string | null;
  textValueFor: (l: string, fields: unknown) => string | null;
  contactPresets: (fields: unknown) => { kind: string; label: string; value: string }[];
  suggestChips: (label: string, fields: unknown, limit?: number) => { kind: string; label: string; value: string }[];
  fileInputRole: (el: Element) => string | null;
  injectPdf: (el: Element, b64: string | null, filename?: string) => string;
  setValue: (el: Element, value: string) => boolean;
  comboboxCandidates: (l: string, fields: unknown) => string[] | null;
  provinceCandidates: (loc: string) => string[];
  createFiller: (
    adapter: unknown,
    fields: unknown,
    opts?: unknown
  ) => {
    pass: () => Promise<{ label: string; el: Element; askLlm: boolean }[]>;
    mergeAnswers: (a: Record<string, string | null>) => boolean;
    engineFilled: Map<string, string>;
    trace: string[];
  };
  collectSnapshot: (
    adapter: unknown,
    filled: Map<string, string> | null
  ) => { label: string; value: string; source: string }[];
  bankableAnswers: (snapshot: unknown[]) => Record<string, string>;
  looksSubmitted: (adapter: unknown) => boolean;
  freeTextBoxes: (adapter: unknown) => Element[];
  draftFreeText: (adapter: unknown, letter: string, opts?: unknown) => number;
  attachResume: (adapter: unknown, b64: string | null, settle?: number) => Promise<string>;
}

const read = (rel: string) => fs.readFileSync(path.join(config.extensionDir, rel), "utf8");
const ADAPTERS_SRC = read("applyAdapters.js");
const CORE_SRC = read("applyCore.js");

interface Loaded {
  dom: JSDOM;
  core: Core;
  adapter: (host: string) => unknown;
  q: <T extends Element>(sel: string) => T;
}

function load(bodyHtml: string): Loaded {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window as unknown as Record<string, unknown>;
  // jsdom has no layout engine, so getClientRects() is empty for every node and
  // the combobox option filter would reject real options. Report all attached
  // nodes as visible — visibility is a browser concern, not a logic one.
  dom.window.Element.prototype.getClientRects = function (this: Element) {
    return (this.isConnected ? [{ width: 1, height: 1 }] : []) as unknown as DOMRectList;
  };
  dom.window.eval(ADAPTERS_SRC);
  dom.window.eval(CORE_SRC);
  const core = w.JC_APPLY_CORE as Core;
  return {
    dom,
    core,
    adapter: (host) => (w.JC_APPLY_ADAPTERS as Record<string, unknown>)[host],
    q: <T extends Element>(sel: string) => dom.window.document.querySelector(sel) as T,
  };
}

const FIELDS = {
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
  answers: {} as Record<string, string>,
};
const fields = (answers: Record<string, string> = {}) => ({ ...FIELDS, answers });

describe("applyCore — value resolution", () => {
  let core: Core;
  beforeEach(() => {
    core = load("").core;
  });

  it("maps contact labels onto profile fields", () => {
    const f = fields();
    expect(core.textValueFor("first name", f)).toBe("Jane");
    expect(core.textValueFor("last name", f)).toBe("Roe");
    expect(core.textValueFor("full name", f)).toBe("Jane Roe");
    expect(core.textValueFor("email address", f)).toBe("jane@example.com");
    expect(core.textValueFor("linkedin profile", f)).toBe("https://linkedin.com/in/janeroe");
    expect(core.textValueFor("personal website", f)).toBe("https://janeroe.dev");
  });

  it("never guesses a sensitive answer, but reuses a banked one verbatim", () => {
    expect(core.textValueFor("desired salary", fields())).toBeNull();
    expect(core.textValueFor("will you require visa sponsorship", fields())).toBeNull();
    const banked = fields({ "desired salary": "150,000 CAD" });
    expect(core.textValueFor("desired salary", banked)).toBe("150,000 CAD");
  });

  it("matches the bank fuzzily so one banked answer covers reworded questions", () => {
    const f = fields({ "what are your pronouns": "she/her" });
    expect(core.bankFor("pronouns", f)).toBe("she/her");
    // Short labels can't fuzzy-match — "no" must not latch onto a long key.
    expect(core.bankFor("no", f)).toBeNull();
  });

  it("builds focus-dropdown chips: best match first, skips EEO, includes the bank", () => {
    const f = fields({ "years of go experience": "6" });
    const email = core.suggestChips("Email address", f);
    expect(email[0]).toEqual({ kind: "best", label: "Suggested", value: "jane@example.com" });
    expect(email.some((c) => c.value === "Jane Roe")).toBe(true);

    expect(core.suggestChips("Gender", f)).toEqual([]);
    expect(core.suggestChips("Veteran status", f)).toEqual([]);

    const go = core.suggestChips("How many years of Go experience do you have?", f);
    expect(go.some((c) => c.value === "6")).toBe(true);
  });

  it("classifies file inputs so a headshot is not fed the résumé", () => {
    const { core, q } = load(`
      <label>Resume<input id="cv" type="file" accept=".pdf,.doc"></label>
      <label>Headshot<input id="pic" type="file" accept="image/png,image/jpeg"></label>
      <label>Cover letter<input id="cl" type="file"></label>
    `);
    expect(core.fileInputRole(q("#cv"))).toBe("resume");
    expect(core.fileInputRole(q("#pic"))).toBe("photo");
    expect(core.fileInputRole(q("#cl"))).toBe("cover");
  });

  it("offers geo-suggest candidates city-first and resolves the province", () => {
    expect(core.comboboxCandidates("where do you reside", fields())).toEqual([
      "Toronto",
      "Toronto, ON, Canada",
      "Ontario",
    ]);
    expect(core.comboboxCandidates("state or province", fields())).toEqual(["Ontario"]);
    expect(core.comboboxCandidates("country", fields())).toEqual(["Canada"]);
    expect(core.provinceCandidates("Vancouver, BC")).toEqual(["British Columbia"]);
  });

  it("distinguishes 'ask the LLM' (null) from 'human only' ([])", () => {
    expect(core.comboboxCandidates("how many years of kubernetes", fields())).toBeNull();
    expect(core.comboboxCandidates("are you legally authorized to work", fields())).toEqual([]);
  });
});

describe("applyCore — label resolution", () => {
  it("reads <label for>, aria-label, and the single-field wrapper", () => {
    const { core, q } = load(`
      <label for="a">Email</label><input id="a" type="text">
      <input id="b" type="text" aria-label="Phone number">
      <div class="_fieldEntry_x"><label>Where do you reside?</label><input id="c" role="combobox"></div>
    `);
    expect(core.cleanLabel(core.labelTextFor(q("#a")))).toBe("Email");
    expect(core.cleanLabel(core.labelTextFor(q("#b")))).toBe("Phone number");
    expect(core.cleanLabel(core.labelTextFor(q("#c")))).toBe("Where do you reside?");
  });

  it("treats role=combobox and react-select shells as comboboxes", () => {
    const { core, q } = load(`
      <input id="plain" type="text">
      <input id="aria" role="combobox">
      <div class="select__control"><input id="rs" type="text"></div>
    `);
    expect(core.isCombobox(q("#plain"))).toBe(false);
    expect(core.isCombobox(q("#aria"))).toBe(true);
    expect(core.isCombobox(q("#rs"))).toBe(true);
  });
});

describe("applyCore — fill pass over a Greenhouse-shaped form", () => {
  const FORM = `
    <form id="application-form">
      <label for="first_name">First Name *</label><input id="first_name" type="text" required>
      <label for="last_name">Last Name *</label><input id="last_name" type="text" required>
      <label for="email">Email *</label><input id="email" type="email" required>
      <label for="phone">Phone</label><input id="phone" type="tel">
      <label for="li">LinkedIn Profile</label><input id="li" type="url">
      <label for="salary">Desired salary *</label><input id="salary" type="text" required>
      <h3>Voluntary Self-Identification</h3>
      <div>
        <label for="gender">Gender</label><input id="gender" type="text">
        <label for="veteran_status">Veteran status</label><input id="veteran_status" type="text">
      </div>
    </form>`;

  it("fills what it knows, leaves sensitive + protected fields alone", async () => {
    const { core, adapter, q } = load(FORM);
    const gh = adapter("job-boards.greenhouse.io");
    const filler = core.createFiller(gh, fields());
    const unanswered = await filler.pass();

    expect(q<HTMLInputElement>("#first_name").value).toBe("Jane");
    expect(q<HTMLInputElement>("#last_name").value).toBe("Roe");
    expect(q<HTMLInputElement>("#email").value).toBe("jane@example.com");
    expect(q<HTMLInputElement>("#phone").value).toBe("+1 416 555 0100");
    expect(q<HTMLInputElement>("#li").value).toBe("https://linkedin.com/in/janeroe");

    // Sensitive: required, so it is reported — but never guessed.
    expect(q<HTMLInputElement>("#salary").value).toBe("");
    const salary = unanswered.find((u) => /desired salary/i.test(u.label));
    expect(salary).toBeTruthy();
    expect(salary!.askLlm).toBe(false);
    expect(salary!.label).toContain("yours to answer");

    // Protected: not filled, and not even reported back for an LLM to answer.
    expect(q<HTMLInputElement>("#gender").value).toBe("");
    expect(q<HTMLInputElement>("#veteran_status").value).toBe("");
    expect(unanswered.some((u) => /gender|veteran/i.test(u.label))).toBe(false);
  });

  it("honours maxlength and never overwrites a value already on the form", async () => {
    const { core, adapter, q } = load(`
      <form id="application-form">
        <label for="first_name">First Name</label><input id="first_name" type="text" maxlength="2">
        <label for="email">Email</label><input id="email" type="text" value="typed@by.human">
      </form>`);
    await core.createFiller(adapter("job-boards.greenhouse.io"), fields()).pass();
    expect(q<HTMLInputElement>("#first_name").value).toBe("Ja");
    expect(q<HTMLInputElement>("#email").value).toBe("typed@by.human");
  });

  it("fills a native select only from the bank, and reports it otherwise", async () => {
    const { core, adapter, q } = load(`
      <form id="application-form">
        <label for="src">How did you hear about us? *</label>
        <select id="src" required><option value=""></option><option>LinkedIn</option><option>Referral</option></select>
        <label for="rem">Are you comfortable working remotely? *</label>
        <select id="rem" required><option value=""></option><option>Yes</option><option>No</option></select>
      </form>`);
    const gh = adapter("job-boards.greenhouse.io");
    const unanswered = await core
      .createFiller(gh, fields({ "are you comfortable working remotely": "Yes" }))
      .pass();
    expect(q<HTMLSelectElement>("#rem").value).toBe("Yes");
    expect(q<HTMLSelectElement>("#src").value).toBe("");
    expect(unanswered.some((u) => /how did you hear/i.test(u.label))).toBe(true);
  });

  it("re-running the pass is idempotent — the verify pass must not double-report", async () => {
    const { core, adapter } = load(FORM);
    const filler = core.createFiller(adapter("job-boards.greenhouse.io"), fields());
    const first = await filler.pass();
    const second = await filler.pass();
    expect(second.map((u) => u.label).sort()).toEqual(first.map((u) => u.label).sort());
  });

  it("merges answers from an LLM round-trip into the next pass", async () => {
    const { core, adapter, q } = load(`
      <form id="application-form">
        <label for="yrs">How many years of Go experience do you have? *</label><input id="yrs" type="text" required>
      </form>`);
    const filler = core.createFiller(adapter("job-boards.greenhouse.io"), fields());
    expect((await filler.pass()).length).toBe(1);
    expect(filler.mergeAnswers({ "How many years of Go experience do you have?": "4" })).toBe(true);
    expect(await filler.pass()).toEqual([]);
    expect(q<HTMLInputElement>("#yrs").value).toBe("4");
  });
});

describe("applyCore — Ashby yes/no buttons", () => {
  const yesNo = (question: string) => `
    <form class="_jobPostingForm_1"><div class="_fieldEntry_1">
      <label>${question}</label>
      <div class="_yesno_1">
        <input type="checkbox"><button type="button" class="_option_1">Yes</button><button type="button" class="_option_1">No</button>
      </div>
    </div></form>`;

  it("clicks the button matching a banked answer", async () => {
    const { core, adapter, dom } = load(yesNo("Have you worked at a startup before?"));
    const clicked: string[] = [];
    for (const b of dom.window.document.querySelectorAll("button")) {
      b.addEventListener("click", () => clicked.push(b.textContent ?? ""));
    }
    await core
      .createFiller(adapter("jobs.ashbyhq.com"), fields({ "have you worked at a startup before": "Yes" }), {
        timing: { commit: 0 },
      })
      .pass();
    expect(clicked).toEqual(["Yes"]);
  });

  it("leaves an unbanked question to the human instead of picking one", async () => {
    const { core, adapter, dom } = load(yesNo("Do you require visa sponsorship?"));
    const clicked: string[] = [];
    for (const b of dom.window.document.querySelectorAll("button")) {
      b.addEventListener("click", () => clicked.push(b.textContent ?? ""));
    }
    const unanswered = await core
      .createFiller(adapter("jobs.ashbyhq.com"), fields(), { timing: { commit: 0 } })
      .pass();
    expect(clicked).toEqual([]);
    const q = unanswered.find((u) => /sponsorship/i.test(u.label));
    expect(q?.askLlm).toBe(false);
  });
});

describe("applyCore — cover-letter drafts", () => {
  it("drafts into motivation boxes only, and skips ones the human started", () => {
    const { core, adapter, q } = load(`
      <form id="application-form">
        <label for="why">Why do you want to work here?</label><textarea id="why"></textarea>
        <label for="other">Anything else we should know?</label><textarea id="other"></textarea>
        <label for="started">Why this role?</label><textarea id="started">my own words</textarea>
      </form>`);
    const gh = adapter("job-boards.greenhouse.io");
    expect(core.freeTextBoxes(gh).length).toBe(1);
    expect(core.draftFreeText(gh, "Dear Acme, ...")).toBe(1);
    expect(q<HTMLTextAreaElement>("#why").value).toBe("Dear Acme, ...");
    expect(q<HTMLTextAreaElement>("#other").value).toBe("");
    expect(q<HTMLTextAreaElement>("#started").value).toBe("my own words");
  });

  it("does nothing without a letter", () => {
    const { core, adapter } = load(
      `<form id="application-form"><label for="w">Why us?</label><textarea id="w"></textarea></form>`
    );
    expect(core.draftFreeText(adapter("job-boards.greenhouse.io"), "")).toBe(0);
  });
});

describe("applyCore — submit snapshot and banking", () => {
  it("attributes each value to engine / human / human-edited and drops protected ones", async () => {
    const { core, adapter, q } = load(`
      <form id="application-form">
        <label for="first_name">First Name</label><input id="first_name" type="text">
        <label for="email">Email</label><input id="email" type="text">
        <label for="yrs">How many years of Go experience do you have?</label><input id="yrs" type="text">
        <label for="empty">Referral code</label><input id="empty" type="text">
        <h3>Voluntary Self-Identification</h3>
        <div><label for="gender">Gender</label><input id="gender" type="text" value="Woman"></div>
      </form>`);
    const gh = adapter("job-boards.greenhouse.io");
    const filler = core.createFiller(gh, fields());
    await filler.pass();
    q<HTMLInputElement>("#yrs").value = "4 years shipping Go services";
    q<HTMLInputElement>("#email").value = "different@example.com";

    const snapshot = core.collectSnapshot(gh, filler.engineFilled);
    const by = (label: string) => snapshot.find((f) => f.label.toLowerCase().startsWith(label))!;
    expect(by("first name").source).toBe("engine");
    expect(by("email").source).toBe("human-edited");
    expect(by("how many years").source).toBe("human");
    expect(by("referral code").source).toBe("empty");
    expect(snapshot.some((f) => /gender/i.test(f.label))).toBe(false);

    // Only the human's own words are worth banking — contact fields are already
    // in the profile, and short labels are too ambiguous to reuse.
    const banked = core.bankableAnswers(snapshot);
    expect(banked).toEqual({ "How many years of Go experience do you have?": "4 years shipping Go services" });
  });

  it("needs the form GONE before calling a confirmation phrase a submission", () => {
    const stillOnForm = load(
      `<form id="application-form"><p>Thank you for your interest in Acme</p></form>`
    );
    expect(stillOnForm.core.looksSubmitted(stillOnForm.adapter("job-boards.greenhouse.io"))).toBe(false);

    const done = load(`<p>Thank you for applying</p>`);
    expect(done.core.looksSubmitted(done.adapter("job-boards.greenhouse.io"))).toBe(true);
  });
});

describe("applyCore — résumé attach", () => {
  it("reports 'none' with no upload field and degrades to 'unavailable' without bytes", async () => {
    const noField = load(`<form id="application-form"><input type="text"></form>`);
    const gh = noField.adapter("job-boards.greenhouse.io");
    expect(await noField.core.attachResume(gh, "AAAA", 0)).toBe("none");

    const withField = load(`<form id="application-form"><input type="file"></form>`);
    expect(await withField.core.attachResume(withField.adapter("job-boards.greenhouse.io"), null, 0)).toBe(
      "unavailable"
    );
  });
});
