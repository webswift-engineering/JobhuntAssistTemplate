// Apply Copilot side panel — works on ANY site, including hosts with no
// content scripts (Workday, LinkedIn wizards, custom career pages).
//
// Flow: resolve the active tab's backend job from its URL (jobKey.js →
// /jobs/seen via the worker) → Scan the page (permission-gated injection into
// every frame) → suggested answers from the bank + profile → human Copies or
// Fills per field → Ask AI is the ONLY LLM path (on demand, per question) →
// one-click résumé attach. Backend HTTP stays in the background worker.
//
// Boundary: protected/EEO questions are never listed, filled, or captured.
// Sensitive questions (visa/salary/…) only ever suggest the user's own banked
// words; without a banked answer they're marked "yours to answer".

const $ = (id) => document.getElementById(id);
const bg = (type, payload, timeoutMs = 20000) =>
  new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
    try {
      chrome.runtime.sendMessage({ type, payload }, (resp) => {
        if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
        else finish(resp || { ok: false, error: "no response" });
      });
    } catch (e) {
      finish({ ok: false, error: String((e && e.message) || e) });
    }
  });
const dbg = (event, data) => void bg("DEBUG_LOG", { event, data });

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const PROTECTED_RE =
  /gender|race\b|racial|ethnic|hispanic|latino|veteran|disabilit|self[- ]identif|sexual orientation|transgender/i;
const SENSITIVE_RE =
  /sponsor|authoriz|visa|citizen|clearance|eligib|salar|compensation|relocat|pronoun/i;

// ---- state ------------------------------------------------------------------
let tab = null; // {id, url}
let job = null; // {id, state, score} + {title, company, resume} once fetched
let fields = null; // APPLY_FIELDS payload (contact + normalized answer bank)
let questions = []; // last scan results (+frameId)

// ---- matching (ported from applyEngine) ------------------------------------
function bankFor(l) {
  if (!fields) return null;
  if (fields.answers[l] != null) return fields.answers[l];
  if (l.length < 4) return null;
  for (const [k, v] of Object.entries(fields.answers)) {
    if (k.length >= 4 && (k.includes(l) || l.includes(k))) return v;
  }
  return null;
}

function profileValueFor(l) {
  if (!fields) return null;
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
  if (/location|city|reside|based/.test(l)) return fields.location;
  return null;
}

/** Suggestion for a question; when the control has options, prefer the OPTION
 *  that best matches the raw suggestion (mini options-first matching). */
function suggestFor(q) {
  const l = norm(q.label);
  const bank = bankFor(l);
  let source = bank != null ? "bank" : null;
  let value = bank;
  if (value == null && !SENSITIVE_RE.test(l)) {
    value = profileValueFor(l);
    source = value != null ? "profile" : null;
  }
  if (value != null && q.options && q.options.length) {
    const v = norm(value);
    const hit =
      q.options.find((o) => norm(o) === v) ||
      q.options.find((o) => norm(o).includes(v) || v.includes(norm(o))) ||
      q.options.find((o) => v.split(" ").some((w) => w.length >= 3 && norm(o).includes(w)));
    if (hit) value = hit;
    else return { value, source, optionMiss: true };
  }
  return value != null ? { value, source } : { value: null, source: null };
}

// ---- injected functions (must be closure-free) ------------------------------
function fillInjected(idx, value) {
  const el = (window.__jcScanEls || [])[idx];
  const nrm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (el == null) return { ok: false, error: "stale — re-scan" };
  if (Array.isArray(el)) {
    // radio/checkbox group
    const target = el.find((m) => {
      if (!m.isConnected) return false;
      const lab = (m.labels && m.labels[0] && m.labels[0].textContent) || m.value || "";
      return nrm(lab) === nrm(value) || nrm(lab).includes(nrm(value)) || nrm(value).includes(nrm(lab));
    });
    if (!target) return { ok: false, error: "option not found" };
    target.click();
    return { ok: true, set: (target.labels && target.labels[0] && target.labels[0].textContent) || target.value };
  }
  if (!el.isConnected) return { ok: false, error: "stale — re-scan" };
  if (el.tagName === "SELECT") {
    const i = [...el.options].findIndex((o) => nrm(o.text) === nrm(value) || nrm(o.text).includes(nrm(value)));
    if (i < 0) return { ok: false, error: "no matching option" };
    el.selectedIndex = i;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, set: el.options[i].text };
  }
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, set: el.value };
}

async function attachInjected(jobId) {
  const inputs = [...document.querySelectorAll("input[type=file]")].filter((f) => f.isConnected && !f.disabled);
  if (!inputs.length) return { ok: false, reason: "no-file-input" };
  const visible = inputs.find((f) => {
    const r = f.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const input = visible || inputs[0];
  const resp = await new Promise((res) => {
    try {
      chrome.runtime.sendMessage({ type: "RESUME_PDF", payload: { id: jobId } }, (r) =>
        res(r || { ok: false, error: "no response" })
      );
    } catch (e) {
      res({ ok: false, error: String((e && e.message) || e) });
    }
  });
  if (!resp.ok || !resp.data || !resp.data.base64) return { ok: false, reason: resp.error || "pdf-unavailable" };
  try {
    const bin = atob(resp.data.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], resp.data.filename || "resume.pdf", { type: "application/pdf" });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // Drop-zone variants (Workday et al): also dispatch a drop on the zone.
    const zone = input.closest("[class*='drop' i], [data-automation-id*='file']") || input.parentElement;
    if (zone) {
      const dt2 = new DataTransfer();
      dt2.items.add(file);
      zone.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt2 }));
    }
    return { ok: true, name: file.name, hiddenInput: !visible };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// ---- job resolution ---------------------------------------------------------
async function refreshTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t || !t.url || !/^https?:/.test(t.url)) {
    tab = null;
    job = null;
    $("job-info").innerHTML = '<span class="muted">This page isn\'t a job site (or isn\'t injectable).</span>';
    setResumeButtons(false);
    return;
  }
  if (tab && tab.id === t.id && tab.url === t.url) return; // unchanged
  tab = { id: t.id, url: t.url };
  await resolveJob();
}

function setResumeButtons(enabled) {
  $("attach-resume").disabled = !enabled;
  $("stage-resume").disabled = !enabled;
  $("open-folder").disabled = !enabled;
}

async function resolveJob() {
  job = null;
  setResumeButtons(false);
  $("job-info").innerHTML = '<span class="muted">Resolving this tab…</span>';
  const keys = window.JC_JOB_KEY.candidateKeys(tab.url);
  if (!keys.length) {
    $("job-info").innerHTML =
      '<span class="muted">Unrecognized job site — Scan still works; résumé needs a captured job.</span>';
    return;
  }
  const seen = await bg("SEEN", keys);
  const hit = seen.ok && seen.data ? keys.map((k) => seen.data[k]).find(Boolean) : null;
  if (!hit) {
    $("job-info").innerHTML =
      '<span class="muted">Job not in the backend yet — capture it from the dashboard first for résumé + recording.</span>';
    return;
  }
  const detail = await bg("JOB_GET", { id: hit.id });
  const j = detail.ok ? detail.data : null;
  job = { id: hit.id, ...(j || {}), score: hit.score, state: hit.state };
  const pct = job.relevance_score != null ? `${Math.round(job.relevance_score * 100)}%` : "—";
  const resume = j && j.resume ? j.resume.status : "unknown";
  $("job-info").innerHTML =
    `<div class="job-title">${escapeHtml(job.title || "(unknown title)")} · ${escapeHtml(job.company || "")}</div>` +
    `<span class="muted">${pct} match · ${escapeHtml(job.state || "")} · résumé: ${escapeHtml(resume)}</span>`;
  setResumeButtons(true);
  $("attach-resume").disabled = resume !== "ready";
  $("stage-resume").disabled = resume !== "ready";
  $("resume-status").textContent = resume === "ready" ? "" : "No tailored résumé yet — generate it from the dashboard.";
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- permissions + scan -----------------------------------------------------
async function ensureOrigins() {
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  const origins = [
    ...new Set(
      (frames || [])
        .map((f) => {
          try {
            const u = new URL(f.url);
            return /^https?:$/.test(u.protocol) ? `${u.origin}/*` : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    ),
  ];
  if (!origins.length) return { ok: false, error: "no injectable frames" };
  const have = await chrome.permissions.contains({ origins });
  if (have) return { ok: true, origins };
  // One prompt for every frame origin at once; grants persist per origin forever.
  const granted = await chrome.permissions.request({ origins });
  return granted ? { ok: true, origins } : { ok: false, error: "permission declined" };
}

async function doScan() {
  if (!tab) return;
  $("scan-status").textContent = "scanning…";
  const perm = await ensureOrigins();
  if (!perm.ok) {
    $("scan-status").textContent = `⚠ ${perm.error}`;
    return;
  }
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["injected/scan.js"],
    });
  } catch (e) {
    $("scan-status").textContent = `⚠ ${String((e && e.message) || e)}`;
    return;
  }
  questions = [];
  let fileInputs = 0;
  let protectedCount = 0;
  for (const r of results || []) {
    if (!r || !r.result) continue;
    fileInputs += r.result.fileInputs || 0;
    protectedCount += r.result.protectedCount || 0; // excluded at the source
    for (const q of r.result.questions || []) {
      if (PROTECTED_RE.test(q.label)) {
        protectedCount++;
        continue; // safety net — scan.js already excludes these
      }
      questions.push({ ...q, frameId: r.frameId });
    }
  }
  $("scan-status").textContent =
    `${questions.length} question(s) · ${fileInputs} upload field(s)` +
    (protectedCount ? ` · ${protectedCount} demographic left untouched` : "");
  dbg("panel-scan", { url: tab.url.slice(0, 120), frames: (results || []).length, questions: questions.length, fileInputs, protectedCount });
  renderQuestions();

  // Recommended-vs-actual plumbing: tag every frame with the job id (the step
  // observer stamps it on STEP_SNAPSHOT events) and register what we suggested
  // so the worker can judge accepted / human-edited / human at each step.
  if (job) {
    chrome.scripting
      .executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: (id) => {
          window.__jcJobId = id;
        },
        args: [job.id],
      })
      .catch(() => {});
    const suggestions = questions
      .map((q) => ({ q, s: suggestFor(q) }))
      .filter((x) => x.s.value != null)
      .map((x) => ({ label: x.q.label, value: String(x.s.value), source: x.s.source }));
    void bg("SUGGESTIONS_SET", { jobId: job.id, suggestions });
  }
}

/**
 * "💾 Save my answers": one button instead of per-field banking. Re-scans the
 * page (fresh values, all frames), then hands the whole capture to the worker's
 * STEP_SNAPSHOT reconciler — everything YOU typed (or corrected) gets banked in
 * one pass; suggestion-accepted, contact, and protected fields are skipped by
 * the same rules as the automatic submit/step snapshots.
 */
async function saveAllAnswers() {
  if (!tab) return;
  $("scan-status").textContent = "capturing…";
  const perm = await ensureOrigins();
  if (!perm.ok) {
    $("scan-status").textContent = `⚠ ${perm.error}`;
    return;
  }
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["injected/scan.js"],
    });
  } catch (e) {
    $("scan-status").textContent = `⚠ ${String((e && e.message) || e)}`;
    return;
  }
  const fields = [];
  for (const r of results || []) {
    if (!r || !r.result) continue;
    for (const q of r.result.questions || []) {
      if (q.value && q.value.trim()) fields.push({ label: q.label, value: q.value });
    }
  }
  if (!fields.length) {
    $("scan-status").textContent = "nothing filled in yet — type your answers first, then save.";
    return;
  }
  const resp = await bg("STEP_SNAPSHOT", {
    jobId: job ? job.id : null,
    url: tab.url,
    fields,
    trigger: "save-all-button",
  });
  if (!resp.ok) {
    $("scan-status").textContent = `⚠ ${resp.error}`;
    return;
  }
  const c = resp.counts || {};
  $("scan-status").textContent =
    `💾 banked ${resp.banked} answer(s)` +
    (c.accepted ? ` · ${c.accepted} already matched suggestions` : "") +
    " — future forms asking the same questions auto-fill.";
  // Refresh the local bank so re-rendered suggestions include what was just saved.
  const f = await bg("APPLY_FIELDS");
  if (f.ok) {
    fieldsBank(f.data);
    if (questions.length) renderQuestions();
  }
}

/** Swap in a fresh APPLY_FIELDS payload (contact + normalized bank). */
function fieldsBank(data) {
  fields = data || { answers: {} };
}

// ---- stream box (the unified all-jobs stream) -------------------------------
let stream = null; // {streamId, current: {id,url,index,total,mode,title,company}, remaining}

async function refreshStream() {
  const res = await bg("STREAM_STATUS");
  stream = res.ok && res.data && res.data.streamId ? res.data : null;
  const sec = $("stream-section");
  if (!stream || !stream.current) {
    sec.style.display = "none";
    return;
  }
  sec.style.display = "block";
  const c = stream.current;
  $("stream-info").innerHTML =
    `<b>Stream</b> · job ${c.index + 1}/${c.total} — ${escapeHtml(c.title || "")} @ ${escapeHtml(c.company || "")}` +
    ` <span class="badge ${c.mode === "auto" ? "bank" : "profile"}">${c.mode === "auto" ? "auto-fill" : "panel-assist"}</span>`;
  $("stream-status").textContent =
    c.mode === "manual"
      ? "Fill with the panel, submit on the site, then ✓ Applied → next."
      : "The engine fills this one and advances on Submit — buttons here are the manual override.";
}

// ---- rendering --------------------------------------------------------------
function renderQuestions() {
  const box = $("questions");
  box.innerHTML = "";
  for (const q of questions) {
    const l = norm(q.label);
    const s = suggestFor(q);
    const el = document.createElement("div");
    el.className = "q";
    const answered = q.value && q.value.trim();
    const badge = answered
      ? '<span class="badge bank">already filled</span>'
      : s.source === "bank"
        ? '<span class="badge bank">bank</span>'
        : s.source === "profile"
          ? '<span class="badge profile">profile</span>'
          : SENSITIVE_RE.test(l)
            ? '<span class="badge none">yours to answer</span>'
            : '<span class="badge none">no answer yet</span>';
    el.innerHTML =
      `<div class="label">${escapeHtml(q.label)}${q.required ? '<span class="badge req">required</span>' : ""}${badge}</div>` +
      (answered ? `<div class="ans muted">${escapeHtml(q.value)}</div>` : "") +
      (!answered && s.value != null
        ? `<div class="ans">${escapeHtml(s.value)}</div>` +
          (s.optionMiss ? '<div class="muted">⚠ no dropdown option matches — pick manually</div>' : "")
        : "");
    const row = document.createElement("div");
    row.className = "row";
    if (!answered && s.value != null) {
      row.append(
        btn("Fill", async () => {
          const res = await fill(q, s.value);
          statusFlash(el, res.ok ? `✓ filled: ${res.set ?? ""}` : `✗ ${res.error}`, res.ok);
        }),
        btn("Copy", async () => {
          await navigator.clipboard.writeText(String(s.value));
          statusFlash(el, "copied", true);
        })
      );
    }
    if (!answered && s.value == null && !SENSITIVE_RE.test(l)) {
      row.append(
        btn("Ask AI", async (b) => {
          b.disabled = true;
          b.textContent = "asking…";
          const resp = await bg("ANSWER_SCREENING", { questions: [q.label] }, 60000);
          const ans = resp.ok && resp.data && resp.data.answers ? resp.data.answers[q.label] : null;
          dbg("panel-ask-ai", { label: q.label.slice(0, 120), answered: ans != null });
          if (ans != null) {
            fields.answers[norm(q.label)] = ans; // server banked it too
            renderQuestions();
          } else {
            b.textContent = "AI has no grounded answer";
          }
        })
      );
    }
    // Add / correct in bank
    row.append(
      btn("✎ bank", () => {
        editor.style.display = editor.style.display === "none" ? "block" : "none";
      })
    );
    el.append(row);
    const editor = document.createElement("div");
    editor.style.cssText = "display:none;margin-top:6px";
    const ta = document.createElement("textarea");
    ta.rows = 2;
    ta.placeholder = "your answer, saved to the bank";
    ta.value = s.source === "bank" ? s.value : "";
    const save = btn("Save to bank", async () => {
      const v = ta.value.trim();
      if (!v) return;
      await bg("BANK_ANSWERS", { answers: { [q.label]: v } });
      fields.answers[norm(q.label)] = v;
      editor.style.display = "none";
      renderQuestions();
    });
    editor.append(ta, save);
    el.append(editor);
    box.append(el);
  }
}

function btn(text, onclick) {
  const b = document.createElement("button");
  b.className = "small";
  b.textContent = text;
  b.addEventListener("click", () => onclick(b));
  return b;
}

function statusFlash(qEl, text, ok) {
  let s = qEl.querySelector(".flash");
  if (!s) {
    s = document.createElement("div");
    s.className = "flash muted";
    qEl.append(s);
  }
  s.textContent = text;
  s.className = `flash ${ok ? "ok" : "err"}`;
}

async function fill(q, value) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [q.frameId] },
      func: fillInjected,
      args: [q.idx, String(value)],
    });
    const res = (r && r.result) || { ok: false, error: "no result" };
    dbg("panel-fill", { label: q.label.slice(0, 120), ok: res.ok, error: res.error || null });
    return res;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---- résumé actions ---------------------------------------------------------
async function attachResume() {
  if (!tab || !job) return;
  $("resume-status").textContent = "attaching…";
  const perm = await ensureOrigins();
  if (!perm.ok) {
    $("resume-status").textContent = `⚠ ${perm.error}`;
    return;
  }
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: attachInjected,
      args: [job.id],
    });
  } catch (e) {
    $("resume-status").textContent = `⚠ ${String((e && e.message) || e)}`;
    return;
  }
  const hit = (results || []).map((r) => r && r.result).find((r) => r && r.ok);
  const reasons = [...new Set((results || []).map((r) => r && r.result && r.result.reason).filter(Boolean))];
  $("resume-status").textContent = hit
    ? `✓ attached ${hit.name}${hit.hiddenInput ? " (hidden input — verify the page shows the file)" : ""}`
    : `✗ couldn't attach (${reasons.join(", ") || "no file input found"}) — try 📤 Stage to outbox`;
  dbg("panel-attach", { ok: !!hit, reasons });
}

async function stageResume() {
  if (!job) return;
  const res = await bg("STAGE_RESUME", { id: job.id });
  $("resume-status").textContent = res.ok
    ? `✓ staged as ${res.data.filename} in ${res.data.dir} — point the file picker there ONCE; it's always the only file.`
    : `✗ ${res.error}`;
}

// ---- boot -------------------------------------------------------------------
async function boot() {
  const health = await bg("HEALTH");
  $("dot").classList.toggle("off", !health.ok);
  const f = await bg("APPLY_FIELDS");
  fields = f.ok ? f.data : { answers: {} };

  const { autoLlm } = await chrome.storage.local.get("autoLlm");
  $("auto-llm").checked = autoLlm === true;
  $("auto-llm").addEventListener("change", (e) => chrome.storage.local.set({ autoLlm: e.target.checked }));

  $("scan").addEventListener("click", doScan);
  $("save-all").addEventListener("click", saveAllAnswers);
  $("attach-resume").addEventListener("click", attachResume);
  $("stage-resume").addEventListener("click", stageResume);
  $("open-folder").addEventListener("click", async () => {
    if (job) await bg("OPEN_FOLDER", { id: job.id });
  });
  $("grant-all").addEventListener("click", async () => {
    // permissions.request first in the handler — the gesture must not be consumed.
    const granted = await chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] });
    $("grant-status").textContent = granted ? "✓ granted — no more per-site prompts" : "declined";
  });

  // Stream controls: act on the LIVE stream's current job (backend cursor),
  // navigating THIS tab. Manual-mode jobs are advanced from here; auto-mode
  // jobs normally advance themselves — these double as the manual override.
  $("stream-applied").addEventListener("click", async () => {
    if (!stream || !tab) return;
    $("stream-status").textContent = "recording + loading next…";
    const r = await bg("STREAM_MARK_APPLIED", { streamId: stream.streamId, jobId: stream.current.id, tabId: tab.id });
    if (!r.ok) $("stream-status").textContent = `✗ ${r.error}`;
  });
  $("stream-skip").addEventListener("click", async () => {
    if (!stream || !tab) return;
    $("stream-status").textContent = "skipping…";
    const r = await bg("STREAM_SKIP", { streamId: stream.streamId, afterId: stream.current.id, tabId: tab.id });
    if (!r.ok) $("stream-status").textContent = `✗ ${r.error}`;
  });
  $("stream-end").addEventListener("click", async () => {
    if (!stream) return;
    await bg("STREAM_STOP", { streamId: stream.streamId });
    await refreshStream();
  });

  await refreshTab();
  await refreshStream();
  chrome.tabs.onActivated.addListener(() => {
    void refreshTab();
    void refreshStream();
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === "complete" || info.url) {
      void refreshTab();
      void refreshStream();
    }
  });
}

void boot();
