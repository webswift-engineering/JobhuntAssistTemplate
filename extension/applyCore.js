// Portable apply-fill core — the DOM half of the apply engine with NO chrome.*
// dependency, so one copy of the field detection / value resolution / filling
// logic serves every surface:
//
//   • extension/applyEngine.js      desktop Chrome content script
//   • extension/mobile/fillDriver.js  iOS Shortcuts payload (served by the
//                                     backend at GET /apply/fill-script)
//   • backend/test/applyCore.test.ts  unit tests over a jsdom form
//
// Everything platform-specific stays in the callers: backend I/O, the status
// bar, résumé bytes, stream controls, recording, banking.
//
// HARD BOUNDARY (every caller inherits it): never clicks Submit, never touches
// EEO/self-identification questions, never guesses salary / work-authorization
// / demographic answers. A *banked* answer — the human's own words — may fill a
// sensitive question; a machine-generated one may not.
(function (root) {
  "use strict";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const cleanLabel = (s) => (s || "").replace(/\s*\*?\s*$/, "").replace(/\s+/g, " ").trim();

  /** Never GUESSED by machine — but a banked (human-given) answer may fill them. */
  const SENSITIVE_RE =
    /sponsor|authoriz|visa|citizen|clearance|eligib|salar|compensation|relocat|pronoun|gender|race|ethnic|veteran|disabilit|identify/i;

  /** Protected-class questions: never answered by the machine, from any source. */
  const PROTECTED_RE =
    /gender|race\b|racial|ethnic|hispanic|latino|veteran|disabilit|self[- ]identif|sexual orientation|transgender/i;

  /** Contact-ish labels — already in the profile, not worth banking. */
  const NO_BANK_RE = /name|email|phone|linkedin|website|portfolio|github|location|city|resume|cover letter/i;

  const TEXT_INPUT_SELECTOR =
    "input[type=text], input[type=email], input[type=tel], input[type=url], input[type=number], textarea";

  const defaultHighlight = (el) => {
    el.style.outline = "2px solid #f0883e";
    el.style.outlineOffset = "2px";
  };
  const defaultUnhighlight = (el) => {
    el.style.outline = "";
    el.style.outlineOffset = "";
  };

  async function waitFor(fn, timeoutMs = 10000, everyMs = 300) {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(everyMs);
    }
  }

  /** Resolve once the DOM has had no mutations for `quietMs` (cap `maxMs`). */
  function quietDom(quietMs, maxMs) {
    return new Promise((resolve) => {
      let timer = setTimeout(done, quietMs);
      const cap = setTimeout(done, maxMs);
      const obs = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, quietMs);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      function done() {
        clearTimeout(timer);
        clearTimeout(cap);
        obs.disconnect();
        resolve();
      }
    });
  }

  function setValue(input, value) {
    if (input instanceof HTMLSelectElement) {
      const want = norm(value);
      const idx = [...input.options].findIndex(
        (opt) => norm(opt.text) === want || norm(opt.value) === want || norm(opt.text).includes(want)
      );
      if (idx < 0) return false;
      input.selectedIndex = idx;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (input.isContentEditable) {
      input.textContent = value;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
      return true;
    }
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  /** CSS.escape is missing in some embedded webviews; the fallback only has to
   *  survive the id characters an ATS actually emits. */
  const cssEscape = (s) =>
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");

  function labelTextFor(input) {
    if (input.labels && input.labels.length) return input.labels[0].textContent;
    const id = input.getAttribute("id");
    if (id) {
      const lab = document.querySelector(`label[for="${cssEscape(id)}"]`);
      if (lab) return lab.textContent;
    }
    if (input.getAttribute("aria-label")) return input.getAttribute("aria-label");
    const by = input.getAttribute("aria-labelledby");
    if (by) {
      const el = document.getElementById(by);
      if (el && el.textContent.trim()) return el.textContent;
    }
    // Walk up to the enclosing SINGLE-FIELD wrapper and use its label. Guarding on
    // "this container holds only this control" avoids grabbing the form's first
    // label. Needed for Ashby's geo-suggest combobox, which has no id/label link.
    let p = input.parentElement;
    for (let i = 0; p && i < 6; i++) {
      if (p.querySelectorAll("input, select, textarea").length <= 2) {
        const lab = p.querySelector("label, legend");
        if (lab && lab.textContent.trim()) return lab.textContent;
      }
      p = p.parentElement;
    }
    return "";
  }

  function inEeoSection(adapter, el) {
    // Guard on a NON-EMPTY id: some adapters use a never-match sentinel regex, and
    // /$^/ actually matches "" — which flagged every id-less control as EEO.
    if (el.id && adapter.eeoIdRe.test(el.id)) return true;
    let p = el.parentElement;
    for (let i = 0; p && i < 8; i++) {
      const heading = p.querySelector ? p.querySelector(":scope > h2, :scope > h3, :scope > legend") : null;
      if (heading && adapter.eeoSectionRe.test(heading.textContent || "")) return true;
      p = p.parentElement;
    }
    return false;
  }

  /**
   * Skip only genuinely protected questions. Judging by SECTION alone was wrong:
   * Ashby files neutral questions (e.g. "where do you permanently reside?") under
   * a demographic heading, and the blanket guard silently dropped them. A section
   * match now only blocks controls we cannot identify.
   */
  function isProtectedQuestion(adapter, el, label) {
    if (el.id && adapter.eeoIdRe.test(el.id)) return true;
    if (PROTECTED_RE.test(label)) return true;
    return !label && inEeoSection(adapter, el);
  }

  const isCombobox = (input) =>
    input.getAttribute("role") === "combobox" ||
    input.getAttribute("aria-autocomplete") === "list" ||
    !!input.closest("[class*='select__control'], [class*='select-shell']");

  // ---- value resolution -----------------------------------------------------
  /** Bank lookup with fuzzy fallback: banked "what are your pronouns" must match
   *  a field labeled just "Pronouns" (verified miss on a live form). Exact first; then
   *  containment either way with a length guard against trivial keys. */
  function bankFor(l, fields) {
    if (fields.answers[l] != null) return fields.answers[l];
    if (l.length < 4) return null;
    for (const [k, v] of Object.entries(fields.answers)) {
      if (k.length >= 4 && (k.includes(l) || l.includes(k))) return v;
    }
    return null;
  }

  /** Text value for a label, or null. Bank first (incl. sensitive — the human's
   *  own saved words); sensitive without bank → null; then heuristics. */
  function textValueFor(l, fields) {
    const bank = bankFor(l, fields);
    if (bank != null) return bank;
    if (SENSITIVE_RE.test(l)) return null;
    if (/^first name/.test(l)) return fields.firstName;
    if (/^last name/.test(l)) return fields.lastName;
    if (/preferred (first )?name/.test(l)) return fields.firstName;
    if (/full name|^name$/.test(l)) return fields.fullName;
    if (/email/.test(l)) return fields.email;
    if (/phone/.test(l)) return fields.phone;
    if (/linkedin/.test(l)) return fields.linkedinUrl;
    if (/website|portfolio|github/.test(l)) return fields.websiteUrl;
    if (/current (company|employer)|^(company|organization|org)$/.test(l)) return fields.currentCompany;
    if (/current (title|role|position)/.test(l)) return fields.currentTitle;
    if (/school|university|college/.test(l)) return fields.school || null;
    if (/degree/.test(l)) return fields.degree || null;
    if (/location|city/.test(l)) return fields.location;
    return null;
  }

  /** Contact chips the human can pick when a field's label is unknown or wrong. */
  function contactPresets(fields) {
    const f = fields || {};
    return [
      ["Name", f.fullName],
      ["First name", f.firstName],
      ["Last name", f.lastName],
      ["Email", f.email],
      ["Phone", f.phone],
      ["Location", f.location],
      ["LinkedIn", f.linkedinUrl],
      ["Website", f.websiteUrl],
      ["Company", f.currentCompany],
      ["Title", f.currentTitle],
      ["School", f.school],
      ["Degree", f.degree],
    ]
      .filter((row) => row[1] && String(row[1]).trim())
      .map(([label, value]) => ({ kind: "profile", label, value: String(value) }));
  }

  /**
   * Preset chips for a focused control. Protected/EEO labels return [].
   * `best` (label match) is first; then the rest of the profile; then banked
   * answers whose question overlaps this label.
   */
  function suggestChips(rawLabel, fields, limit) {
    const cap = limit == null ? 12 : limit;
    const l = norm(cleanLabel(rawLabel));
    if (l && PROTECTED_RE.test(l)) return [];
    const out = [];
    const seen = new Set();
    const push = (chip) => {
      const v = (chip.value || "").trim();
      if (!v) return;
      const k = norm(v);
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ kind: chip.kind, label: chip.label, value: v });
    };
    if (l) {
      const best = textValueFor(l, fields || { answers: {} });
      if (best) push({ kind: "best", label: "Suggested", value: best });
    }
    for (const c of contactPresets(fields)) push(c);
    const answers = (fields && fields.answers) || {};
    if (l) {
      const bank = bankFor(l, fields || { answers: {} });
      if (bank) push({ kind: "bank", label: "Saved answer", value: bank });
      for (const [k, v] of Object.entries(answers)) {
        if (k.length >= 4 && (k.includes(l) || l.includes(k))) {
          push({ kind: "bank", label: k.slice(0, 40), value: v });
        }
      }
    }
    return out.slice(0, cap);
  }

  function isFileInput(el) {
    return !!(el && el.tagName === "INPUT" && String(el.type || "").toLowerCase() === "file");
  }

  /** resume | cover | photo | null (not a file input). */
  function fileInputRole(input) {
    if (!isFileInput(input)) return null;
    const acc = String(input.accept || "").toLowerCase();
    if (acc && /image\//.test(acc) && !/pdf|msword|officedocument|\*/.test(acc)) return "photo";
    const lab = norm(
      cleanLabel(labelTextFor(input)) +
        " " +
        (input.name || "") +
        " " +
        (input.id || "") +
        " " +
        (input.getAttribute("aria-label") || "")
    );
    if (/cover/.test(lab)) return "cover";
    if (/photo|headshot|avatar|picture/.test(lab) && !/resume|cv\b/.test(lab)) return "photo";
    return "resume";
  }

  /**
   * Put a PDF on a file input via DataTransfer. Also fires a drop on the
   * nearest drop-zone (Workday et al). Returns "injected" | "unavailable".
   */
  function injectPdf(input, base64, filename) {
    if (!isFileInput(input) || input.disabled) return "unavailable";
    if (!base64) return "unavailable";
    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], filename || "resume.pdf", { type: "application/pdf" });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      try {
        const zone =
          input.closest("[class*='drop' i], [data-automation-id*='file'], [class*='upload' i]") || input.parentElement;
        if (zone && typeof DragEvent === "function") {
          const dt2 = new DataTransfer();
          dt2.items.add(file);
          zone.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt2 }));
        }
      } catch {
        /* drop-zone is best-effort — the file input assignment is the source of truth */
      }
      return input.files && input.files.length ? "injected" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  const CA_PROVINCES = {
    ON: "Ontario",
    BC: "British Columbia",
    AB: "Alberta",
    QC: "Quebec",
    MB: "Manitoba",
    SK: "Saskatchewan",
    NS: "Nova Scotia",
    NB: "New Brunswick",
  };
  function provinceCandidates(location) {
    for (const [ab, full] of Object.entries(CA_PROVINCES)) {
      if (new RegExp(`\\b${ab}\\b|${full}`, "i").test(location || "")) return [full];
    }
    return [];
  }

  /** Candidate option texts for a combobox; [] = human-only; null = ask the LLM. */
  function comboboxCandidates(l, fields) {
    const bank = bankFor(l, fields);
    if (bank != null) return [bank]; // banked answers fill even sensitive questions
    if (SENSITIVE_RE.test(l)) return [];
    if (/^country/.test(l)) return /canada/i.test(fields.location) ? ["Canada"] : [];
    // "State or Province" pickers want the province; "where do you reside"/city
    // pickers are geo-suggests wanting the full place string (Ashby
    // offers "City, Province, Country"). Try most-specific first.
    const city = (fields.location || "").split(",")[0].trim();
    if (/reside|location|city|based/.test(l)) {
      // City first: geo-suggests match a bare city far more reliably than a full
      // "City, ST, Country" string (verified on Ashby's residence picker).
      return [city, fields.location, ...provinceCandidates(fields.location)].filter(Boolean);
    }
    if (/state|province/.test(l)) return provinceCandidates(fields.location);
    if (/school|university|college/.test(l)) return fields.school ? [fields.school] : null;
    if (/degree/.test(l)) return fields.degree ? [fields.degree] : null;
    if (/how did you (first )?(hear|learn)|source/.test(l)) return ["Job Board", "LinkedIn", "Careers", "Other"];
    return null;
  }

  /** Free-text boxes that a tailored cover letter can seed a DRAFT into. */
  const FREE_TEXT_RE = /why|cover letter|tell us|interest|motivat/i;

  // ---- filling --------------------------------------------------------------
  /** Focus sequence + type-to-filter + option pick. Recipes verified live on
   *  Greenhouse and Ashby; commit on mousedown.
   *  Returns { ok, detail } — detail is a per-candidate account (dropdown state,
   *  option count, what was clicked, what stuck) so a failed fill names its own
   *  cause in the trace instead of a bare "✗". */
  async function fillCombobox(adapter, input, candidates, timing) {
    const t = timing || {};
    const settle = t.settle == null ? 300 : t.settle;
    const poll = t.poll == null ? 500 : t.poll;
    const commit = t.commit == null ? 400 : t.commit;
    const detail = [];
    for (const cand of candidates) {
      // A React re-render (résumé parse, async validation) can REPLACE the node
      // mid-interaction — typing into the detached one looks like "no options".
      // Bail so the verify pass retries against the fresh node.
      if (!input.isConnected) {
        detail.push(`"${cand}": STALE NODE (page re-rendered mid-fill)`);
        return { ok: false, detail };
      }
      input.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      input.click();
      await sleep(settle);
      setValue(input, cand);
      // Poll for options: geo-suggest lists hit a network and can take >1s.
      let target = null;
      let optCount = 0;
      for (let i = 0; i < 5 && !target; i++) {
        await sleep(poll);
        const opts = [...document.querySelectorAll(adapter.comboOptionSelector)].filter(
          (o) => o.getClientRects().length > 0
        );
        optCount = opts.length;
        target =
          opts.find((o) => norm(o.textContent) === norm(cand)) ||
          opts.find((o) => norm(o.textContent).includes(norm(cand))) ||
          (opts.length === 1 ? opts[0] : null);
      }
      if (target) {
        const optText = (target.textContent || "").trim();
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        target.click();
        await sleep(commit);
        // VERIFY against the CHOSEN OPTION's text. Checking "field is non-empty"
        // is worthless on Ashby: the text we typed satisfies it, so a failed
        // selection looked successful and then vanished on blur.
        const got = adapter.comboValue(input);
        if (got && (norm(got).includes(norm(optText)) || norm(optText).includes(norm(got)))) {
          detail.push(`"${cand}": ✓ committed "${optText}"`);
          return { ok: true, detail };
        }
        detail.push(`"${cand}": clicked "${optText}" but field kept "${got || ""}"`);
      } else {
        detail.push(`"${cand}": ${optCount} option(s), no match`);
      }
      setValue(input, "");
      input.blur();
      await sleep(250);
    }
    return { ok: false, detail };
  }

  /** The Ashby yes/no question text, minus the trailing "Yes No" button labels. */
  function yesNoLabel(container) {
    // NOT closest("div") — the yes/no container IS a div, which yields the label
    // "YesNo" instead of the question (observed live on Ashby).
    const entry = container.closest("[class*='fieldEntry']") || container.parentElement;
    const explicit = entry && entry.querySelector("label, legend");
    return cleanLabel(
      (explicit && explicit.textContent) ||
        ((entry && entry.textContent) || "").replace(/\s*yes\s*no\s*$/i, "").slice(0, 160)
    );
  }

  /**
   * Attach a résumé PDF to the form's file input from base64 bytes.
   * Returns "none" | "already" | "injected" | "unavailable".
   *
   * Assigning `input.files` from a DataTransfer is the only programmatic upload
   * path; it works in Chrome and in desktop Safari/Firefox, and is best-effort
   * on iOS — hence "unavailable" is a normal outcome the caller must surface
   * (the human then picks the file, which is why the backend also stages a
   * fixed-path copy).
   */
  async function attachResume(adapter, base64, settleMs) {
    const fileInput = document.querySelector(adapter.resumeSelector);
    if (!fileInput) return "none";
    if (fileInput.files && fileInput.files.length) return "already";
    if (!base64) return "unavailable";
    const result = injectPdf(fileInput, base64, "resume.pdf");
    await sleep(settleMs == null ? 1500 : settleMs);
    return result === "injected" && fileInput.files && fileInput.files.length ? "injected" : result;
  }

  /** Empty "why this company / tell us about you" boxes a cover letter can seed.
   *  Exposed so callers can skip fetching the letter when there are none. */
  function freeTextBoxes(adapter) {
    return [...document.querySelectorAll("textarea")].filter((t) => {
      const l = norm(cleanLabel(labelTextFor(t)));
      return !t.value.trim() && !isProtectedQuestion(adapter, t, l) && FREE_TEXT_RE.test(l);
    });
  }

  /**
   * Seed "why this company / tell us about you" boxes from the tailored cover
   * letter. Always a DRAFT: highlighted, and the human reads it before sending.
   */
  function draftFreeText(adapter, letter, opts) {
    const o = opts || {};
    const highlight = o.highlight || defaultHighlight;
    const engineFilled = o.engineFilled;
    if (!letter) return 0;
    let drafted = 0;
    for (const t of freeTextBoxes(adapter)) {
      const applied = letter.slice(0, Number(t.getAttribute("maxlength")) || 4000);
      setValue(t, applied);
      // Tracked so an untouched draft reads "engine" and an edited one
      // "human-edited" in the submit snapshot — both are useful signals.
      if (engineFilled) engineFilled.set(norm(cleanLabel(labelTextFor(t))), applied);
      highlight(t);
      drafted++;
    }
    return drafted;
  }

  /**
   * At the moment the human submits, capture every visible field's label +
   * value + who filled it (engine / human / human-edited / empty), diffed
   * against `engineFilled`. Protected/EEO questions are never captured.
   */
  function collectSnapshot(adapter, engineFilled) {
    const filled = engineFilled || new Map();
    const fields = [];
    const seen = new Set();
    const push = (el, rawLabel, value) => {
      const l = norm(rawLabel);
      if (!l || seen.has(l)) return;
      if (isProtectedQuestion(adapter, el, l)) return;
      seen.add(l);
      const v = (value || "").toString().trim().slice(0, 2000);
      const engineV = filled.get(l);
      const source = !v ? "empty" : engineV == null ? "human" : v === engineV ? "engine" : "human-edited";
      fields.push({ label: cleanLabel(rawLabel).slice(0, 200), value: v, source });
    };
    for (const input of document.querySelectorAll(TEXT_INPUT_SELECTOR)) {
      if (input.closest("[aria-hidden=true]")) continue;
      push(input, cleanLabel(labelTextFor(input)), isCombobox(input) ? adapter.comboValue(input) : input.value);
    }
    for (const sel of document.querySelectorAll("select")) {
      push(sel, cleanLabel(labelTextFor(sel)), sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text : "");
    }
    if (adapter.yesNoSelector) {
      for (const c of document.querySelectorAll(adapter.yesNoSelector)) {
        const pressed = [...c.querySelectorAll("button")].find((b) => b.getAttribute("aria-pressed") === "true");
        const cb = c.querySelector("input[type=checkbox]");
        push(c, yesNoLabel(c), pressed ? pressed.textContent : cb && cb.checked ? "Yes" : "");
      }
    }
    return fields;
  }

  /** From a snapshot, the answers worth banking: the human's own words only. */
  function bankableAnswers(snapshot) {
    const answers = {};
    for (const f of snapshot) {
      if ((f.source === "human" || f.source === "human-edited") && f.label.length >= 8 && !NO_BANK_RE.test(f.label)) {
        answers[f.label] = f.value;
      }
    }
    return answers;
  }

  /** Submitted = confirmation text present AND the form is gone. The form-gone
   *  guard keeps a "thank you for your interest" phrase inside a JD from ever
   *  counting as a submission. */
  function looksSubmitted(adapter) {
    const text = document.body.innerText || document.body.textContent || "";
    return adapter.confirmationRe.test(text.slice(0, 20000)) && !document.querySelector(adapter.formSelector);
  }

  /**
   * Build the fill pass for one form. `pass()` is re-runnable: React re-renders
   * (résumé upload, async validation) silently revert values, so callers run it
   * again to verify. It returns the still-unanswered controls, each tagged with
   * whether an LLM may be asked (`askLlm`) — sensitive ones never may.
   */
  function createFiller(adapter, fields, opts) {
    const o = opts || {};
    const highlight = o.highlight || defaultHighlight;
    const unhighlight = o.unhighlight || defaultUnhighlight;
    const timing = o.timing || {};
    const engineFilled = new Map();
    const verifiedCombos = new Set();
    const trace = [];
    let passIndex = 0;

    /** Per-control decision log, mirrored to document.documentElement.dataset so a
     *  silent skip can always be diagnosed from the page without a rebuild. */
    const logDecision = (label, decision) => {
      trace.push(`${label || "?"} → ${decision}`);
      try {
        document.documentElement.dataset.jcApplyTrace = trace.slice(-40).join(" | ");
      } catch {
        /* ignore */
      }
    };

    /** Ashby-style Yes/No: two <button> options + hidden checkbox. Click the button
     *  matching the banked answer; never synthesize an answer. */
    async function fillYesNo(container, unanswered) {
      const rawLabel = yesNoLabel(container);
      const l = norm(rawLabel);
      const cb = container.querySelector("input[type=checkbox]");
      const buttons = [...container.querySelectorAll("button")];
      if (!buttons.length) return;
      const pressed = buttons.some((b) => b.getAttribute("aria-pressed") === "true") || (cb && cb.checked);
      if (pressed) return;
      const bank = bankFor(l, fields);
      if (bank == null) {
        unanswered.push({
          label: `${rawLabel}${SENSITIVE_RE.test(l) ? " (yours to answer)" : ""}`,
          el: container,
          askLlm: !SENSITIVE_RE.test(l),
        });
        highlight(container);
        return;
      }
      const target = buttons.find((b) => norm(b.textContent) === norm(bank));
      if (target) {
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        target.click();
        await sleep(timing.commit == null ? 300 : timing.commit);
        engineFilled.set(l, (target.textContent || "").trim());
        unhighlight(container);
      } else {
        unanswered.push({ label: rawLabel, el: container, askLlm: false });
        highlight(container);
      }
    }

    async function pass() {
      const isFirstPass = passIndex++ === 0;
      const unanswered = [];
      // 1. plain text fields
      for (const input of document.querySelectorAll(TEXT_INPUT_SELECTOR)) {
        if (input.closest("[aria-hidden=true]")) continue;
        if (input.value && input.value.trim()) continue;
        if (isCombobox(input)) continue;
        const rawLabel = cleanLabel(labelTextFor(input));
        const l = norm(rawLabel);
        if (isProtectedQuestion(adapter, input, l)) {
          logDecision(rawLabel, "text skip: protected");
          continue;
        }
        const v = textValueFor(l, fields);
        if (v) {
          const applied = v.slice(0, Number(input.getAttribute("maxlength")) || 500);
          setValue(input, applied);
          engineFilled.set(l, applied);
          unhighlight(input);
        } else if (input.required || input.getAttribute("aria-required") === "true") {
          unanswered.push({
            label: `${rawLabel || "unlabeled field"}${SENSITIVE_RE.test(l) ? " (yours to answer)" : ""}`,
            el: input,
            askLlm: !SENSITIVE_RE.test(l),
          });
          highlight(input);
        }
      }
      // 2. comboboxes
      for (const input of document.querySelectorAll("input")) {
        if (!isCombobox(input)) continue;
        if (adapter.phoneFlyoutRe.test(input.className || "")) continue;
        // Treat as answered only if WE verified the selection, or it already had a
        // value before we touched anything (pre-filled by the ATS).
        if (verifiedCombos.has(input)) continue;
        if (isFirstPass && adapter.comboValue(input)) {
          logDecision(cleanLabel(labelTextFor(input)), `combo skip: pre-filled "${adapter.comboValue(input)}"`);
          continue;
        }
        const rawLabel = cleanLabel(labelTextFor(input));
        const l = norm(rawLabel);
        if (isProtectedQuestion(adapter, input, l)) {
          logDecision(rawLabel, "combo skip: protected");
          continue;
        }
        if (!l) {
          // Fail loud: an unlabeled empty combobox used to be skipped silently and
          // then reported as "all fields filled" (observed on Ashby's residence field).
          unanswered.push({ label: "unlabeled dropdown", el: input, askLlm: false });
          highlight(input);
          continue;
        }
        const candidates = comboboxCandidates(l, fields);
        if (candidates === null || (candidates.length === 0 && !SENSITIVE_RE.test(l))) {
          unanswered.push({ label: rawLabel, el: input, askLlm: true });
          highlight(input);
          continue;
        }
        if (candidates.length === 0) {
          highlight(input);
          unanswered.push({ label: `${rawLabel} (yours to answer)`, el: input, askLlm: false });
          continue;
        }
        const comboRes = await fillCombobox(adapter, input, candidates, timing);
        if (comboRes.ok) {
          verifiedCombos.add(input);
          engineFilled.set(l, adapter.comboValue(input) || "");
          unhighlight(input);
          logDecision(rawLabel, `combo ✓ ${adapter.comboValue(input)}`);
        } else {
          unanswered.push({ label: rawLabel, el: input, askLlm: true });
          highlight(input);
          logDecision(rawLabel, `combo ✗ ${comboRes.detail.join("; ")}`);
        }
      }
      // 3. yes/no button pairs (Ashby)
      if (adapter.yesNoSelector) {
        for (const container of document.querySelectorAll(adapter.yesNoSelector)) {
          await fillYesNo(container, unanswered);
        }
      }
      // 4. native selects: bank-only
      for (const sel of document.querySelectorAll("select")) {
        if (sel.value) continue;
        const rawLabel = cleanLabel(labelTextFor(sel));
        if (isProtectedQuestion(adapter, sel, norm(rawLabel))) {
          logDecision(rawLabel, "select skip: protected");
          continue;
        }
        const bank = fields.answers[norm(rawLabel)];
        if (bank != null) {
          const idx = [...sel.options].findIndex(
            (opt) => norm(opt.text) === norm(bank) || norm(opt.text).includes(norm(bank))
          );
          if (idx >= 0) {
            sel.selectedIndex = idx;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            engineFilled.set(norm(rawLabel), sel.options[idx].text.trim());
            continue;
          }
        }
        if (sel.required || sel.getAttribute("aria-required") === "true") {
          unanswered.push({
            label: rawLabel || "unlabeled select",
            el: sel,
            askLlm: !SENSITIVE_RE.test(norm(rawLabel)),
          });
          highlight(sel);
        }
      }
      return unanswered;
    }

    /** Merge LLM/on-demand answers into the bank this filler resolves against. */
    function mergeAnswers(answers) {
      let any = false;
      for (const [q, a] of Object.entries(answers || {})) {
        if (a != null) {
          fields.answers[norm(q)] = a;
          any = true;
        }
      }
      return any;
    }

    return { pass, mergeAnswers, logDecision, engineFilled, verifiedCombos, trace };
  }

  root.JC_APPLY_CORE = {
    // primitives
    sleep,
    norm,
    cleanLabel,
    waitFor,
    quietDom,
    setValue,
    // detection
    TEXT_INPUT_SELECTOR,
    SENSITIVE_RE,
    PROTECTED_RE,
    NO_BANK_RE,
    FREE_TEXT_RE,
    labelTextFor,
    yesNoLabel,
    isCombobox,
    inEeoSection,
    isProtectedQuestion,
    // value resolution
    bankFor,
    textValueFor,
    contactPresets,
    suggestChips,
    comboboxCandidates,
    provinceCandidates,
    // filling
    createFiller,
    fillCombobox,
    isFileInput,
    fileInputRole,
    injectPdf,
    attachResume,
    freeTextBoxes,
    draftFreeText,
    // submit-time
    collectSnapshot,
    bankableAnswers,
    looksSubmitted,
    // theming hooks
    defaultHighlight,
    defaultUnhighlight,
  };
})(typeof window !== "undefined" ? window : globalThis);
