// Copilot page scanner — injected via chrome.scripting.executeScript with
// allFrames:true into ANY site (Workday, LinkedIn wizard frames, custom career
// pages). Self-contained IIFE: its final expression is this frame's question
// list; elements are stashed in window.__jcScanEls so a later fill injection
// can address them by index (isolated world persists per frame).
(() => {
  const cleanLabel = (s) => (s || "").replace(/\s*\*?\s*$/, "").replace(/\s+/g, " ").trim();
  // Protected-class questions never leave the page — not in scan results, not
  // in step snapshots. Only a count is reported.
  const PROTECTED_RE =
    /gender|race\b|racial|ethnic|hispanic|latino|veteran|disabilit|self[- ]identif|sexual orientation|transgender/i;
  let protectedCount = 0;

  function labelTextFor(input) {
    if (input.labels && input.labels.length) return input.labels[0].textContent;
    const id = input.getAttribute("id");
    if (id) {
      try {
        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lab) return lab.textContent;
      } catch {
        /* ignore bad ids */
      }
    }
    if (input.getAttribute("aria-label")) return input.getAttribute("aria-label");
    const by = input.getAttribute("aria-labelledby");
    if (by) {
      const el = document.getElementById(by.split(/\s+/)[0]);
      if (el && el.textContent.trim()) return el.textContent;
    }
    // Wrapper walk: nearest container holding only this control + a label-ish node.
    let p = input.parentElement;
    for (let i = 0; p && i < 6; i++) {
      if (p.querySelectorAll("input, select, textarea").length <= 2) {
        const lab = p.querySelector("label, legend");
        if (lab && lab.textContent.trim()) return lab.textContent;
      }
      p = p.parentElement;
    }
    return input.getAttribute("placeholder") || "";
  }

  const visible = (el) => {
    if (!el.isConnected) return false;
    if (el.closest("[aria-hidden=true]")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const els = [];
  const out = [];
  const seenLabels = new Set();

  const push = (el, type, extra) => {
    const rawLabel = cleanLabel(labelTextFor(el));
    if (!rawLabel) return;
    if (PROTECTED_RE.test(rawLabel)) {
      protectedCount++;
      return;
    }
    const key = rawLabel.toLowerCase();
    if (seenLabels.has(key)) return;
    seenLabels.add(key);
    const idx = els.push(el) - 1;
    out.push({
      idx,
      label: rawLabel.slice(0, 250),
      type,
      value: (extra && extra.value) || "",
      required: el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(labelTextFor(el) || ""),
      options: (extra && extra.options) || undefined,
    });
  };

  for (const input of document.querySelectorAll(
    "input[type=text], input[type=email], input[type=tel], input[type=url], input[type=number], input:not([type]), textarea"
  )) {
    if (!visible(input)) continue;
    const isCombo =
      input.getAttribute("role") === "combobox" || input.getAttribute("aria-autocomplete") === "list";
    push(input, input.tagName === "TEXTAREA" ? "textarea" : isCombo ? "combobox" : "text", {
      value: input.value || "",
    });
  }

  for (const sel of document.querySelectorAll("select")) {
    if (!visible(sel)) continue;
    push(sel, "select", {
      value: sel.selectedIndex >= 0 ? (sel.options[sel.selectedIndex].text || "").trim() : "",
      options: [...sel.options].map((o) => (o.text || "").trim()).filter(Boolean).slice(0, 60),
    });
  }

  // Radio / checkbox groups: one entry per group (name), options = labels.
  const groups = new Map();
  for (const r of document.querySelectorAll("input[type=radio], input[type=checkbox]")) {
    if (!visible(r)) continue;
    const g = r.name || r.id || "";
    if (!g) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  for (const members of groups.values()) {
    const first = members[0];
    // Group label: fieldset legend or wrapper walk from the first member.
    const fs = first.closest("fieldset");
    const groupLabel = cleanLabel(
      (fs && fs.querySelector("legend") && fs.querySelector("legend").textContent) || labelTextFor(first)
    );
    if (!groupLabel) continue;
    if (PROTECTED_RE.test(groupLabel)) {
      protectedCount++;
      continue;
    }
    const key = groupLabel.toLowerCase();
    if (seenLabels.has(key)) continue;
    seenLabels.add(key);
    const idx = els.push(members) - 1; // stash the ARRAY of members
    const optLabel = (m) =>
      cleanLabel((m.labels && m.labels[0] && m.labels[0].textContent) || m.value || "");
    out.push({
      idx,
      label: groupLabel.slice(0, 250),
      type: first.type === "radio" ? "radio" : "checkbox",
      value: optLabel(members.find((m) => m.checked) || {}) || "",
      required: members.some((m) => m.required),
      options: members.map(optLabel).filter(Boolean).slice(0, 30),
    });
  }

  const files = [...document.querySelectorAll("input[type=file]")].filter(
    (f) => f.isConnected && !f.closest("[aria-hidden=true]")
  );

  window.__jcScanEls = els;
  window.__jcScanMeta = out; // labels/types by idx — read back by the step observer

  // ---- step observer (installed once per frame) -----------------------------
  // Multi-step wizards (LinkedIn Easy Apply, Workday) unmount a step's fields
  // when the human clicks Next — a submit-time snapshot loses everything before
  // the last step. So: on any step-advancing click, capture the CURRENT values
  // of the scanned controls and report them (STEP_SNAPSHOT) before they vanish.
  // The worker reconciles them against the panel's recommendations and banks
  // the human's own answers.
  if (!window.__jcStepObserver) {
    window.__jcStepObserver = true;
    let lastAt = 0;
    const currentValue = (el) => {
      if (Array.isArray(el)) {
        const hit = el.find((m) => m.isConnected && m.checked);
        return hit ? cleanLabel((hit.labels && hit.labels[0] && hit.labels[0].textContent) || hit.value || "") : "";
      }
      if (!el.isConnected) return null; // stale — a later scan owns this step
      if (el.tagName === "SELECT") {
        return el.selectedIndex >= 0 ? (el.options[el.selectedIndex].text || "").trim() : "";
      }
      return el.value || "";
    };
    document.addEventListener(
      "click",
      (e) => {
        const b = e.target && e.target.closest ? e.target.closest("button, input[type=submit]") : null;
        if (!b) return;
        const txt = `${b.getAttribute("aria-label") || ""} ${b.textContent || b.value || ""}`;
        // Structural (type=submit) OR text match — language-proof either way.
        if (b.type !== "submit" && !/next|continue|review|submit/i.test(txt)) return;
        const now = Date.now();
        if (now - lastAt < 4000) return; // validation-failure re-click burst
        lastAt = now;
        const fields = [];
        const els2 = window.__jcScanEls || [];
        const meta = window.__jcScanMeta || [];
        for (const q of meta) {
          const v = currentValue(els2[q.idx]);
          if (v == null) continue;
          fields.push({ label: q.label, value: String(v).slice(0, 2000) });
        }
        if (!fields.length) return;
        try {
          chrome.runtime.sendMessage({
            type: "STEP_SNAPSHOT",
            payload: { jobId: window.__jcJobId || null, url: location.href.slice(0, 200), fields },
          });
        } catch {
          /* extension reloaded — nothing to do */
        }
      },
      true
    );
  }

  return { questions: out, fileInputs: files.length, protectedCount, url: location.href.slice(0, 200) };
})();
