// Easy Apply assist — activates ONLY when the dashboard opens a LinkedIn job with
// #jh-apply=<backendJobId> (the "Approve" button). Auto-clicks Easy Apply, fills
// the wizard from the backend profile (contact fields + screening-answer bank),
// injects the tailored resume PDF, and advances to the Review step.
//
// HARD BOUNDARY: this script NEVER clicks "Submit application". The human reviews
// and submits; the script watches for LinkedIn's confirmation and only then
// records the application in the backend.
(() => {
  // LinkedIn's newer UI renders the Easy Apply wizard inside a same-origin
  // /preload/ iframe — this script runs BOTH in the top job page and inside that
  // frame (manifest all_frames entry). The #jh-apply hash lives on the top window.
  const IN_FRAME = window !== window.top;
  let topHash = "";
  try { topHash = window.top.location.hash; } catch { /* cross-origin frame — not ours */ }
  const m = (IN_FRAME ? topHash : location.hash).match(/jh-apply=([a-z0-9]+)/i);
  if (!m) return;
  const jobId = m[1];
  const API = "http://127.0.0.1:8787";
  const SUBMIT_RE = /submit application/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

  // ---- status overlay -------------------------------------------------------
  const bar = document.createElement("div");
  bar.id = "jc-easyapply-bar";
  bar.style.cssText =
    "position:fixed;bottom:16px;left:16px;z-index:99999;background:#1f2328;color:#e6edf3;" +
    "padding:10px 14px;border-radius:8px;font:13px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:420px";
  // Status is its own node so the minimize button survives updates; "–" collapses
  // the bar to a pill when it covers wizard fields.
  const statusEl = document.createElement("div");
  statusEl.style.cssText = "padding-right:16px";
  const minBtn = document.createElement("button");
  minBtn.textContent = "–";
  minBtn.title = "Minimize — collapses to a pill; click the pill to restore";
  minBtn.style.cssText =
    "position:absolute;top:2px;right:4px;background:none;border:none;color:#8b949e;" +
    "font:16px/1 system-ui;cursor:pointer;padding:2px 6px";
  const pill = document.createElement("div");
  pill.textContent = "🤖";
  pill.title = "Easy Apply assist (minimized) — click to expand";
  pill.style.cssText =
    "display:none;position:fixed;bottom:16px;left:16px;z-index:99999;background:#1f2328;" +
    "padding:8px 10px;border-radius:999px;font:15px/1 system-ui;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.4);cursor:pointer";
  minBtn.addEventListener("click", () => { bar.style.display = "none"; pill.style.display = "block"; });
  pill.addEventListener("click", () => { pill.style.display = "none"; bar.style.display = "block"; });
  bar.style.position = "fixed";
  bar.append(statusEl, minBtn);
  const setStatus = (html) => { statusEl.innerHTML = "🤖 Easy Apply assist — " + html; };
  document.body.appendChild(bar);
  document.body.appendChild(pill);
  setStatus("starting…");

  const highlight = (el) => { el.style.outline = "2px solid #f0883e"; el.style.outlineOffset = "2px"; };
  const unhighlight = (el) => { el.style.outline = ""; el.style.outlineOffset = ""; };

  // ---- generic helpers ------------------------------------------------------
  async function waitFor(fn, timeoutMs = 10000, everyMs = 300) {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(everyMs);
    }
  }

  function visible(el) {
    // NOT offsetParent: it is always null for position:fixed elements — which is
    // exactly what LinkedIn's Easy Apply modal is (caused "wizard closed" v0.2.0).
    if (!el) return false;
    return el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0;
  }

  /** Set an input's value the React-compatible way. */
  function setValue(input, value) {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function labelTextFor(input, scope) {
    if (input.labels && input.labels.length) return input.labels[0].textContent;
    const id = input.getAttribute("id");
    if (id) {
      const lab = scope.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lab) return lab.textContent;
    }
    const grouping = input.closest("[class*='form-section__grouping'], [class*='form-element'], fieldset, div");
    return grouping ? (grouping.querySelector("label, legend, span[aria-hidden=true]")?.textContent ?? "") : "";
  }

  // ---- field filling --------------------------------------------------------
  function fillTextInput(input, label, fields, unanswered) {
    if (input.value && input.value.trim()) return; // never overwrite LinkedIn's prefill
    const l = norm(label);
    const bank = fields.answers[l];
    let v = null;
    if (bank != null) v = bank;
    else if (/mobile phone|phone number|^phone/.test(l)) v = fields.phone;
    else if (/first name/.test(l)) v = fields.firstName;
    else if (/last name/.test(l)) v = fields.lastName;
    else if (/full name|^name$/.test(l)) v = fields.fullName;
    else if (/city|location/.test(l) && input.getAttribute("type") !== "file") v = fields.location;
    else if (/linkedin/.test(l)) v = fields.linkedinUrl;
    else if (/website|portfolio|github/.test(l)) v = fields.websiteUrl;
    else if (/email/.test(l)) v = fields.email;
    if (v) { setValue(input, v.slice(0, Number(input.getAttribute("maxlength")) || 200)); unhighlight(input); }
    else if (input.required || input.getAttribute("aria-required") === "true") {
      unanswered.push({ label: label.trim() || "unlabeled field", el: input });
      highlight(input);
    }
  }

  function fillSelect(sel, label, fields, unanswered) {
    const l = norm(label);
    const options = [...sel.options].map((o) => o.text);
    const pick = (pred) => {
      const idx = options.findIndex(pred);
      if (idx >= 0 && sel.selectedIndex !== idx) {
        sel.selectedIndex = idx;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return idx >= 0;
    };
    // Already has a real selection (LinkedIn defaults email/phone country) → leave it.
    if (sel.selectedIndex > 0 && !/select an option/i.test(options[sel.selectedIndex] || "")) return;
    const bank = fields.answers[l];
    if (bank != null && pick((t) => norm(t) === norm(bank) || norm(t).includes(norm(bank)))) { unhighlight(sel); return; }
    if (/email/.test(l) && fields.email && pick((t) => t.toLowerCase().includes(fields.email.toLowerCase()))) return;
    if (/phone country|country code/.test(l) && pick((t) => /canada|\+1\b/i.test(t))) return;
    unanswered.push({ label: label.trim() || "unlabeled select", el: sel });
    highlight(sel);
  }

  function fillRadios(fieldset, fields, unanswered) {
    const legend = fieldset.querySelector("legend")?.textContent ?? "";
    const radios = [...fieldset.querySelectorAll("input[type=radio]")];
    if (!radios.length || radios.some((r) => r.checked)) return;
    const bank = fields.answers[norm(legend)];
    if (bank == null) {
      unanswered.push({ label: legend.trim() || "unlabeled choice", el: fieldset });
      highlight(fieldset);
      return;
    }
    const target = radios.find((r) => {
      const lab = labelTextFor(r, fieldset);
      return norm(lab) === norm(bank) || norm(lab).includes(norm(bank));
    });
    if (target) { target.click(); unhighlight(fieldset); }
    else { unanswered.push({ label: legend.trim(), el: fieldset }); highlight(fieldset); }
  }

  async function injectResume(modal) {
    const fileInput = modal.querySelector("input[type=file]");
    if (!fileInput) return "none";
    try {
      const resp = await fetch(`${API}/jobs/${jobId}/resume/file?format=pdf`);
      if (!resp.ok) return "unavailable";
      const blob = await resp.blob();
      const file = new File([blob], "resume.pdf", { type: "application/pdf" });
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(1500); // let LinkedIn process the upload
      return "injected";
    } catch {
      return "unavailable";
    }
  }

  function findModal() {
    // In the /preload/ wizard frame, the whole document IS the wizard — treat the
    // body as the modal once it has real form content.
    if (IN_FRAME) {
      // The /preload/ host also serves other overlays (AI guide chat) — only claim
      // the document when it actually looks like the apply wizard.
      const looksLikeWizard =
        /apply to|contact info|additional questions|review your application|upload resume/i.test(
          (document.body?.innerText || "").slice(0, 4000)
        );
      return looksLikeWizard && document.querySelector("input, select, fieldset") ? document.body : null;
    }
    return (
      [...document.querySelectorAll("div[role=dialog], .jobs-easy-apply-modal, dialog")].find(visible) ?? null
    );
  }

  /** Top-page signal that the new-UI wizard opened in its iframe. */
  function wizardFrameOpen() {
    return [...document.querySelectorAll("iframe")].some((f) => {
      const r = f.getBoundingClientRect();
      return r.width > 500 && r.height > 400 && /\/preload\//.test(f.src || "");
    });
  }

  function buttonIn(modal, re) {
    return [...modal.querySelectorAll("button")].find(
      (b) => visible(b) && (re.test(b.getAttribute("aria-label") || "") || re.test(b.textContent || ""))
    );
  }

  function hasErrors(modal) {
    return !!modal.querySelector("[class*='inline-feedback--error']");
  }

  // ---- submission watcher (records AFTER the human submits) -----------------
  let recorded = false;
  async function recordApplied() {
    if (recorded) return;
    recorded = true;
    try {
      await fetch(`${API}/jobs/${jobId}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: `LinkedIn Easy Apply via assist · ${new Date().toISOString().slice(0, 10)}` }),
      });
      setStatus("✅ submitted — recorded in Job Hunt Assistant. You can close this tab.");
    } catch {
      setStatus("✅ submitted — but recording failed (backend down?). Mark applied on the dashboard.");
    }
  }

  function watchForConfirmation() {
    const obs = new MutationObserver(() => {
      const t = document.body.innerText;
      if (/application sent|your application was sent/i.test(t.slice(0, 20000))) {
        obs.disconnect();
        void recordApplied();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // The wizard frame can be torn down the instant the human clicks Submit —
    // before any confirmation text renders. Track the trusted submit click and
    // record on pagehide with keepalive as the fallback path.
    let submitClicked = false;
    document.addEventListener(
      "click",
      (e) => {
        const b = e.target && e.target.closest ? e.target.closest("button") : null;
        if (b && SUBMIT_RE.test(`${b.getAttribute("aria-label") || ""} ${b.textContent || ""}`)) {
          submitClicked = true;
        }
      },
      true
    );
    window.addEventListener("pagehide", () => {
      if (submitClicked && !recorded) {
        recorded = true;
        void fetch(`${API}/jobs/${jobId}/apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: `LinkedIn Easy Apply via assist · ${new Date().toISOString().slice(0, 10)}` }),
          keepalive: true,
        });
      }
    });
  }

  // ---- main flow ------------------------------------------------------------
  async function run() {
    let fields;
    try {
      fields = await (await fetch(`${API}/profile/apply-fields`)).json();
    } catch {
      setStatus("⚠ backend not reachable at 127.0.0.1:8787 — fill manually.");
      return;
    }

    if (IN_FRAME) {
      // We ARE the wizard frame (possibly loaded before the human clicks Easy
      // Apply) — wait for real wizard content, then fill.
      setStatus("waiting for the wizard…");
      const opened = await waitFor(findModal, 180000, 400);
      if (!opened) return; // never became the apply wizard (other overlay) — stay silent
      setStatus("wizard detected — taking over.");
    } else {
      setStatus("looking for the Easy Apply button…");
      const applyBtn = await waitFor(() =>
        [...document.querySelectorAll("button")].find(
          (b) => visible(b) && /easy apply/i.test(b.textContent || "") && !/applied/i.test(b.textContent || "")
        )
      );
      if (!applyBtn) {
        setStatus("no Easy Apply button found (external apply or already applied) — continuing manually.");
        return;
      }
      // Try once — works on some listings; LinkedIn's newer UI gates the wizard-open
      // on trusted (real-human) events and ignores synthetic clicks entirely.
      const openedNow = () => findModal() || (wizardFrameOpen() ? "frame" : null);
      applyBtn.click();
      let opened = await waitFor(openedNow, 4000, 300);
      if (!opened) {
        highlight(applyBtn);
        setStatus("LinkedIn wants a real click here — click <b>Easy Apply</b> and I'll take over from there.");
        opened = await waitFor(openedNow, 180000, 400);
        if (!opened) {
          setStatus("gave up waiting for the wizard (3 min) — re-run from the dashboard when ready.");
          return;
        }
        unhighlight(applyBtn);
      }
      if (opened === "frame") {
        // New-UI wizard renders in its own /preload/ iframe — the copy of this
        // script inside that frame does the filling and the recording.
        setStatus("wizard opened — the in-frame assist is filling it.");
        return;
      }
    }

    /** One deterministic fill pass over the current step; returns [{label, el}]. */
    const fillPass = (modal) => {
      const unanswered = [];
      for (const fs of modal.querySelectorAll("fieldset")) fillRadios(fs, fields, unanswered);
      for (const sel of modal.querySelectorAll("select")) {
        if (visible(sel)) fillSelect(sel, labelTextFor(sel, modal), fields, unanswered);
      }
      for (const input of modal.querySelectorAll("input[type=text],input[type=tel],input[type=email],input[type=number],textarea")) {
        if (visible(input)) fillTextInput(input, labelTextFor(input, modal), fields, unanswered);
      }
      return unanswered;
    };

    /** Ask DeepSeek (backend) about questions the bank couldn't answer; merges
     *  non-null answers into fields.answers (server also banks them for next time). */
    const llmPass = async (unanswered) => {
      const questions = [...new Set(unanswered.map((u) => u.label).filter(Boolean))];
      if (!questions.length) return false;
      setStatus(`thinking about ${questions.length} screening question(s) (DeepSeek)…`);
      try {
        const resp = await fetch(`${API}/profile/answer-screening`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questions }),
        });
        if (!resp.ok) return false;
        const { answers } = await resp.json();
        let any = false;
        for (const [q, a] of Object.entries(answers)) {
          if (a != null) { fields.answers[norm(q)] = a; any = true; }
        }
        return any;
      } catch { return false; }
    };

    let resumeState = "none";
    for (let step = 0; step < 12; step++) {
      await sleep(1000);
      // The modal renders async (and the first open can be slow) — wait, don't peek.
      const modal = await waitFor(findModal, step === 0 ? 15000 : 6000, 300);
      if (!modal) {
        setStatus(
          step === 0
            ? "the wizard didn't open — click Easy Apply yourself and re-run from the dashboard if needed."
            : "wizard closed — stopping. (If you submitted, I recorded it; otherwise re-run from the dashboard.)"
        );
        return;
      }

      // Deterministic pass (bank + contact heuristics); anything left goes to the
      // LLM once, then a refill pass. Only still-null questions pause the flow.
      let unanswered = fillPass(modal);
      if (unanswered.length && (await llmPass(unanswered))) {
        unanswered = fillPass(modal);
      }
      if (resumeState === "none") resumeState = await injectResume(modal);

      // At the review step? Stop — the submit click belongs to the human.
      const submitBtn = buttonIn(modal, SUBMIT_RE);
      if (submitBtn) {
        highlight(submitBtn);
        const notes = [
          resumeState === "injected" ? "tailored résumé attached" : resumeState === "unavailable" ? "⚠ résumé injection failed — check the attached file" : null,
          unanswered.length ? `⚠ answer the highlighted: ${[...new Set(unanswered.map((u) => u.label))].slice(0, 4).join("; ")}` : "all fields filled",
        ].filter(Boolean).join(" · ");
        setStatus(`ready for YOUR review — ${notes}. Click <b>Submit application</b> yourself; I'll record it.`);
        watchForConfirmation();
        return;
      }

      // Human-only questions remain (salary/visa/etc. or LLM couldn't ground an
      // answer) — pause HERE instead of click-looping into LinkedIn's error state.
      if (unanswered.length) {
        setStatus(
          `⏸ needs you: ${[...new Set(unanswered.map((u) => u.label))].slice(0, 3).join("; ")} — answer the highlighted, then keep clicking Next; I'll record after you submit.`
        );
        watchForConfirmation();
        return;
      }

      const nextBtn = buttonIn(modal, /continue to next step|next|review your application|review/i);
      if (!nextBtn || SUBMIT_RE.test(nextBtn.getAttribute("aria-label") || "") || SUBMIT_RE.test(nextBtn.textContent || "")) {
        setStatus("can't find a safe Next button — finish the remaining steps yourself; I'll still record after you submit.");
        watchForConfirmation();
        return;
      }
      setStatus(`step ${step + 1} filled — advancing…`);
      nextBtn.click();
      await sleep(700);
      const after = findModal();
      if (after && hasErrors(after)) {
        setStatus("⚠ this step needs you (LinkedIn flagged required fields). Finish + submit yourself; I'll record it.");
        watchForConfirmation();
        return;
      }
    }
    setStatus("wizard longer than expected — finish the rest yourself; I'll record after you submit.");
    watchForConfirmation();
  }

  void run();
})();
