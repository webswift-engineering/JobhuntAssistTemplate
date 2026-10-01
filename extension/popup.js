const send = (type, payload) =>
  new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, resolve));

const listEl = document.getElementById("list");
const dot = document.getElementById("dot");
const filter = document.getElementById("filter");

// ---- Apply Copilot side panel ----------------------------------------------
// Prefetch the tab id at popup load: sidePanel.open must be called
// SYNCHRONOUSLY in the click handler — an await before it consumes the user
// gesture and the call throws.
let copilotTabId = null;
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  copilotTabId = tabs && tabs[0] ? tabs[0].id : null;
});
const copilotBtn = document.getElementById("open-copilot");
if (chrome.sidePanel) {
  copilotBtn.addEventListener("click", () => {
    if (copilotTabId != null) chrome.sidePanel.open({ tabId: copilotTabId });
    window.close();
  });
} else {
  // Android Chromium builds have no side panel. The dashboard's apply sheet
  // carries the same answers as tap-to-copy chips.
  copilotBtn.textContent = "Copilot needs a desktop browser";
  copilotBtn.disabled = true;
}

// ---- backend settings (URL + token) so the extension can reach a remote backend
const DEFAULT_BASE = "http://127.0.0.1:8787";
const backendUrlEl = document.getElementById("backend-url");
const accessTokenEl = document.getElementById("access-token");
const settingsStatus = document.getElementById("settings-status");
const openDash = document.getElementById("open-dash");

/** Which account the backend resolves us to — the tell when a saved token
 *  belongs to someone else and the field helper fills in their details. */
function showAccount(health) {
  const el = document.getElementById("settings-summary");
  if (!el) return;
  const acct = health && health.ok && health.data && health.data.account;
  el.textContent = acct ? `⚙ Backend settings · account: ${acct.name}` : "⚙ Backend settings";
  el.style.color = acct && acct.id !== 1 ? "#f0b429" : "";
}

async function loadSettings() {
  const { backendBase, accessToken } = await chrome.storage.local.get([
    "backendBase",
    "accessToken",
  ]);
  const url = backendBase || DEFAULT_BASE;
  backendUrlEl.value = url;
  accessTokenEl.value = accessToken || "";
  if (openDash) openDash.href = url.replace(/\/+$/, "");
}

document.getElementById("save-settings").addEventListener("click", async () => {
  const url = (backendUrlEl.value || DEFAULT_BASE).trim().replace(/\/+$/, "");
  const token = accessTokenEl.value.trim();
  // Request permission to talk to a non-default origin (e.g. a Tailscale URL).
  try {
    const origin = new URL(url).origin + "/*";
    await chrome.permissions.request({ origins: [origin] });
  } catch {
    /* user may decline; localhost is already granted */
  }
  await chrome.storage.local.set({ backendBase: url, accessToken: token });
  if (openDash) openDash.href = url;
  settingsStatus.textContent = "testing…";
  const health = await send("HEALTH");
  settingsStatus.textContent = health && health.ok ? "connected ✓" : `error: ${health?.error ?? "offline"}`;
  refresh();
});

function ago(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

async function refresh() {
  const health = await send("HEALTH");
  dot.className = "dot" + (health.ok ? "" : " off");
  showAccount(health);

  const q = filter.value ? `?state=${filter.value}&limit=100` : "?limit=100";
  const res = await send("LIST", q);
  if (!res.ok) {
    listEl.innerHTML = `<div class="empty">${res.error}. Start the backend on :8787.</div>`;
    return;
  }
  const jobs = res.data;
  if (!jobs.length) {
    listEl.innerHTML = `<div class="empty">No jobs captured yet.</div>`;
    return;
  }
  const rows = jobs
    .map((j) => {
      const score = j.relevance_score == null ? "—" : Math.round(j.relevance_score * 100);
      return `<tr>
        <td>${score}</td>
        <td>
          <div class="title"><a href="${j.url}" target="_blank">${esc(j.title)}</a></div>
          <div class="muted">${esc(j.company || "—")} · ${esc(j.source)} · ${j.state} · ${ago(j.first_seen_at)}</div>
        </td>
        <td class="acts">
          ${j.state !== "applied" ? `<button data-id="${j.id}" data-s="relevant">★</button>` : ""}
          ${j.state !== "applied" && j.state !== "skipped" ? `<button data-id="${j.id}" data-s="skipped">🚫</button>` : ""}
          ${j.state !== "applied" ? `<button data-id="${j.id}" data-s="applied">✅</button>` : ""}
        </td>
      </tr>`;
    })
    .join("");
  listEl.innerHTML = `<table><thead><tr><th>%</th><th>Job</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  listEl.querySelectorAll("button[data-id]").forEach((b) =>
    b.addEventListener("click", async () => {
      await send("PATCH_STATE", { id: b.dataset.id, state: b.dataset.s });
      refresh();
    })
  );
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

document.getElementById("refresh").addEventListener("click", refresh);
filter.addEventListener("change", refresh);
document.getElementById("hide-masked").addEventListener("change", async (e) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_HIDE_MASKED", value: e.target.checked });
});

const scanStatus = document.getElementById("scan-status");
const saveScanned = document.getElementById("save-scanned");

chrome.storage.local.get("saveScanned").then((v) => {
  saveScanned.checked = v.saveScanned !== false; // default on
});
saveScanned.addEventListener("change", (e) => {
  chrome.storage.local.set({ saveScanned: e.target.checked });
});

async function startScan(force) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return;
  // Request host permission for this site so we can fetch JDs / open tabs on it.
  try {
    const origin = new URL(tab.url).origin + "/*";
    await chrome.permissions.request({ origins: [origin] });
  } catch {
    /* user may decline; scan still works for same-origin in-page fetches */
  }
  if (force) {
    try {
      await chrome.storage.local.set({ scanForceAdapt: true });
    } catch {
      /* ignore */
    }
  }
  scanStatus.textContent = force ? "re-teaching…" : "scanning…";
  const res = await send("SCAN_PAGE", { tabId: tab.id });
  scanStatus.textContent = res?.ok ? "started ✓" : `error: ${res?.error ?? "failed"}`;
  setTimeout(() => (scanStatus.textContent = ""), 4000);
}

document.getElementById("scan").addEventListener("click", () => startScan(false));
document.getElementById("reteach").addEventListener("click", () => startScan(true));

// ---- LinkedIn auto-scan (browser-driven watch) ----
const autoEnabled = document.getElementById("auto-enabled");
const autoUrl = document.getElementById("auto-url");
const autoStatus = document.getElementById("auto-status");
const autoLast = document.getElementById("auto-last");
const autoInterval = document.getElementById("auto-interval");
const autoStart = document.getElementById("auto-start");
const autoEnd = document.getElementById("auto-end");
const autoDays = document.getElementById("auto-days");
const autoSmart = document.getElementById("auto-smart");

/** Show when the next scheduled run is due (from the background's alarm). */
async function renderAutoNext() {
  const res = await send("AUTO_SCAN_STATUS");
  if (!res || !res.ok) return;
  const cur = autoLast.textContent;
  if (res.nextAt) {
    const d = new Date(res.nextAt);
    const sameDay = d.toDateString() === new Date().toDateString();
    const when = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + (sameDay ? "" : ` ${d.toLocaleDateString([], { weekday: "short" })}`);
    autoLast.textContent = `${cur} · next ${when}`;
  } else if (res.enabled) {
    autoLast.textContent = `${cur} · not scheduled`;
  }
}

function renderAutoLast(run) {
  if (!run) {
    autoLast.textContent = "no auto-scan runs yet";
    return;
  }
  const when = `${ago(run.at)} ago (${run.trigger || "alarm"})`;
  autoLast.textContent = run.error
    ? `last run ${when} — error: ${run.error}`
    : `last run ${when} — ${run.scanned} scanned · ${run.strong} strong · ${run.maybe} maybe · ${run.persisted} saved` +
      (run.notified != null ? ` · ${run.notified} pinged` : "");
}

async function loadAutoScan() {
  const v = await chrome.storage.local.get([
    "autoScanEnabled",
    "autoScanUrl",
    "autoScanLastRun",
    "autoScanIntervalMin",
    "autoScanWindow",
    "autoScanSmartRange",
  ]);
  autoEnabled.checked = v.autoScanEnabled === true;
  autoUrl.value = v.autoScanUrl || "";
  autoInterval.value = String(Number(v.autoScanIntervalMin) || 90);
  const w = v.autoScanWindow || {};
  autoStart.value = String(w.startHour ?? 7);
  autoEnd.value = String(w.endHour ?? 17);
  const days = Array.isArray(w.days) && w.days.length ? w.days.join(",") : "1,2,3,4,5";
  autoDays.value = [...autoDays.options].some((o) => o.value === days) ? days : "1,2,3,4,5";
  autoSmart.checked = v.autoScanSmartRange !== false;
  renderAutoLast(v.autoScanLastRun);
  renderAutoNext();
}

document.getElementById("auto-save").addEventListener("click", async () => {
  const url = autoUrl.value.trim();
  if (autoEnabled.checked && !/linkedin\.com\/jobs/i.test(url)) {
    autoStatus.textContent = "paste a linkedin.com/jobs search URL";
    return;
  }
  const startHour = Math.min(23, Math.max(0, Number(autoStart.value) || 0));
  const endHour = Math.min(24, Math.max(startHour + 1, Number(autoEnd.value) || 24));
  await chrome.storage.local.set({
    autoScanEnabled: autoEnabled.checked,
    autoScanUrl: url,
    autoScanIntervalMin: Math.max(30, Number(autoInterval.value) || 90),
    autoScanWindow: { days: autoDays.value.split(",").map(Number), startHour, endHour },
    autoScanSmartRange: autoSmart.checked,
  });
  const res = await send("AUTO_SCAN_APPLY");
  autoStatus.textContent =
    res && res.ok ? (res.scheduled ? "scheduled ✓" : "disabled") : `error: ${res?.error ?? "failed"}`;
  const v = await chrome.storage.local.get("autoScanLastRun");
  renderAutoLast(v.autoScanLastRun);
  renderAutoNext();
  setTimeout(() => (autoStatus.textContent = ""), 4000);
});

document.getElementById("auto-run-now").addEventListener("click", async () => {
  autoStatus.textContent = "running… (a scan window will open)";
  const res = await send("AUTO_SCAN_NOW");
  autoStatus.textContent =
    res && res.ok ? "done ✓" : `error: ${res?.error ?? "failed"}`;
  const v = await chrome.storage.local.get("autoScanLastRun");
  renderAutoLast(v.autoScanLastRun);
  renderAutoNext();
  setTimeout(() => (autoStatus.textContent = ""), 6000);
});

loadAutoScan();

// ---- Prefill-ahead (phone decides, desktop fills) ----
const prefillEnabled = document.getElementById("prefill-enabled");
const prefillStatus = document.getElementById("prefill-status");

async function loadPrefill() {
  const v = await chrome.storage.local.get("prefillEnabled");
  prefillEnabled.checked = v.prefillEnabled !== false;
  const st = await send("PREFILL_STATUS");
  if (st && st.ok) {
    prefillStatus.textContent = st.enabled
      ? st.polling ? "filling…" : st.nextAt ? `polling · next ${new Date(st.nextAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "idle"
      : "off";
  }
}

prefillEnabled.addEventListener("change", async () => {
  await chrome.storage.local.set({ prefillEnabled: prefillEnabled.checked });
  const res = await send("PREFILL_APPLY");
  prefillStatus.textContent = res && res.ok ? (res.scheduled ? "polling ✓" : "off") : `error: ${res?.error ?? "failed"}`;
  setTimeout(loadPrefill, 1500);
});

document.getElementById("prefill-now").addEventListener("click", async () => {
  prefillStatus.textContent = "polling…";
  const res = await send("PREFILL_NOW");
  prefillStatus.textContent =
    res && res.ok
      ? `${res.opened ? "opened 1" : "nothing queued"} · ${res.refills} refill(s) · ${res.closed} closed · ${res.active ?? "?"}/${res.cap ?? "?"} parked`
      : `error: ${res?.error ?? "failed"}`;
  setTimeout(loadPrefill, 6000);
});

loadPrefill();

// Capture a compact structural digest of the current page and copy it to the
// clipboard, so a tricky site's layout can be shared for analysis.
document.getElementById("copysrc").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  scanStatus.textContent = "reading page…";
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["scan/jsonld.js", "scan/digest.js"],
    });
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.__JCSCAN && window.__JCSCAN.buildDigest ? window.__JCSCAN.buildDigest(60000) : ""),
    });
    if (result) {
      await navigator.clipboard.writeText(`HOST: ${new URL(tab.url).host}\n\n${result}`);
      scanStatus.textContent = `copied ${result.length} chars ✓`;
    } else {
      scanStatus.textContent = "no structure found";
    }
  } catch (e) {
    scanStatus.textContent = `error: ${e?.message ?? "failed"}`;
  }
  setTimeout(() => (scanStatus.textContent = ""), 6000);
});

document.getElementById("hide-disq").addEventListener("change", async (e) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (hide) => document.body.classList.toggle("jc-hide-disq", hide),
    args: [e.target.checked],
  });
});

loadSettings().then(refresh);

// ---- Field helper on every site (Workday, custom career pages, …) ----------
const assistEverywhere = document.getElementById("assist-everywhere");
const assistStatus = document.getElementById("assist-status");

async function loadAssist() {
  const st = await send("ASSIST_EVERYWHERE_STATUS");
  if (!st || !st.ok) return;
  assistEverywhere.checked = !!st.enabled;
  assistStatus.textContent = st.enabled ? "on" : st.granted ? "granted · off" : "";
}

assistEverywhere.addEventListener("change", async () => {
  if (assistEverywhere.checked) {
    try {
      await chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] });
    } catch {
      /* declined */
    }
  }
  const res = await send("ASSIST_EVERYWHERE_APPLY", { enabled: assistEverywhere.checked });
  assistStatus.textContent = res && res.enabled ? "on — tap a field for presets" : "off (Greenhouse / Lever / Ashby still work)";
  if (assistEverywhere.checked && (!res || !res.enabled)) assistEverywhere.checked = false;
  setTimeout(loadAssist, 1500);
});

loadAssist();
