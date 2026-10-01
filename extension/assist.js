// In-page field helper — rides with the human through login walls, Next
// buttons, and custom career pages. It does NOT auto-advance, create
// accounts, solve CAPTCHAs, or click Submit.
//
// On focus of a text box: a preset dropdown (profile + banked answers).
// On click of a résumé upload: attach this job's tailored PDF.
//
// Surfaces:
//   • Chrome content script (GH/Ashby/Lever by default; any site after the
//     popup toggle or the context-menu "presets on this page")
//   • Phone fill-script (fillDriver calls JC_APPLY_ASSIST.mount)
(function (root) {
  "use strict";
  if (root.__JH_ASSIST_LOADED) return;
  root.__JH_ASSIST_LOADED = true;

  const core = root.JC_APPLY_CORE;
  const SKIP_TYPES = /^(password|hidden|submit|button|reset|checkbox|radio|range|color|file|image|week|month|time|datetime-local)$/i;
  const UPLOAD_RE = /\b(resume|cv|curriculum|upload|attach|drop files?|choose file|browse)\b/i;

  let ctx = null; // { fields, jobId, title, company, resumeReady, fetchResume, resumeBase64, resumeFilename }
  let host = null;
  let shadow = null;
  let menu = null;
  let toastEl = null;
  let pill = null;
  let activeEl = null;
  let hideTimer = null;
  let resumeBusy = false;

  function bg(type, payload, timeoutMs) {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve({ ok: false, error: "no-extension" });
        return;
      }
      let done = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs || 20000);
      try {
        chrome.runtime.sendMessage({ type, payload }, (resp) => {
          if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
          else finish(resp || { ok: false, error: "no response" });
        });
      } catch (e) {
        finish({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  function ensureUi() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = "jh-assist-host";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483646;pointer-events:none";
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .pill {
        pointer-events: auto; position: fixed; top: 12px; right: 12px;
        background: rgba(28,28,30,.92); color: #f5f5f7; font: 12px/1.3 -apple-system, system-ui, sans-serif;
        padding: 8px 12px; border-radius: 999px; box-shadow: 0 8px 24px rgba(0,0,0,.28);
        cursor: pointer; max-width: min(280px, 70vw);
      }
      .pill b { font-weight: 600; }
      .menu {
        pointer-events: auto; position: fixed; background: #fff; color: #1c1c1e;
        font: 14px/1.35 -apple-system, system-ui, sans-serif;
        border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.22);
        border: 1px solid rgba(60,60,67,.12); overflow: hidden; max-width: min(420px, calc(100vw - 16px));
      }
      .menu.dark { background: #1c1c1e; color: #f5f5f7; border-color: rgba(255,255,255,.12); }
      .hd { padding: 8px 12px 4px; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #8e8e93; }
      .row {
        display: flex; gap: 10px; align-items: flex-start; width: 100%;
        background: transparent; border: 0; border-top: 1px solid rgba(60,60,67,.08);
        padding: 10px 12px; text-align: left; cursor: pointer; color: inherit; font: inherit;
      }
      .menu.dark .row { border-top-color: rgba(255,255,255,.08); }
      .row:hover, .row:focus { background: rgba(0,122,255,.08); outline: none; }
      .row .k { flex: 0 0 88px; color: #8e8e93; font-size: 12px; padding-top: 1px; }
      .row .v { flex: 1; word-break: break-word; }
      .row.best .v { font-weight: 600; }
      .toast {
        pointer-events: none; position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
        background: rgba(28,28,30,.94); color: #f5f5f7; font: 13px/1.35 -apple-system, system-ui, sans-serif;
        padding: 10px 14px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.3);
        max-width: min(420px, calc(100vw - 24px));
      }
    `;
    menu = document.createElement("div");
    menu.className = "menu";
    menu.style.display = "none";
    menu.setAttribute("role", "listbox");
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    toastEl.style.display = "none";
    pill = document.createElement("div");
    pill.className = "pill";
    pill.style.display = "none";
    pill.addEventListener("click", () => {
      pill.style.display = "none";
    });
    shadow.append(style, pill, menu, toastEl);
    (document.documentElement || document.body).appendChild(host);
  }

  function showPill() {
    ensureUi();
    if (document.querySelector("[data-jc-engine-build]")) {
      pill.style.display = "none";
      return;
    }
    const bits = ["Tap a field for presets"];
    if (ctx && ctx.resumeReady) bits.push("Upload → this résumé");
    if (ctx && (ctx.title || ctx.company)) bits.unshift((ctx.company || ctx.title).slice(0, 28));
    pill.innerHTML = `<b>JobHunt</b> · ${bits.join(" · ")}`;
    pill.style.display = "block";
  }

  function toast(msg) {
    ensureUi();
    toastEl.textContent = msg;
    toastEl.style.display = "block";
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => {
      toastEl.style.display = "none";
    }, 4200);
  }

  function hideMenu() {
    if (menu) menu.style.display = "none";
    activeEl = null;
  }

  function isOurs(node) {
    return !!(host && (node === host || (node instanceof Node && host.contains(node))));
  }

  function labelOf(el) {
    if (!core) return "";
    return core.cleanLabel(core.labelTextFor(el) || el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "");
  }

  function isFillable(el) {
    if (!el || el === document.body) return false;
    if (isOurs(el)) return false;
    if (el.closest && el.closest("[aria-hidden=true]")) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === "SELECT") return true;
    if (tag === "TEXTAREA") return true;
    if (tag !== "INPUT") return false;
    const t = String(el.type || "text");
    if (SKIP_TYPES.test(t)) return false;
    if (el.readOnly || el.disabled) return false;
    return true;
  }

  function placeMenu(el) {
    const r = el.getBoundingClientRect();
    const width = Math.min(420, Math.max(r.width, 280), window.innerWidth - 16);
    menu.style.display = "block";
    menu.style.width = `${width}px`;
    const mh = Math.min(menu.offsetHeight || 120, window.innerHeight - 16);
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    let left = r.left;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.max(8, left)}px`;
  }

  function showMenu(el) {
    if (!core || !ctx || !ctx.fields) return;
    const label = labelOf(el);
    const chips = core.suggestChips(label, ctx.fields, 10);
    if (!chips.length) {
      hideMenu();
      return;
    }
    ensureUi();
    activeEl = el;
    const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    menu.className = dark ? "menu dark" : "menu";
    menu.innerHTML = "";
    const hd = document.createElement("div");
    hd.className = "hd";
    hd.textContent = label ? label.slice(0, 60) : "Your info";
    menu.append(hd);
    for (const chip of chips) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = chip.kind === "best" ? "row best" : "row";
      row.innerHTML = `<span class="k">${escapeHtml(chip.label)}</span><span class="v">${escapeHtml(chip.value)}</span>`;
      row.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus on the field
      row.addEventListener("click", () => {
        applyChip(el, chip.value);
        hideMenu();
      });
      menu.append(row);
    }
    placeMenu(el);
  }

  function applyChip(el, value) {
    if (!el || !el.isConnected || !core) return;
    const max = Number(el.getAttribute && el.getAttribute("maxlength")) || 0;
    const applied = max > 0 ? value.slice(0, max) : value;
    core.setValue(el, applied);
    try {
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    } catch {
      /* ignore */
    }
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function findFileInput(from) {
    if (!from || !core) return null;
    if (core.isFileInput(from)) return from;
    const label = from.closest && from.closest("label");
    if (label) {
      const inner = label.querySelector("input[type=file]");
      if (inner) return inner;
    }
    const btn = from.closest && from.closest("button, a, [role=button], label, div, span");
    if (!btn) return null;
    const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""}`;
    if (!UPLOAD_RE.test(text)) return null;
    const near =
      (btn.parentElement && btn.parentElement.querySelector("input[type=file]")) ||
      document.querySelector("input[type=file]");
    return near;
  }

  async function resumePacket() {
    if (ctx && ctx.resumeBase64) {
      return { base64: ctx.resumeBase64, filename: ctx.resumeFilename || "resume.pdf" };
    }
    if (ctx && typeof ctx.fetchResume === "function") {
      const resp = await ctx.fetchResume();
      if (!resp || !resp.ok || !resp.data || !resp.data.base64) return null;
      return { base64: resp.data.base64, filename: resp.data.filename || "resume.pdf" };
    }
    if (ctx && ctx.jobId) {
      const resp = await bg("RESUME_PDF", { id: ctx.jobId }, 30000);
      if (!resp.ok || !resp.data || !resp.data.base64) return null;
      return { base64: resp.data.base64, filename: resp.data.filename || "resume.pdf" };
    }
    return null;
  }

  async function onUploadClick(e) {
    if (!ctx || resumeBusy) return;
    if (e.shiftKey) return; // escape hatch: native picker
    const t = e.target;
    if (!(t instanceof Element) || isOurs(t)) return;
    const input = findFileInput(t);
    if (!input || !core) return;
    if (core.fileInputRole(input) !== "resume") return;
    // Second click (or Shift-click) opens the real picker so the human can swap files.
    if (input.dataset.jhAllowPicker === "1" || input.dataset.jhAttached === "1") {
      delete input.dataset.jhAllowPicker;
      delete input.dataset.jhAttached;
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    resumeBusy = true;
    try {
      const pdf = await resumePacket();
      if (!pdf) {
        toast("No tailored résumé for this job yet — generate it on the dashboard.");
        input.dataset.jhAllowPicker = "1";
        return;
      }
      const result = core.injectPdf(input, pdf.base64, pdf.filename);
      if (result === "injected") {
        input.dataset.jhAttached = "1";
        toast(`Attached ${pdf.filename} — click again to pick a different file.`);
      } else {
        toast("Couldn't attach here — pick the file yourself.");
        input.dataset.jhAllowPicker = "1";
        try {
          input.click();
        } catch {
          /* ignore */
        }
      }
    } finally {
      resumeBusy = false;
    }
  }

  function onFocusIn(e) {
    const el = e.target;
    if (!(el instanceof Element) || !isFillable(el)) return;
    clearTimeout(hideTimer);
    showMenu(el);
  }

  function onFocusOut() {
    hideTimer = setTimeout(hideMenu, 180);
  }

  function onKey(e) {
    if (e.key === "Escape") hideMenu();
  }

  function onScrollOrResize() {
    if (activeEl && activeEl.isConnected && menu && menu.style.display === "block") placeMenu(activeEl);
    else hideMenu();
  }

  function bindDom() {
    if (root.__JH_ASSIST_DOM) return;
    root.__JH_ASSIST_DOM = true;
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("click", onUploadClick, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
  }

  function mount(next) {
    if (!core) return { ok: false, error: "no-core" };
    ctx = next || ctx;
    if (!ctx || !ctx.fields) return { ok: false, error: "no-fields" };
    bindDom();
    ensureUi();
    showPill();
    return { ok: true };
  }

  function unmount() {
    hideMenu();
    if (host) host.remove();
    host = shadow = menu = toastEl = pill = null;
    ctx = null;
  }

  root.JC_APPLY_ASSIST = { mount, unmount, showMenu };

  async function bootFromExtension() {
    if (typeof chrome === "undefined" || !chrome.runtime) return;
    const keys =
      root.JC_JOB_KEY && typeof root.JC_JOB_KEY.candidateKeys === "function"
        ? root.JC_JOB_KEY.candidateKeys(location.href)
        : [];
    const resp = await bg("ASSIST_CONTEXT", { url: location.href, keys });
    if (!resp.ok || !resp.data || !resp.data.fields) return;
    mount({
      fields: resp.data.fields,
      jobId: resp.data.jobId || null,
      title: resp.data.title || null,
      company: resp.data.company || null,
      resumeReady: !!resp.data.resumeReady,
      fetchResume: resp.data.jobId
        ? () => bg("RESUME_PDF", { id: resp.data.jobId }, 30000)
        : null,
    });
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => void bootFromExtension(), { once: true });
    } else {
      void bootFromExtension();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
