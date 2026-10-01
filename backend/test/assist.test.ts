import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { config } from "../src/config.js";

/**
 * The in-page helper that follows the human through login / Next: focus a box
 * → preset chips; click Upload → attach this job's PDF. Never submits.
 */

const read = (rel: string) => fs.readFileSync(path.join(config.extensionDir, rel), "utf8");

interface AssistApi {
  mount: (ctx: unknown) => { ok: boolean };
  unmount: () => void;
}

function load(html: string) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "https://acme.wd1.myworkdayjobs.com/apply",
  });
  const w = dom.window as unknown as Window & {
    JC_APPLY_CORE: unknown;
    JC_APPLY_ASSIST: AssistApi;
    DataTransfer?: unknown;
    File?: typeof File;
  };
  dom.window.Element.prototype.getBoundingClientRect = function () {
    return { top: 80, bottom: 110, left: 40, right: 320, width: 280, height: 30, x: 40, y: 80, toJSON() {} } as DOMRect;
  };
  class FakeDT {
    files: File[] = [];
    items = {
      add: (f: File) => {
        this.files = [f];
      },
    };
  }
  (w as unknown as { DataTransfer: unknown }).DataTransfer = FakeDT;
  Object.defineProperty(dom.window.HTMLInputElement.prototype, "files", {
    configurable: true,
    get() {
      return (this as unknown as { _jhFiles?: FileList })._jhFiles ?? { length: 0, item: () => null };
    },
    set(list: FileList | File[]) {
      const files = Array.isArray(list) ? list : Array.from(list || []);
      (this as unknown as { _jhFiles: FileList })._jhFiles = Object.assign(files, {
        length: files.length,
        item: (i: number) => files[i] ?? null,
      }) as unknown as FileList;
    },
  });
  for (const input of [...dom.window.document.querySelectorAll("input[type=file]")]) {
    Object.defineProperty(input, "files", {
      configurable: true,
      get() {
        return (this as unknown as { _jhFiles?: FileList })._jhFiles ?? { length: 0, item: () => null };
      },
      set(list: FileList | File[]) {
        const files = Array.isArray(list) ? list : Array.from(list || []);
        (this as unknown as { _jhFiles: FileList })._jhFiles = Object.assign(files, {
          length: files.length,
          item: (i: number) => files[i] ?? null,
        }) as unknown as FileList;
      },
    });
  }
  dom.window.eval(read("applyCore.js"));
  dom.window.eval(read("assist.js"));
  return { dom, w, q: <T extends Element>(sel: string) => dom.window.document.querySelector(sel) as T };
}

const fields = {
  fullName: "Jane Roe",
  firstName: "Jane",
  lastName: "Roe",
  email: "jane@example.com",
  phone: "+1 416 555 0100",
  location: "Toronto",
  linkedinUrl: "https://linkedin.com/in/janeroe",
  websiteUrl: "",
  currentCompany: "Acme",
  currentTitle: "Engineer",
  school: "",
  degree: "",
  answers: { "years of go": "6" },
};

describe("in-page field helper", () => {
  it("fills the focused box from a preset chip", () => {
    const { w, q } = load(`<label for="em">Work email</label><input id="em" type="email">`);
    expect(w.JC_APPLY_ASSIST.mount({ fields, jobId: "abc", resumeReady: false })).toEqual({ ok: true });
    const input = q<HTMLInputElement>("#em");
    input.dispatchEvent(new w.FocusEvent("focusin", { bubbles: true }));
    const menu = w.document.getElementById("jh-assist-host")!.shadowRoot!;
    const rows = [...menu.querySelectorAll("button.row")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.textContent).toMatch(/jane@example.com/i);
    (rows[0] as HTMLButtonElement).click();
    expect(input.value).toBe("jane@example.com");
  });

  it("does not offer chips on an EEO field", () => {
    const { w, q } = load(`<label for="g">Gender</label><input id="g" type="text">`);
    w.JC_APPLY_ASSIST.mount({ fields, jobId: "abc" });
    q<HTMLInputElement>("#g").dispatchEvent(new w.FocusEvent("focusin", { bubbles: true }));
    const menu = w.document.getElementById("jh-assist-host")!.shadowRoot!.querySelector(".menu") as HTMLElement;
    expect(menu.style.display).toBe("none");
  });

  it("attaches the job résumé when Upload is clicked, and leaves a photo input alone", async () => {
    const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
    const { w, q } = load(`
      <label>Resume<input id="cv" type="file" accept=".pdf"></label>
      <label>Headshot<input id="pic" type="file" accept="image/png"></label>
    `);
    w.JC_APPLY_ASSIST.mount({
      fields,
      jobId: "abc",
      resumeReady: true,
      resumeBase64: pdf,
      resumeFilename: "Jane-Roe-Acme.pdf",
    });
    const cv = q<HTMLInputElement>("#cv");
    const pic = q<HTMLInputElement>("#pic");
    const ev = new w.MouseEvent("click", { bubbles: true, cancelable: true });
    cv.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(cv.dataset.jhAttached).toBe("1");
    expect(cv.files && cv.files.length).toBeGreaterThan(0);
    expect(cv.files![0]!.name).toBe("Jane-Roe-Acme.pdf");
    pic.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(pic.files && pic.files.length).toBe(0);
  });
});
