// Background service worker — owns ALL backend HTTP (single base URL + error handling).
const DEFAULT_BASE = "http://127.0.0.1:8787";

// ---- optional-API guard (Android) ------------------------------------------
// Chromium browsers that run MV3 extensions on Android (Quetta, Lemur, …) omit
// desktop-only APIs: no side panel, no touch context menus, one window, and
// sometimes no alarms. Registering a listener on a missing API throws while the
// service worker is *starting*, which takes the whole extension down — including
// the backend proxy every content script depends on. So optional APIs are always
// reached through these guards, and desktop-only features simply don't register.
const hasApi = (api) => typeof chrome[api] !== "undefined" && chrome[api] !== null;

/** Register a listener only where the API exists. */
function onOptional(api, event, handler) {
  if (hasApi(api)) chrome[api][event].addListener(handler);
  else console.info(`[jobcapture] chrome.${api} unavailable — skipping ${event}`);
}

async function base() {
  const { backendBase } = await chrome.storage.local.get("backendBase");
  return (backendBase || DEFAULT_BASE).replace(/\/+$/, "");
}

async function accessToken() {
  const { accessToken } = await chrome.storage.local.get("accessToken");
  return accessToken || "";
}

const LOOPBACK_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

async function http(path, init) {
  try {
    const token = await accessToken();
    const headers = { "Content-Type": "application/json", ...(init && init.headers) };
    if (token) headers["x-access-token"] = token;
    let b = await base();
    let res = await fetch(b + path, { ...init, headers });
    // Footgun seen 2026-09-09: backend URL saved as the Tailscale IP (for the
    // other PC) with no token → every call 401s silently and the watch looks
    // dead. On the PC that runs the backend, loopback is always trusted — so on
    // 401 with no token, try loopback once and, if it answers, keep it.
    if (res.status === 401 && !token && !LOOPBACK_RE.test(b)) {
      const retry = await fetch(DEFAULT_BASE + path, { ...init, headers }).catch(() => null);
      if (retry && retry.ok) {
        console.warn(`[jobcapture] backend ${b} rejected us (401, no token) — switching to ${DEFAULT_BASE}`);
        await chrome.storage.local.set({ backendBase: DEFAULT_BASE });
        b = DEFAULT_BASE;
        res = retry;
      }
    }
    if (!res.ok) {
      let err = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        err = body.error ?? err;
      } catch {
        /* ignore */
      }
      return { ok: false, error: err, status: res.status };
    }
    const data = res.status === 204 ? null : await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: "backend offline", offline: true };
  }
}

// Cross-origin fetch of a job detail page (Scan Tier 1). Needs a granted host
// permission for the target origin; same-origin fetches are done in the page instead.
async function fetchJd({ url }) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function waitTabComplete(tabId, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          clearInterval(t);
          resolve(true);
        } else if (Date.now() - start > timeout) {
          clearInterval(t);
          resolve(false);
        }
      } catch {
        clearInterval(t);
        resolve(false);
      }
    }, 300);
  });
}

// Scan Tier 3: open the URL in a background tab, run the page extractor, close it.
async function openTabScrape({ url }) {
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitTabComplete(tab.id, 15000);
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["extract.js"],
    });
    const description = result?.rawText || null;
    return { ok: !!description, description };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (tab?.id != null) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

const SCAN_FILES = [
  "scan/jsonld.js",
  "scan/digest.js",
  "scan/detector.js",
  "scan/adapter.js",
  "scan/overlay.js",
  "scan/fetcher.js",
  "scan/controller.js",
];

// Inject the scan engine into the active tab on demand (works on any site).
async function injectScan({ tabId }) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: SCAN_FILES });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---- Auto-scan (browser-driven LinkedIn watch) ------------------------------
// A chrome.alarms schedule opens the user's saved logged-in LinkedIn search in an
// unfocused window, runs the normal scan engine (which persists matches via TRIAGE),
// then reports the summary to the backend so it can Slack a digest of new matches.
const AUTO_ALARM = "jc-auto-scan";
const AUTO_DEFAULT_INTERVAL_MIN = 90;
const AUTO_MIN_INTERVAL_MIN = 30;
const AUTO_JITTER_MIN = 20; // total jitter range (± half of this)
/** LinkedIn paginates search results by 25. A catch-up run (first of the day, or
 *  nothing scanned for 12h) crawls 3 pages of the past 24h; an incremental run
 *  narrows f_TPR to ~2× the interval and crawls 2 pages — same coverage, about
 *  half the LinkedIn traffic over a day. */
const AUTO_SCAN_PAGES_FULL = 3;
const AUTO_SCAN_PAGES_INCREMENTAL = 2;
const LINKEDIN_PAGE_SIZE = 25;
const FULL_RANGE_SEC = 24 * 3600;
const MIN_INCREMENTAL_RANGE_SEC = 2 * 3600;
const FULL_SCAN_AFTER_MS = 12 * 3600 * 1000;
/** Active window (local time). Default = weekdays 07:00–17:00, the same hours
 *  scripts/keep-awake-tray.ps1 holds the PC awake. Outside it the alarm parks
 *  until the window next opens. */
const AUTO_WINDOW_DEFAULT = { days: [1, 2, 3, 4, 5], startHour: 7, endHour: 17 };
const AUTO_SCAN_TIMEOUT_MS = 6 * 60 * 1000;

async function autoScanSettings() {
  const v = await chrome.storage.local.get([
    "autoScanEnabled",
    "autoScanUrl",
    "autoScanIntervalMin",
    "autoScanWindow",
    "autoScanSmartRange",
    "autoScanLastRun",
  ]);
  const w = v.autoScanWindow || {};
  const hour = (x, dflt) => (Number.isFinite(Number(x)) && x !== "" && x != null ? Math.min(24, Math.max(0, Number(x))) : dflt);
  const days = Array.isArray(w.days) && w.days.length ? w.days.map(Number) : AUTO_WINDOW_DEFAULT.days;
  return {
    enabled: v.autoScanEnabled === true,
    url: (v.autoScanUrl || "").trim(),
    intervalMin: Math.max(AUTO_MIN_INTERVAL_MIN, Number(v.autoScanIntervalMin) || AUTO_DEFAULT_INTERVAL_MIN),
    window: {
      days,
      startHour: hour(w.startHour, AUTO_WINDOW_DEFAULT.startHour),
      endHour: hour(w.endHour, AUTO_WINDOW_DEFAULT.endHour),
    },
    // Rewrite f_TPR per run (24h catch-up vs. short incremental). Off = scan the
    // saved URL exactly as pasted, every run.
    smartRange: v.autoScanSmartRange !== false,
    lastRunAt: (v.autoScanLastRun && Number(v.autoScanLastRun.at)) || 0,
  };
}

function inActiveWindow(win, d = new Date()) {
  if (!win.days.includes(d.getDay())) return false;
  const h = d.getHours() + d.getMinutes() / 60;
  return h >= win.startHour && h < win.endHour;
}

/** Minutes from `d` until the window next opens (0 when it is open at `d`). */
function minutesUntilWindowOpens(win, d = new Date()) {
  if (inActiveWindow(win, d)) return 0;
  for (let i = 0; i < 8; i++) {
    const c = new Date(d);
    c.setDate(d.getDate() + i);
    c.setHours(win.startHour, 0, 0, 0);
    if (win.days.includes(c.getDay()) && c > d) return Math.ceil((c - d) / 60000);
  }
  return 24 * 60; // no active days configured — check again tomorrow
}

async function scheduleNextAutoScan(delayMinOverride) {
  if (!hasApi("alarms")) return false;
  const s = await autoScanSettings();
  if (!s.enabled || !s.url) {
    await chrome.alarms.clear(AUTO_ALARM);
    return false;
  }
  let delay;
  if (delayMinOverride != null) delay = delayMinOverride;
  else delay = s.intervalMin + (Math.random() * AUTO_JITTER_MIN - AUTO_JITTER_MIN / 2);
  // Would that land outside the window? Park until it opens (+ a few minutes of
  // stagger so the 07:00 run doesn't hit LinkedIn at exactly the same second daily).
  const wait = minutesUntilWindowOpens(s.window, new Date(Date.now() + delay * 60000));
  if (wait > 0) delay += wait + Math.random() * 5;
  await chrome.alarms.create(AUTO_ALARM, { delayInMinutes: Math.max(1, delay) });
  return true;
}

async function ensureAutoScanAlarm() {
  if (!hasApi("alarms")) return;
  const s = await autoScanSettings();
  if (!s.enabled || !s.url) return;
  const existing = await chrome.alarms.get(AUTO_ALARM);
  if (!existing) await scheduleNextAutoScan(3); // first run shortly after startup (parks if outside the window)
}

/** Which kind of run is due: a 24h catch-up (first of the day / long gap / manual)
 *  or a short incremental sweep. */
function autoScanPlan(s, trigger, now = Date.now()) {
  const full =
    trigger === "manual" || !s.smartRange || !s.lastRunAt || now - s.lastRunAt > FULL_SCAN_AFTER_MS;
  if (full) return { mode: "full", rangeSec: FULL_RANGE_SEC, pages: AUTO_SCAN_PAGES_FULL };
  const sinceLast = Math.ceil((now - s.lastRunAt) / 1000);
  return {
    mode: "incremental",
    rangeSec: Math.max(MIN_INCREMENTAL_RANGE_SEC, 2 * sinceLast),
    pages: AUTO_SCAN_PAGES_INCREMENTAL,
  };
}

// SCAN_DONE resolvers for in-flight auto scans, keyed by tab id.
const pendingScans = new Map();

function waitForScanDone(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingScans.delete(tabId);
      resolve(null);
    }, timeoutMs);
    pendingScans.set(tabId, (payload) => {
      clearTimeout(timer);
      pendingScans.delete(tabId);
      resolve(payload);
    });
  });
}

let autoScanRunning = false;

async function runAutoScan(trigger) {
  // Needs a second, unfocused window to crawl in — desktop only. On a phone the
  // server-side LinkedIn scan (dashboard → Captures) covers the same ground.
  if (!hasApi("windows")) {
    return { ok: false, error: "auto-scan needs a desktop browser — use the dashboard's LinkedIn scan instead" };
  }
  const s = await autoScanSettings();
  if (!s.url) return { ok: false, error: "no search URL saved" };
  if (autoScanRunning) return { ok: false, error: "auto-scan already running" };
  autoScanRunning = true;

  const plan = autoScanPlan(s, trigger);
  const summary = {
    source: "linkedin-auto",
    scanned: 0,
    strong: 0,
    maybe: 0,
    persisted: 0,
    cancelled: false,
    error: null,
  };
  /** The search URL with the run's time range and LinkedIn's pagination offset applied. */
  const pageUrl = (base, page) => {
    try {
      const u = new URL(base);
      if (s.smartRange) u.searchParams.set("f_TPR", `r${plan.rangeSec}`);
      if (page > 0) u.searchParams.set("start", String(page * LINKEDIN_PAGE_SIZE));
      else u.searchParams.delete("start");
      return u.toString();
    } catch {
      return base;
    }
  };

  let win = null;
  try {
    // Unfocused but NOT minimized: a visible window's active tab is exempt from
    // Chrome's hidden-tab timer throttling, which would stall the scan loop.
    win = await chrome.windows.create({
      url: pageUrl(s.url, 0),
      focused: false,
      state: "normal",
      width: 1250,
      height: 900,
    });
    const tabId = win.tabs && win.tabs[0] && win.tabs[0].id;
    if (tabId == null) throw new Error("could not open scan window");

    // Crawl the plan's result pages (&start=25·n), re-running the scan engine on
    // each. Backend dedup makes cross-page overlap harmless; an empty or
    // cancelled page ends the crawl early.
    for (let page = 0; page < plan.pages; page++) {
      if (page > 0) await chrome.tabs.update(tabId, { url: pageUrl(s.url, page) });
      await waitTabComplete(tabId, 30000);
      await new Promise((r) => setTimeout(r, 4000)); // let the SPA settle

      // Flag auto mode in the scan scripts' isolated world before injecting them.
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          window.__JCSCAN_AUTO = true;
        },
      });
      const done = waitForScanDone(tabId, AUTO_SCAN_TIMEOUT_MS);
      const injected = await injectScan({ tabId });
      if (!injected.ok) throw new Error(injected.error || "scan injection failed");

      const result = await done;
      if (!result) throw new Error(`scan timed out (page ${page + 1})`);
      summary.scanned += result.total || 0;
      summary.strong += (result.counts && result.counts.strong) || 0;
      summary.maybe += (result.counts && result.counts.maybe) || 0;
      summary.persisted += result.persisted || 0;
      summary.cancelled = !!result.cancelled;
      if (result.error) summary.error = result.error;
      if (summary.cancelled || summary.error || (result.total || 0) === 0) break;
    }
  } catch (e) {
    summary.error = String((e && e.message) || e);
  } finally {
    if (win && win.id != null) chrome.windows.remove(win.id).catch(() => {});
    autoScanRunning = false;
  }

  const report = await http("/scan/report", { method: "POST", body: JSON.stringify(summary) });
  await chrome.storage.local.set({
    autoScanLastRun: {
      at: Date.now(),
      trigger: trigger || "alarm",
      mode: plan.mode,
      rangeSec: plan.rangeSec,
      pages: plan.pages,
      ...summary,
      reported: !!report.ok,
      notified: report.ok && report.data ? report.data.notified : null,
    },
  });
  return { ok: !summary.error, ...summary };
}

onOptional("alarms", "onAlarm", async (alarm) => {
  if (alarm.name === PREFILL_ALARM) {
    try {
      await prefillPoll("alarm");
    } catch (e) {
      console.warn("[jobcapture] prefill poll failed:", e);
    }
    return;
  }
  if (alarm.name !== AUTO_ALARM) return;
  try {
    const s = await autoScanSettings();
    if (s.enabled && s.url && inActiveWindow(s.window)) await runAutoScan("alarm");
  } catch (e) {
    console.warn("[jobcapture] auto-scan failed:", e);
  } finally {
    scheduleNextAutoScan();
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureAutoScanAlarm();
});
// The MV3 service worker is restarted on demand; an alarm lost to an extension
// reload / crash would otherwise stay lost until the next browser start. Re-arm
// on every worker start (no-op when the alarm exists or auto-scan is off).
ensureAutoScanAlarm().catch(() => {});
ensurePrefillAlarm().catch(() => {});
preferLocalBackend().catch(() => {});

/**
 * A backend URL saved as this PC's own remote address plus a token for a
 * *different* account would authenticate every call as that account and make
 * the field helper offer the wrong profile. Loopback is always the
 * owner on the PC that runs the backend, so whenever the backend answers on
 * loopback, use loopback — the remote URL only matters on another device.
 */
async function preferLocalBackend() {
  const b = await base();
  if (LOOPBACK_RE.test(b)) return;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(DEFAULT_BASE + "/health", { signal: ctrl.signal });
    if (!res.ok) return;
    console.warn(`[jobcapture] backend runs on this PC — using ${DEFAULT_BASE} instead of ${b}`);
    await chrome.storage.local.set({ backendBase: DEFAULT_BASE });
  } catch {
    /* no local backend: keep the remote URL */
  } finally {
    clearTimeout(t);
  }
}

// ---- Prefill-ahead (phone decides, desktop fills) ---------------------------
// A 1-minute alarm polls GET /prefill/next. The backend hands back parked tabs to
// close, parked forms to re-fill (new banked answers from the phone), and at most
// one queued job to open. Jobs open in a dedicated UNFOCUSED window with the
// engine's #jh-apply=<id>&jh-prefill=1 hand-off; the engine fills, stops before
// Submit, and reports PREFILL_READY (field table + open questions + screenshot).
// The tab then stays parked until the human submits, skips, or the 12h TTL.
const PREFILL_ALARM = "jc-prefill-poll";
const PREFILL_POLL_MIN = 1;
let prefillPolling = false;

async function prefillSettings() {
  const v = await chrome.storage.local.get(["prefillEnabled"]);
  return { enabled: v.prefillEnabled !== false }; // default ON
}

async function ensurePrefillAlarm() {
  if (!hasApi("alarms")) return false;
  const s = await prefillSettings();
  if (!s.enabled) {
    await chrome.alarms.clear(PREFILL_ALARM);
    return false;
  }
  const existing = await chrome.alarms.get(PREFILL_ALARM);
  if (!existing) {
    await chrome.alarms.create(PREFILL_ALARM, { delayInMinutes: 1, periodInMinutes: PREFILL_POLL_MIN });
  }
  return true;
}

/** The dedicated prefill window (survives service-worker restarts via session storage). */
async function prefillWindowId() {
  try {
    const { prefillWindowId } = await chrome.storage.session.get("prefillWindowId");
    if (prefillWindowId == null) return null;
    const w = await chrome.windows.get(prefillWindowId);
    return w ? w.id : null;
  } catch {
    return null;
  }
}

async function openPrefillTab(next) {
  let tab = null;
  try {
    const windowId = await prefillWindowId();
    if (windowId == null) {
      // Unfocused but not minimized — the active tab of a visible window is exempt
      // from Chrome's background-tab timer throttling (same reason as auto-scan).
      const win = await chrome.windows.create({
        url: next.url,
        focused: false,
        state: "normal",
        width: 1250,
        height: 950,
      });
      await chrome.storage.session.set({ prefillWindowId: win.id });
      tab = win.tabs && win.tabs[0];
    } else {
      tab = await chrome.tabs.create({ windowId, url: next.url, active: true });
    }
  } catch (e) {
    void dbg("prefill-open-FAILED", { jobId: next.jobId, error: String((e && e.message) || e) });
  }
  if (!tab || tab.id == null) {
    await http(`/prefill/${next.jobId}/failed`, {
      method: "POST",
      body: JSON.stringify({ reason: "could not open a tab for the form" }),
    });
    return false;
  }
  await chrome.storage.session.set({ [`prefillTab:${tab.id}`]: next.jobId });
  await http(`/prefill/${next.jobId}/started`, { method: "POST", body: JSON.stringify({ tabId: tab.id }) });
  void dbg("prefill-open", { jobId: next.jobId, tabId: tab.id, url: next.url });
  return true;
}

async function prefillPoll(trigger) {
  const s = await prefillSettings();
  if (!s.enabled && trigger !== "manual") return { ok: false, error: "prefill disabled" };
  if (prefillPolling) return { ok: false, error: "prefill poll already running" };
  prefillPolling = true;
  try {
    const res = await http("/prefill/next");
    if (!res.ok) return res;
    const work = res.data || {};
    for (const c of work.close || []) {
      try {
        await chrome.tabs.remove(c.tabId);
      } catch {
        /* already gone */
      }
      await chrome.storage.session.remove(`prefillTab:${c.tabId}`).catch(() => {});
      await http(`/prefill/${c.jobId}/closed`, { method: "POST" });
      void dbg("prefill-close", { jobId: c.jobId, tabId: c.tabId, reason: c.reason });
    }
    for (const r of work.refills || []) {
      try {
        await chrome.tabs.sendMessage(r.tabId, { type: "PREFILL_REFILL", jobId: r.jobId });
        void dbg("prefill-refill", { jobId: r.jobId, tabId: r.tabId });
      } catch (e) {
        // No listener in that tab: Chrome restarted (tab gone) or the extension was
        // reloaded (content script orphaned — seen 2026-09-09). Either way, drop the
        // tab and release the slot; the backend re-opens the form on the next poll.
        try {
          await chrome.tabs.remove(r.tabId);
        } catch {
          /* already gone */
        }
        await chrome.storage.session.remove(`prefillTab:${r.tabId}`).catch(() => {});
        await http(`/prefill/${r.jobId}/closed`, { method: "POST" });
        void dbg("prefill-refill-NO-TAB", { jobId: r.jobId, tabId: r.tabId, error: String((e && e.message) || e) });
      }
    }
    let opened = false;
    if (work.next) opened = await openPrefillTab(work.next);
    return {
      ok: true,
      opened,
      closed: (work.close || []).length,
      refills: (work.refills || []).length,
      active: work.active ?? null,
      cap: work.cap ?? null,
    };
  } finally {
    prefillPolling = false;
  }
}

/** Screenshot of a parked tab (only possible while it is the active tab of its window). */
async function captureTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return undefined;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 50 });
    return (dataUrl || "").split(",")[1];
  } catch {
    return undefined;
  }
}

// A parked tab closed by hand releases its slot.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const key = `prefillTab:${tabId}`;
    const v = await chrome.storage.session.get([key, `assistJob:${tabId}`]);
    const jobId = v[key];
    await chrome.storage.session.remove([key, `assistJob:${tabId}`]).catch(() => {});
    if (!jobId) return;
    await http(`/prefill/${jobId}/closed`, { method: "POST" });
  } catch {
    /* ignore */
  }
});

// ---- Apply stream (chained batch apply) ------------------------------------
// After the human submits job N, the engine's RECORD_APPLY carries a streamId;
// we advance the stream on the backend and navigate the SAME tab to job N+1
// (whose URL carries the #jh-apply hash, so the engine re-injects and fills).
// The grace delay lets the user see the ✅ / ATS confirmation before moving on.
const STREAM_NEXT_DELAY_MS = 4000;
const pendingStreamNavs = new Map(); // streamId -> timeout id

// ---- Field helper (presets + résumé attach on any site) --------------------
// The overlay lives in assist.js. We remember which job a tab is filling so
// that login pages and Next-button navigations (which drop #jh-apply) still
// know which résumé to attach.
function parseApplyId(url) {
  const m = String(url || "").match(/[#&?]jh-apply=([a-z0-9]+)/i);
  return m ? m[1] : null;
}

async function bindAssistJob(tabId, jobId) {
  if (tabId == null || !jobId) return;
  try {
    await chrome.storage.session.set({ [`assistJob:${tabId}`]: jobId });
  } catch {
    /* session storage missing — overlay still works for this page load via hash */
  }
}

async function boundAssistJob(tabId) {
  if (tabId == null) return null;
  try {
    const key = `assistJob:${tabId}`;
    const v = await chrome.storage.session.get(key);
    return v[key] || null;
  } catch {
    return null;
  }
}

async function ensureAssistEverywhere() {
  if (!chrome.scripting || typeof chrome.scripting.registerContentScripts !== "function") return false;
  const have =
    typeof chrome.permissions?.contains === "function"
      ? await chrome.permissions.contains({ origins: ["https://*/*"] })
      : false;
  if (!have) return false;
  const existing =
    typeof chrome.scripting.getRegisteredContentScripts === "function"
      ? await chrome.scripting.getRegisteredContentScripts({ ids: ["jh-assist"] }).catch(() => [])
      : [];
  if (existing && existing.length) return true;
  await chrome.scripting.registerContentScripts([
    {
      id: "jh-assist",
      matches: ["https://*/*", "http://*/*"],
      excludeMatches: ["http://127.0.0.1/*", "http://localhost/*"],
      js: ["jobKey.js", "applyCore.js", "assist.js"],
      allFrames: true,
      runAt: "document_idle",
      persistAcrossSessions: true,
    },
  ]);
  return true;
}

async function disableAssistEverywhere() {
  if (chrome.scripting && typeof chrome.scripting.unregisterContentScripts === "function") {
    await chrome.scripting.unregisterContentScripts({ ids: ["jh-assist"] }).catch(() => {});
  }
}

async function injectAssistIntoTab(tabId) {
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
    return { ok: false, error: "scripting unavailable" };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["jobKey.js", "applyCore.js", "assist.js"],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

onOptional("tabs", "onUpdated", (tabId, info, tab) => {
  const url = (tab && tab.url) || info.url || "";
  const id = parseApplyId(url);
  if (id) void bindAssistJob(tabId, id);
});

void (async () => {
  try {
    const v = await chrome.storage.local.get("assistEverywhere");
    if (v.assistEverywhere) await ensureAssistEverywhere();
  } catch (e) {
    console.info("[jobcapture] assist register skipped", e);
  }
})();
/** jobId -> [{label, value, source}] — what the Copilot panel recommended;
 *  STEP_SNAPSHOT reconciles submitted values against this. */
const panelSuggestions = new Map();

/**
 * Debug reporter — every stream step lands in the backend's apply-debug log
 * (logs/apply-debug.jsonl + GET /debug/apply) so a stuck run is diagnosable
 * after the fact. `shotTabId` attaches a screenshot when that tab is active.
 * Never throws, never blocks the caller's flow.
 */
async function dbg(event, data, shotTabId) {
  try {
    let screenshotBase64;
    if (shotTabId != null) {
      try {
        const tab = await chrome.tabs.get(shotTabId);
        if (tab.active) {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format: "jpeg",
            quality: 60,
          });
          screenshotBase64 = (dataUrl || "").split(",")[1];
        }
      } catch {
        /* no screenshot — the event still logs */
      }
    }
    await http("/debug/apply", {
      method: "POST",
      body: JSON.stringify({ event, data, screenshotBase64 }),
    });
  } catch {
    /* debug must never break the feature it debugs */
  }
}

async function streamAdvance({ streamId, afterId, tabId, immediate }) {
  void dbg("advance-request", { streamId, afterId, tabId, immediate: !!immediate });
  const res = await http(`/apply-stream/${streamId}/advance`, {
    method: "POST",
    body: JSON.stringify({ afterId }),
  });
  if (!res.ok) {
    void dbg("advance-FAILED", { streamId, afterId, error: res.error, status: res.status }, tabId);
    return res;
  }
  const { done, next } = res.data || {};
  void dbg("advance-response", { streamId, done: !!done, nextId: next?.id ?? null, nextIndex: next?.index ?? null });
  if (tabId == null) {
    void dbg("advance-NO-TAB", { streamId, afterId });
    return res;
  }
  const nav = async () => {
    pendingStreamNavs.delete(streamId);
    const url = done || !next ? (await base()) + "/?stream=done" : next.url;
    try {
      await chrome.tabs.update(tabId, { url });
      void dbg("nav-ok", { streamId, tabId, url });
    } catch (e) {
      // tab closed — the stream simply stops; restart it from the dashboard
      void dbg("nav-FAILED", { streamId, tabId, url, error: String((e && e.message) || e) });
    }
  };
  const prior = pendingStreamNavs.get(streamId);
  if (prior) clearTimeout(prior);
  if (immediate) await nav();
  else pendingStreamNavs.set(streamId, setTimeout(nav, STREAM_NEXT_DELAY_MS));
  return res;
}

const handlers = {
  INGEST: (jobs) => http("/jobs/ingest", { method: "POST", body: JSON.stringify({ jobs }) }),
  EVENT: (e) => http("/events", { method: "POST", body: JSON.stringify(e) }),
  REFERRAL_INGEST: (r) => http("/referrals/ingest", { method: "POST", body: JSON.stringify(r) }),
  PAGE_CAPTURE: (c) => http("/page-captures", { method: "POST", body: JSON.stringify(c) }),
  SEEN: (keys) => http(`/jobs/seen?keys=${encodeURIComponent(keys.join(","))}`),
  LIST: (q) => http(`/jobs${q || "?limit=100"}`),
  PATCH_STATE: ({ id, state }) =>
    http(`/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ state }) }),
  GENERATE_RESUME: ({ id }) => http(`/jobs/${id}/generate-resume`, { method: "POST" }),
  HEALTH: () => http("/health"),
  // --- list triage (Scan this page) ---
  TRIAGE: (payload) => http("/jobs/triage", { method: "POST", body: JSON.stringify(payload) }),
  SITE_ADAPTER: (payload) => http("/scan/site-adapter", { method: "POST", body: JSON.stringify(payload) }),
  MATCH_FACTS: () => http("/profile/match-facts"),
  // Apply assist: all backend traffic goes through the worker, because content-script
  // fetches are subject to the PAGE's CSP (Ashby's connect-src blocks localhost, which
  // hung the engine silently) — the worker's fetches are not.
  APPLY_FIELDS: () => http("/profile/apply-fields"),
  APPLY_PACKAGE: ({ id }) => http(`/jobs/${id}/apply-package`),
  ASSIST_BIND: async ({ jobId }, sender) => {
    await bindAssistJob(sender?.tab?.id, jobId);
    return { ok: true };
  },
  ASSIST_CONTEXT: async ({ url, keys } = {}, sender) => {
    const tabId = sender?.tab?.id;
    const tabUrl = sender?.tab?.url || url || "";
    let jobId = parseApplyId(tabUrl) || parseApplyId(url) || (await boundAssistJob(tabId));
    if (!jobId && Array.isArray(keys) && keys.length) {
      const seen = await http(`/jobs/seen?keys=${encodeURIComponent(keys.join(","))}`);
      const hit = seen.ok && seen.data ? keys.map((k) => seen.data[k]).find(Boolean) : null;
      if (hit && hit.id) jobId = hit.id;
    }
    if (jobId) await bindAssistJob(tabId, jobId);
    const fieldsRes = await http("/profile/apply-fields");
    if (!fieldsRes.ok) return fieldsRes;
    let title = null;
    let company = null;
    let resumeReady = false;
    if (jobId) {
      const jobRes = await http(`/jobs/${jobId}`);
      if (jobRes.ok && jobRes.data) {
        title = jobRes.data.title || null;
        company = jobRes.data.company || null;
        resumeReady = jobRes.data.resume && jobRes.data.resume.status === "ready";
      }
    }
    return { ok: true, data: { jobId, fields: fieldsRes.data, title, company, resumeReady } };
  },
  ASSIST_EVERYWHERE_STATUS: async () => {
    const v = await chrome.storage.local.get("assistEverywhere");
    const granted =
      typeof chrome.permissions?.contains === "function"
        ? await chrome.permissions.contains({ origins: ["https://*/*"] })
        : false;
    return { ok: true, enabled: v.assistEverywhere === true && granted, granted };
  },
  ASSIST_EVERYWHERE_APPLY: async ({ enabled }) => {
    if (enabled) {
      await chrome.storage.local.set({ assistEverywhere: true });
      const registered = await ensureAssistEverywhere();
      return { ok: true, enabled: registered, registered };
    }
    await chrome.storage.local.set({ assistEverywhere: false });
    await disableAssistEverywhere();
    return { ok: true, enabled: false };
  },
  ASSIST_INJECT_TAB: async ({ tabId, origin } = {}, sender) => {
    const id = tabId ?? sender?.tab?.id;
    if (id == null) return { ok: false, error: "no tab" };
    if (origin && typeof chrome.permissions?.request === "function") {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) return { ok: false, error: "permission declined" };
    }
    return injectAssistIntoTab(id);
  },
  ANSWER_SCREENING: (payload) =>
    http("/profile/answer-screening", { method: "POST", body: JSON.stringify(payload) }),
  RECORD_APPLY: async ({ id, notes, streamId }, sender) => {
    const res = await http(`/jobs/${id}/apply`, { method: "POST", body: JSON.stringify({ notes }) });
    void dbg("record", { jobId: id, streamId: streamId ?? null, ok: res.ok, error: res.error ?? null, senderTab: sender?.tab?.id ?? null });
    // Stream mode: advance to the next job in the same tab after a grace delay.
    // Fire-and-forget so recording still resolves if the advance fails.
    if (streamId && sender?.tab?.id != null) {
      void streamAdvance({ streamId, afterId: id, tabId: sender.tab.id });
    }
    return res;
  },
  /** Copilot panel: job detail (+ résumé status) for the resolved tab job. */
  JOB_GET: ({ id }) => http(`/jobs/${id}`),
  /** Panel registers what it RECOMMENDED for a job — STEP_SNAPSHOT diffs the
   *  actually-submitted values against this (the improvement dataset). */
  SUGGESTIONS_SET: ({ jobId, suggestions }) => {
    panelSuggestions.set(jobId || "unknown", suggestions || []);
    return { ok: true };
  },
  /**
   * Step snapshot from the injected observer: fields as they are the moment a
   * wizard step advances (multi-step forms unmount earlier steps before the
   * final submit, so submit-time capture alone loses them). Reconciles against
   * the panel's registered recommendations and banks the human's own answers.
   */
  STEP_SNAPSHOT: async ({ jobId, url, fields, trigger }) => {
    const suggestions = panelSuggestions.get(jobId || "unknown") || [];
    const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const byLabel = new Map(suggestions.map((s) => [norm(s.label), s]));
    const counts = { accepted: 0, human: 0, humanEdited: 0, empty: 0 };
    const judged = (fields || []).map((f) => {
      const sug = byLabel.get(norm(f.label));
      const verdict = !f.value
        ? "empty"
        : sug == null
          ? "human"
          : norm(f.value) === norm(String(sug.value ?? ""))
            ? "accepted"
            : "human-edited";
      counts[verdict === "human-edited" ? "humanEdited" : verdict]++;
      return { label: f.label, value: (f.value || "").slice(0, 2000), verdict, suggested: sug ? String(sug.value ?? "").slice(0, 500) : null };
    });
    void dbg("step-snapshot", { jobId: jobId || null, trigger: trigger || "step-click", url: (url || "").slice(0, 120), fields: judged });
    // Bank the human's own words — same rules as the engine's submit snapshot.
    const NO_BANK_RE = /name|email|phone|linkedin|website|portfolio|github|location|city|resume|cover letter/i;
    const answers = {};
    for (const f of judged) {
      if ((f.verdict === "human" || f.verdict === "human-edited") && f.label.length >= 8 && !NO_BANK_RE.test(f.label)) {
        answers[f.label] = f.value;
      }
    }
    if (Object.keys(answers).length) {
      await http("/profile/bank-answers", { method: "POST", body: JSON.stringify({ answers }) });
    }
    return { ok: true, judged: judged.length, banked: Object.keys(answers).length, counts };
  },
  /** Panel: the live stream + its current job (drives manual-mode jobs). */
  STREAM_STATUS: () => http("/apply-stream/current"),
  /** Panel "✓ Applied → next": record the application, then advance + navigate. */
  STREAM_MARK_APPLIED: async ({ streamId, jobId, tabId }) => {
    const rec = await http(`/jobs/${jobId}/apply`, {
      method: "POST",
      body: JSON.stringify({ notes: `copilot panel · ${new Date().toISOString().slice(0, 10)}` }),
    });
    void dbg("panel-mark-applied", { jobId, streamId, ok: rec.ok, error: rec.error ?? null });
    return streamAdvance({ streamId, afterId: jobId, tabId, immediate: true });
  },
  /** Copilot panel: copy this job's tailored PDF into the fixed outbox folder. */
  STAGE_RESUME: ({ id }) => http(`/jobs/${id}/stage-resume`, { method: "POST" }),
  /** Copilot panel: open the job's artifact folder in the OS file explorer. */
  OPEN_FOLDER: ({ id }) => http(`/jobs/${id}/open-folder`, { method: "POST" }),
  /** Bank the human's own submit-time answers so the next form asking the same
   *  question auto-fills. Server enforces size caps. */
  BANK_ANSWERS: async ({ answers }) => {
    const res = await http("/profile/bank-answers", { method: "POST", body: JSON.stringify({ answers }) });
    void dbg("bank-answers", { count: Object.keys(answers || {}).length, ok: res.ok, error: res.error ?? null });
    return res;
  },
  /** Engine-side debug report (stuck watchdog, fill summaries). `screenshot:
   *  true` attaches a capture of the sender's tab. */
  DEBUG_LOG: (p, sender) =>
    dbg(p.event, { ...(p.data || {}), url: sender?.url ?? null }, p.screenshot ? sender?.tab?.id : undefined).then(
      () => ({ ok: true })
    ),
  /** The frame's own tab URL — an embedded Greenhouse iframe can't read the
   *  top frame's #jh-apply hash cross-origin, but sender.tab.url carries it. */
  TAB_URL: (p, sender) => ({ ok: true, data: { url: sender?.tab?.url ?? null } }),
  /** Skip the current stream job: a decision, not a deferral — mark it skipped
   *  (same as the dashboard Skip) so it leaves the queue and never re-enters a
   *  future stream, then advance immediately. */
  STREAM_SKIP: async ({ streamId, afterId, tabId }, sender) => {
    const patched = await http(`/jobs/${afterId}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "skipped" }),
    });
    void dbg("stream-skip", { streamId, afterId, stateSet: patched.ok, error: patched.error ?? null });
    // sender.tab exists for content-script callers (the engine); the panel is an
    // extension page with no tab, so it passes the target tabId explicitly.
    return streamAdvance({ streamId, afterId, tabId: sender?.tab?.id ?? tabId, immediate: true });
  },
  /** End the stream: cancel any pending navigation and drop it on the backend. */
  STREAM_STOP: ({ streamId }) => {
    const t = pendingStreamNavs.get(streamId);
    if (t) {
      clearTimeout(t);
      pendingStreamNavs.delete(streamId);
    }
    return http(`/apply-stream/${streamId}`, { method: "DELETE" });
  },
  /** Tailored résumé as base64 (Blobs can't cross the messaging boundary). */
  RESUME_PDF: async ({ id }) => {
    try {
      const res = await fetch(`${await base()}/jobs/${id}/resume/file?format=pdf`);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      // Company-specific filename from Content-Disposition — the name the ATS
      // shows in its attachment chip.
      const cd = res.headers.get("content-disposition") || "";
      const filename = (cd.match(/filename="([^"]+)"/) || [])[1] || "resume.pdf";
      const buf = new Uint8Array(await res.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      }
      return { ok: true, data: { base64: btoa(bin), bytes: buf.length, filename } };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  },
  FETCH_JD: (payload) => fetchJd(payload),
  OPEN_TAB_SCRAPE: (payload) => openTabScrape(payload),
  SCAN_PAGE: (payload) => injectScan(payload),
  AUTO_SCAN_NOW: () => runAutoScan("manual"),
  AUTO_SCAN_APPLY: async () => ({ ok: true, scheduled: await scheduleNextAutoScan() }),
  AUTO_SCAN_STATUS: async () => {
    const s = await autoScanSettings();
    const alarm = hasApi("alarms") ? await chrome.alarms.get(AUTO_ALARM) : undefined;
    return {
      ok: true,
      enabled: s.enabled && !!s.url,
      running: autoScanRunning,
      inWindow: inActiveWindow(s.window),
      nextAt: alarm ? alarm.scheduledTime : null,
      plan: autoScanPlan(s, "alarm"),
    };
  },
  // --- prefill-ahead ---
  /** Engine (prefill mode) finished its fill pass: field table + open questions. */
  PREFILL_READY: async (p, sender) => {
    const tabId = sender?.tab?.id;
    const screenshotBase64 = tabId != null ? await captureTab(tabId) : undefined;
    const res = await http(`/prefill/${p.jobId}/ready`, {
      method: "POST",
      body: JSON.stringify({
        fields: p.fields || [],
        unanswered: p.unanswered || [],
        resumeState: p.resumeState ?? null,
        drafted: p.drafted || 0,
        screenshotBase64,
      }),
    });
    void dbg("prefill-ready", {
      jobId: p.jobId,
      tabId: tabId ?? null,
      fields: (p.fields || []).length,
      unanswered: p.unanswered || [],
      ok: res.ok,
      error: res.error ?? null,
    });
    return res;
  },
  PREFILL_FAILED: async (p, sender) => {
    void dbg("prefill-FAILED", { jobId: p.jobId, tabId: sender?.tab?.id ?? null, reason: p.reason }, sender?.tab?.id);
    return http(`/prefill/${p.jobId}/failed`, {
      method: "POST",
      body: JSON.stringify({ reason: p.reason || "unknown" }),
    });
  },
  PREFILL_STATUS: async () => {
    const s = await prefillSettings();
    const alarm = hasApi("alarms") ? await chrome.alarms.get(PREFILL_ALARM) : undefined;
    return { ok: true, enabled: s.enabled, polling: prefillPolling, nextAt: alarm ? alarm.scheduledTime : null };
  },
  PREFILL_NOW: () => prefillPoll("manual"),
  PREFILL_APPLY: async () => ({ ok: true, scheduled: await ensurePrefillAlarm() }),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Auto-scan completion signal from the injected controller (needs sender.tab).
  if (msg?.type === "SCAN_DONE") {
    const tabId = sender.tab && sender.tab.id;
    const resolve = tabId != null ? pendingScans.get(tabId) : null;
    if (resolve) resolve(msg.payload || {});
    sendResponse({ ok: true });
    return false;
  }
  const handler = handlers[msg?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `unknown message ${msg?.type}` });
    return false;
  }
  Promise.resolve(handler(msg.payload, sender)).then(sendResponse);
  return true;
});

function badgeOk(tabId) {
  if (!chrome.action?.setBadgeText) return;
  chrome.action.setBadgeText({ tabId, text: "✓" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#3ecf8e" });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), 4000);
}

function badgeErr(tabId, text) {
  console.warn("[jobcapture]", text);
  if (!chrome.action?.setBadgeText) return;
  chrome.action.setBadgeText({ tabId, text: "!" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#e05a5a" });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), 4000);
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAutoScanAlarm();
  ensurePrefillAlarm();
  void ensureAssistEverywhere();
  // Touch browsers have no page context menu — the popup and the dashboard are
  // the entry points there.
  if (!hasApi("contextMenus")) return;
  chrome.contextMenus.create({
    id: "jc-open-copilot",
    title: "Open Apply Copilot (Job Hunt Assistant)",
    contexts: ["page"],
  });
  chrome.contextMenus.create({
    id: "jc-assist-page",
    title: "JobHunt: presets & résumé on this page",
    contexts: ["page", "editable"],
  });
  chrome.contextMenus.create({
    id: "jc-capture-jd",
    title: "Capture this job for Job Hunt Assistant",
    contexts: ["page", "selection", "link"],
  });
  chrome.contextMenus.create({
    id: "jc-mark-applied",
    title: "Mark this job applied (Job Hunt Assistant)",
    contexts: ["page"],
  });
  chrome.contextMenus.create({
    id: "jc-scan-list",
    title: "Scan this job list (Job Hunt Assistant)",
    contexts: ["page", "selection"],
  });
  // Ad-hoc capture from ANY page (Gmail, LinkedIn messaging, forums): select the
  // job text → right-click → the backend LLM extracts title/company/JD from it.
  chrome.contextMenus.create({
    id: "jc-capture-selection",
    title: "Capture selected text as job (Job Hunt Assistant)",
    contexts: ["selection"],
  });
});

onOptional("contextMenus", "onClicked", async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === "jc-open-copilot") {
    // Context-menu click is a valid user gesture for sidePanel.open.
    chrome.sidePanel.open({ tabId: tab.id }).catch((e) => console.warn("[jobcapture] sidePanel:", e));
    return;
  }

  if (info.menuItemId === "jc-assist-page") {
    try {
      const origin = tab.url ? new URL(tab.url).origin + "/*" : null;
      if (origin && typeof chrome.permissions?.request === "function") {
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) {
          badgeErr(tab.id, "permission declined");
          return;
        }
      }
      const res = await injectAssistIntoTab(tab.id);
      const id = parseApplyId(tab.url);
      if (id) await bindAssistJob(tab.id, id);
      if (res.ok) badgeOk(tab.id);
      else badgeErr(tab.id, res.error || "inject failed");
    } catch (e) {
      badgeErr(tab.id, (e && e.message) || "inject failed");
    }
    return;
  }

  if (info.menuItemId === "jc-scan-list") {
    const res = await injectScan({ tabId: tab.id });
    if (res.ok) badgeOk(tab.id);
    else badgeErr(tab.id, res.error || "scan failed");
    return;
  }

  if (info.menuItemId === "jc-capture-selection") {
    try {
      // info.selectionText flattens newlines — grab the real selection from the
      // page when we can (activeTab grants this on the user's right-click).
      let text = "";
      try {
        const [{ result } = {}] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => String(getSelection()),
        });
        text = (result || "").trim();
      } catch {
        /* chrome:// pages, PDF viewer — fall back to the flattened text */
      }
      if (!text) text = (info.selectionText || "").trim();
      if (text.length < 100) {
        badgeErr(tab.id, "Select the full job text first (100+ characters)");
        return;
      }
      const res = await http("/captures/from-text", {
        method: "POST",
        body: JSON.stringify({
          rawText: text,
          url: info.pageUrl && /^https?:/.test(info.pageUrl) ? info.pageUrl : undefined,
          source: "extension-selection",
        }),
      });
      if (!res.ok) {
        badgeErr(tab.id, res.error);
        return;
      }
      if (res.data && res.data.ok === false) {
        badgeErr(tab.id, res.data.error || "couldn't extract a job — use the dashboard paste card");
        return;
      }
      badgeOk(tab.id);
    } catch (e) {
      badgeErr(tab.id, (e && e.message) || "selection capture failed");
    }
    return;
  }

  if (info.menuItemId === "jc-capture-jd") {
    try {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["extract.js"],
      });
      const job = result;
      if (!job?.title) {
        badgeErr(tab.id, "Could not extract job title from this page");
        return;
      }
      if (
        job.source === "linkedin" &&
        (!job.rawText || job.rawText.length < 400 || !/about the job/i.test(job.rawText))
      ) {
        badgeErr(
          tab.id,
          "JD not found — click the job in the list so the detail panel is open, then capture again"
        );
        return;
      }
      const res = await http("/page-captures", { method: "POST", body: JSON.stringify(job) });
      if (!res.ok) {
        badgeErr(tab.id, res.error);
        return;
      }
      badgeOk(tab.id);
    } catch (e) {
      badgeErr(tab.id, (e && e.message) || "capture failed");
    }
    return;
  }

  if (info.menuItemId === "jc-mark-applied") {
    try {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["extract.js"],
      });
      const job = result;
      if (!job?.externalId && !job?.title) {
        badgeErr(tab.id, "Could not identify job on this page");
        return;
      }
      const keys = [];
      if (job.externalId) keys.push(`${job.source}:${String(job.externalId).trim()}`);
      const seenRes = await http(`/jobs/seen?keys=${encodeURIComponent(keys.join(","))}`);
      const entry = seenRes.ok && keys.length ? seenRes.data?.[keys[0]] : null;
      if (!entry?.id) {
        badgeErr(tab.id, "Job not in database — capture it first");
        return;
      }
      const patch = await http(`/jobs/${entry.id}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "applied" }),
      });
      if (!patch.ok) {
        badgeErr(tab.id, patch.error);
        return;
      }
      badgeOk(tab.id);
    } catch (e) {
      badgeErr(tab.id, (e && e.message) || "mark applied failed");
    }
  }
});
