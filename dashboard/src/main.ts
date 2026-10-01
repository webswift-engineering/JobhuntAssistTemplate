import { api, ApiError, type Job, type ApplyPackage, type HealthAlert } from "./api.js";

// ---- tiny DOM helper -------------------------------------------------------
type Child = Node | string | number | boolean | null | undefined;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, any>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== false && v != null) node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (!c) continue; // skip falsy guards ("", 0, null, false, undefined)
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function toast(msg: string, isErr = false) {
  const t = el("div", { class: `toast ${isErr ? "err" : ""}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function jobAge(j: Job): number {
  return j.posted_at ?? j.first_seen_at;
}

// ---- app state -------------------------------------------------------------
type Tab = "queue" | "captures" | "referrals" | "companies" | "keywords" | "profile";
// "apply" = the actionable queue (fresh, ≥ 70%, FTE, above the salary floor; résumé
// status on each card); "all" = browse everything with filters. The former
// "shortlist" mode was the same set minus the FTE/salary gates and was merged into it.
type QueueMode = "all" | "apply";
const state = {
  tab: "queue" as Tab,
  queueMode: (localStorage.getItem("jh-queue-mode") === "all" ? "all" : "apply") as QueueMode,
  // Default queue order: newest first (by posted/fetched hour) — freshest jobs on top.
  jobFilter: { state: "", source: "", sourceKind: "", employmentType: "", sort: localStorage.getItem("jh-queue-sort") || "first_seen" },
  pollRunning: false,
  scoringRunning: false,
};

/** Notify bar (NOTIFY_THRESHOLD default) — the "fresh matches" KPI counts at this score. */
const NOTIFY_BAR = 0.78;
/** Score bar for the shortlist view (matches the resume-pipeline gate). */
const SHORTLIST_MIN_SCORE = 0.7;

const THEMES = [
  { id: "apple", label: "iOS", title: "Apple Settings — grouped, SF, system blue", color: "#f2f2f7" },
  { id: "apple-dark", label: "iOS Dark", title: "OLED black, iOS dark", color: "#000000" },
  { id: "samsung", label: "One UI", title: "Samsung One UI — large type, soft cards", color: "#f5f5f5" },
  { id: "samsung-dark", label: "One UI Dark", title: "One UI on OLED", color: "#010101" },
] as const;
type ThemeId = (typeof THEMES)[number]["id"];

function currentTheme(): ThemeId {
  const legacy: Record<string, ThemeId> = {
    paper: "apple",
    field: "apple",
    lamp: "apple-dark",
    night: "apple-dark",
  };
  const v = localStorage.getItem("jh-theme");
  const mapped = v ? legacy[v] ?? v : "apple";
  return THEMES.some((t) => t.id === mapped) ? (mapped as ThemeId) : "apple";
}

function applyTheme(id: ThemeId): void {
  document.documentElement.dataset.theme = id;
  localStorage.setItem("jh-theme", id);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEMES.find((t) => t.id === id)!.color);
  document.querySelectorAll<HTMLButtonElement>(".theme-switch button").forEach((b) => {
    const on = b.dataset.themeId === id;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
}

function themeSwitch(): HTMLElement {
  const active = currentTheme();
  applyTheme(active);
  return el(
    "div",
    { class: "theme-switch", role: "radiogroup", "aria-label": "Look" },
    ...THEMES.map((t) =>
      el(
        "button",
        {
          type: "button",
          class: active === t.id ? "active" : "",
          role: "radio",
          "aria-checked": active === t.id ? "true" : "false",
          "data-theme-id": t.id,
          title: t.title,
          onclick: (e: Event) => {
            e.stopPropagation();
            applyTheme(t.id);
          },
        },
        t.label
      )
    )
  );
}

const app = document.getElementById("app")!;

/** KPI strip built in header() and mounted only on the Queue tab (not sticky). */
let queueKpis: HTMLElement | null = null;

function pageHead(title: string, sub?: string): HTMLElement {
  return el("div", { class: "page-head" }, el("h2", {}, title), sub ? el("p", { class: "muted" }, sub) : null);
}

let healthCache: { at: number; data: any } | null = null;
const HEALTH_TTL_MS = 15_000;

/** Remote (token) session — loopback sessions are always the owner with no login. */
function isRemoteSession(): boolean {
  return !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
}

/** Phone-sized viewport — matches the breakpoint in styles.css. There is no
 *  separate mobile frontend; the apply flow just changes shape here. */
function isPhone(): boolean {
  return window.matchMedia("(max-width: 640px)").matches;
}

/**
 * Copy to the clipboard, including over plain http.
 *
 * `navigator.clipboard` only exists in a secure context, and the recommended
 * remote setup is Tailscale over `http://` — so the phone, the one device that
 * needs the copy chips most, is exactly where the modern API is missing. The
 * fallback is the old execCommand dance, with the iOS-specific selection range
 * (`setSelectionRange` alone doesn't take on iOS Safari).
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = el("textarea", {
    readonly: "readonly",
    style: "position:fixed;top:0;left:0;opacity:0;font-size:16px",
  }) as HTMLTextAreaElement;
  ta.value = text;
  document.body.append(ta);
  try {
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

async function fetchHealth(): Promise<any | null> {
  const now = Date.now();
  if (healthCache && now - healthCache.at < HEALTH_TTL_MS) return healthCache.data;
  try {
    const data = await api.health();
    healthCache = { at: now, data };
    return data;
  } catch {
    return null;
  }
}

// ---- shared status poller ---------------------------------------------------
// ONE timer for the whole app: refreshes /health (+ /resume-pipeline while work is
// running), feeds the alert banner and statusbar in place, and triggers a single
// full render() when background work (poll / scoring / résumé pipeline) finishes.
type StatusSnapshot = { health: any | null; pipeline: any | null; at: number };

function statusActive(s: StatusSnapshot | null): boolean {
  if (!s) return false;
  const c = s.pipeline?.counts;
  return !!(
    s.health?.poll?.running ||
    s.health?.scoring?.running ||
    (c && (c.queued > 0 || c.running > 0))
  );
}

// The server bumps its in-memory dataVersion whenever jobs / captures / résumés
// change through ANY path (poll, extension capture, triage persist, scan report,
// discovery). Tracking the version we last rendered lets the poller refresh the
// view for changes that never flip a "running" flag — e.g. a capture arriving
// from the extension while the dashboard sits open.
let renderedDataVersion: number | null = null;

function userIsTyping(): boolean {
  const t = document.activeElement as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

const statusBus = {
  latest: null as StatusSnapshot | null,
  refreshing: false,
  async refresh(): Promise<void> {
    if (statusBus.refreshing) return;
    statusBus.refreshing = true;
    try {
      const [health, pipeline] = await Promise.all([
        api.health().catch(() => null),
        api.resumePipeline().catch(() => null),
      ]);
      if (!health && !pipeline) return; // backend offline — keep last known state
      const prev = statusBus.latest;
      statusBus.latest = { health, pipeline, at: Date.now() };
      if (health) healthCache = { at: Date.now(), data: health };
      state.pollRunning = health?.poll?.running ?? false;
      state.scoringRunning = health?.scoring?.running ?? false;
      updateAlertBar((health?.alerts as HealthAlert[]) ?? []);
      applyStatusToDom(statusBus.latest);
      const dv: number | null = typeof health?.dataVersion === "number" ? health.dataVersion : null;
      const active = statusActive(statusBus.latest);
      if (prev && statusActive(prev) && !active) {
        // Edge trigger: background work just finished → one full refresh so job
        // cards / badges / counts catch up (replaces the old per-badge timers).
        render();
        renderedDataVersion = dv;
      } else if (renderedDataVersion === null) {
        // First snapshot (or a server that predates dataVersion): baseline only.
        renderedDataVersion = dv;
      } else if (dv !== null && dv !== renderedDataVersion && !active && !userIsTyping()) {
        // Quiet-path change (capture / scan report / triage persist / state change
        // from another device). While work is active the finish edge above covers
        // it; while the user is typing we hold off and retry next tick.
        render();
        renderedDataVersion = dv;
      }
    } finally {
      statusBus.refreshing = false;
    }
  },
};

let lastStatusFetchAt = 0;
function startStatusPoller(): void {
  setInterval(() => {
    const interval = statusActive(statusBus.latest) ? 5_000 : 15_000;
    if (Date.now() - lastStatusFetchAt >= interval) {
      lastStatusFetchAt = Date.now();
      void statusBus.refresh();
    }
  }, 5_000);
  // Coming back to the tab: refresh right away if the snapshot is stale instead
  // of waiting for the next tick, so changes that happened while the tab was
  // hidden appear immediately.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastStatusFetchAt >= 15_000) {
      lastStatusFetchAt = Date.now();
      void statusBus.refresh();
    }
  });
  lastStatusFetchAt = Date.now();
  void statusBus.refresh();
}

// ---- alert banners (driven by /health alerts[]) -----------------------------
const ALERT_SNOOZE_MS = 30 * 60 * 1000;

function alertSnoozed(id: string): boolean {
  const raw = sessionStorage.getItem(`jh-alert-snooze:${id}`);
  return !!raw && Date.now() - Number(raw) < ALERT_SNOOZE_MS;
}

/** Recovery actions per alert id — a banner should offer a fix, not just an ✕. */
function alertActions(a: HealthAlert): HTMLElement | null {
  const actionBtn = (label: string, run: (b: HTMLButtonElement) => Promise<void>) => {
    const b = el("button", { class: "ghost", style: "margin-top:6px" }, label) as HTMLButtonElement;
    b.addEventListener("click", async () => {
      const orig = b.textContent!;
      b.disabled = true;
      b.textContent = "working…";
      try {
        await run(b);
      } catch (err) {
        toast((err as Error).message, true);
      } finally {
        b.disabled = false;
        b.textContent = orig;
      }
    });
    return b;
  };
  if (a.id === "boards_disabled") {
    // Probe the stored board (transient outages heal), then let DeepSeek propose
    // candidate boards — a candidate is only accepted after its public API
    // answers with live jobs. Boards that stay broken (company left the
    // supported ATSes entirely) can be muted: disabled but no longer nagging.
    return el(
      "div",
      { style: "display:flex;gap:8px;flex-wrap:wrap" },
      actionBtn("🔧 Recover boards (probe + AI)", async () => {
        const r = await api.recoverBoards();
        const parts = r.results.map((x) =>
          x.outcome === "switched"
            ? `${x.name}: moved → ${x.ats}/${x.boardToken} ✓`
            : x.outcome === "reenabled"
              ? `${x.name}: back online ✓`
              : `${x.name}: still broken (${x.tried ?? 0} candidates probed) — mute it if the company left these ATSes`
        );
        toast(parts.join(" · ") || "No disabled boards found");
        void statusBus.refresh();
      }),
      actionBtn("🔇 Mute broken boards", async () => {
        const r = await api.acknowledgeBoards();
        toast(`${r.acknowledged} board(s) muted — still disabled, no longer alerting (Companies tab to revisit)`);
        void statusBus.refresh();
      })
    );
  }
  if (a.id === "scan_watch_stalled") {
    // The extension's watch is client-side; the server can't restart Chrome —
    // but it CAN run the same LinkedIn search via the guest API and record a
    // scan run, which covers the gap and clears this alert.
    return actionBtn("▶ Run fallback scan (server)", async () => {
      const p = await api.profile();
      const url = (p.preferences.searchLinks as Record<string, string> | undefined)?.linkedin;
      if (!url) {
        toast("Save your LinkedIn search URL in Profile → Morning Slack links first", true);
        return;
      }
      const r = await api.scanLinkedIn(url, { maxJobs: 75 }); // ~3 LinkedIn pages
      await api.reportScan({
        source: "dashboard-fallback",
        scanned: r.scanned,
        strong: r.strong,
        maybe: r.maybe,
        persisted: r.persisted,
      });
      toast(`Fallback scan: ${r.scanned} scanned · ${r.strong} strong · ${r.persisted} saved to queue`);
      void statusBus.refresh();
    });
  }
  return null;
}

function alertItem(a: HealthAlert): HTMLElement {
  // Signature excludes `since` so the relative time doesn't churn the DOM each tick.
  const sig = `${a.severity}|${a.title}|${a.detail ?? ""}|${a.count ?? ""}`;
  const item = el(
    "div",
    { class: `alert-item ${a.severity === "error" ? "err" : "warn"}`, "data-alert-id": a.id, "data-alert-sig": sig },
    el(
      "div",
      { class: "alert-text" },
      el("b", {}, a.title),
      a.detail ? el("div", { class: "alert-detail" }, a.detail) : null,
      a.since ? el("span", { class: "alert-since" }, `since ${timeAgo(a.since)}`) : null,
      alertActions(a)
    ),
    el(
      "button",
      {
        class: "alert-x",
        title: "Snooze this alert for 30 minutes",
        onclick: () => {
          sessionStorage.setItem(`jh-alert-snooze:${a.id}`, String(Date.now()));
          item.remove();
        },
      },
      "×"
    )
  );
  return item;
}

function updateAlertBar(alerts: HealthAlert[]): void {
  const box = document.getElementById("alerts");
  if (!box) return;
  const visible = alerts.filter((a) => !alertSnoozed(a.id));
  const keep = new Set(visible.map((a) => a.id));
  for (const node of Array.from(box.querySelectorAll("[data-alert-id]"))) {
    if (!keep.has(node.getAttribute("data-alert-id")!)) node.remove();
  }
  for (const a of visible) {
    const existing = box.querySelector(`[data-alert-id="${CSS.escape(a.id)}"]`);
    if (!existing) box.append(alertItem(a));
    else if (existing.getAttribute("data-alert-sig") !== alertItem(a).getAttribute("data-alert-sig")) {
      existing.replaceWith(alertItem(a));
    }
  }
}

async function render() {
  teardownQueueKeys();
  app.innerHTML = "";
  app.append(await header());
  const main = el("div", { id: "main" });
  app.append(main);
  try {
    if (state.tab === "queue") main.append(await queueView());
    else if (state.tab === "captures") main.append(await capturesView());
    else if (state.tab === "referrals") main.append(await referralsView());
    else if (state.tab === "companies") main.append(await companiesView());
    else if (state.tab === "keywords") main.append(await keywordsView());
    else if (state.tab === "profile") main.append(await profileView());
  } catch (err) {
    main.append(el("div", { class: "banner err" }, `Backend error: ${(err as Error).message}. Is it running on ${api.base}?`));
  }
  // deep-link: ?job=<id> or #job/<id> opens the apply view (one-shot — the
  // param is stripped so refreshes / later renders don't reopen the modal)
  const params = new URLSearchParams(location.search);
  const jobId = params.get("job") || location.hash.match(/^#job\/([^/?#]+)/)?.[1];
  if (jobId) {
    params.delete("job");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
    openApply(jobId);
  }
  // ?stream=done — the extension lands here when an apply stream finishes.
  if (params.get("stream") === "done") {
    params.delete("stream");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
    toast("⚡ Apply stream complete — every job reviewed 🎉");
  }
  // ?applied=<id> — the phone fill sheet's "✓ I submitted" link. Page JavaScript
  // on an ATS host can't POST to this backend, so recording comes back through
  // an authenticated page load here instead (docs/phone-apply-design.md).
  const appliedId = params.get("applied");
  if (appliedId) {
    params.delete("applied");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
    void (async () => {
      try {
        await api.apply(appliedId, { notes: `phone apply assist · ${new Date().toISOString().slice(0, 10)}` });
        toast("✅ Recorded as applied");
        void render();
      } catch (err) {
        toast(`Couldn't record it: ${(err as Error).message}`, true);
      }
    })();
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}

function pollStatusBadge(poll: { running?: boolean; elapsedMs?: number; trigger?: string } | null): HTMLElement | null {
  if (!poll?.running) return null;
  const elapsed = poll.elapsedMs ?? 0;
  const title = `ATS poll in progress (${poll.trigger ?? "?"}) · ${formatDuration(elapsed)} elapsed · scheduled polls skip while this runs`;
  return el(
    "span",
    { title, style: "display:inline-flex;align-items:center;gap:5px" },
    el("span", {
      style:
        "width:8px;height:8px;border-radius:50%;display:inline-block;background:#58a6ff;box-shadow:0 0 8px #58a6ff",
    }),
    `Poll running · ${formatDuration(elapsed)}`
  );
}

// Auto résumé pipeline indicator — a pure formatter now. The shared status poller
// keeps it live via applyStatusToDom(); no per-badge timers.
function pipelineBadgeText(s: any | null): string | null {
  if (!s) return null;
  const c = s.counts;
  const total = (Object.values(c) as number[]).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const active = c.queued > 0 || c.running > 0;
  if (active) {
    const all = c.queued + c.running + c.done + c.error;
    const cur = (s.tasks ?? []).find((t: any) => t.status === "running");
    return `📄 Generating résumés ${c.done + c.error}/${all}` + (cur?.title ? ` — ${cur.title}` : "") + "…";
  }
  return `📄 Résumés: ${c.done} ready` + (c.error ? ` · ${c.error} failed` : "");
}

// LLM health badge: green ok / red error / amber idle / grey off. The `enabled`
// flag only means a key is set, so we surface real call success/failure here.
function llmStatusBadge(llm: any, llmEnabled: boolean): HTMLElement {
  if (!llm) {
    return el("span", {}, llmEnabled ? "LLM: on" : "LLM off (heuristics)");
  }
  const map: Record<string, { dot: string; label: string }> = {
    ok: { dot: "#3fb950", label: "LLM ok" },
    error: { dot: "#f85149", label: "LLM error" },
    idle: { dot: "#d29922", label: "LLM idle" },
    disabled: { dot: "#8b949e", label: "LLM off (heuristics)" },
  };
  const m = map[llm.status] ?? map.disabled;
  let title = `LLM status: ${llm.status} · click for details`;
  if (llm.totalCalls) title += ` · ${llm.totalCalls - llm.totalFailures}/${llm.totalCalls} ok`;
  const badge = el(
    "span",
    { title, style: "display:inline-flex;align-items:center;gap:5px;position:relative;cursor:pointer" },
    el("span", {
      style: `width:8px;height:8px;border-radius:50%;display:inline-block;background:${m.dot}`,
    }),
    m.label + (llm.consecutiveFailures ? ` (${llm.consecutiveFailures}× failing)` : "")
  );
  badge.addEventListener("click", () => {
    const open = badge.querySelector(".llm-pop");
    if (open) {
      open.remove();
      return;
    }
    badge.append(
      el(
        "div",
        { class: "llm-pop", onclick: (e: Event) => e.stopPropagation() },
        el("div", {}, "Status: ", el("b", {}, llm.status)),
        el("div", {}, `Calls: ${llm.totalCalls} · failures: ${llm.totalFailures}`),
        llm.consecutiveFailures > 0 && el("div", {}, `Consecutive failures: ${llm.consecutiveFailures}`),
        llm.lastOkAt && el("div", {}, `Last success: ${timeAgo(llm.lastOkAt)}`),
        llm.lastErrorAt && el("div", {}, `Last failure: ${timeAgo(llm.lastErrorAt)}`),
        llm.lastError && el("div", { class: "muted", style: "margin-top:4px;word-break:break-word" }, llm.lastError)
      )
    );
  });
  return badge;
}

// Content builders for the mutable statusbar spans (sb-poll / sb-discovery /
// sb-llm / sb-pipeline). Used by header() at build time and by applyStatusToDom()
// for in-place updates from the shared status poller.
function pollStatusContent(health: any | null): Child[] {
  const live = pollStatusBadge(health?.poll);
  if (live) return [live];
  const last = health?.lastPollRun;
  if (!last) return ["No polls yet"];
  return [
    "Last poll ",
    el("b", {}, timeAgo(last.started_at)),
    ` · ${last.jobs_new ?? 0} new · ${last.notifications_sent ?? 0} notified` +
      (last.errors_json && last.status !== "running" ? " · ⚠ errors" : ""),
  ];
}

function discoveryStatusContent(health: any | null): Child[] {
  const lastDisc = health?.lastDiscoveryRun;
  if (!lastDisc) return ["No discovery yet"];
  return ["Discovery ", el("b", {}, timeAgo(lastDisc.started_at)), ` · ${lastDisc.jobs_new ?? 0} new`];
}

function pipelineStatusContent(pipeline: any | null): Child[] {
  const text = pipelineBadgeText(pipeline);
  if (!text) return [];
  return [
    el("span", { class: "sep", style: "margin-right:18px" }, "·"),
    el("span", { title: "Auto résumé pipeline (matches ≥ 70%)" }, text),
  ];
}

/** Patch the statusbar spans in place (no header rebuild, no focus/scroll loss). */
function applyStatusToDom(s: StatusSnapshot): void {
  const put = (id: string, children: Child[]) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.replaceChildren(...children.filter((c): c is Node | string => c != null && c !== false)
      .map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
  };
  put("sb-poll", pollStatusContent(s.health));
  put("sb-discovery", discoveryStatusContent(s.health));
  if (s.health) put("sb-llm", [llmStatusBadge(s.health.llm, s.health.llmEnabled)]);
  put("sb-pipeline", pipelineStatusContent(s.pipeline));
}

// ---- header + status bar ---------------------------------------------------
// Short-TTL caches so a render (tab switch, post-action refresh) doesn't refire
// every status request — the shared poller keeps health/pipeline fresh anyway.
let activityCache: { at: number; data: any } | null = null;
let countsCache: { at: number; data: { queue: number; captures: number; referrals: number; keywords: number } } | null = null;
const HEADER_TTL_MS = 15_000;

async function cachedActivity(): Promise<any | null> {
  if (activityCache && Date.now() - activityCache.at < HEADER_TTL_MS) return activityCache.data;
  const data = await api.activity().catch(() => null);
  if (data) activityCache = { at: Date.now(), data };
  return data;
}

async function cachedTabCounts() {
  if (countsCache && Date.now() - countsCache.at < HEADER_TTL_MS) return countsCache.data;
  const data = await tabCounts();
  countsCache = { at: Date.now(), data };
  return data;
}

async function cachedPipeline(): Promise<any | null> {
  const s = statusBus.latest;
  if (s?.pipeline && Date.now() - s.at < HEADER_TTL_MS) return s.pipeline;
  return api.resumePipeline().catch(() => null);
}

async function header(): Promise<HTMLElement> {
  let health: any = null;
  let activity: any = null;
  let pipeline: any = null;
  let online = true;
  let counts = { queue: 0, captures: 0, referrals: 0, keywords: 0 };
  let watch: any = null;
  let spend: any = null;
  // KPI inputs (all optional — a failure never takes the header down).
  let prefills: Awaited<ReturnType<typeof api.prefills>> = [];
  let fresh: Job[] = [];
  let applied: Job[] = [];
  try {
    [health, activity, counts, pipeline, watch, spend, prefills, fresh, applied] = await Promise.all([
      fetchHealth(),
      cachedActivity(),
      cachedTabCounts(),
      cachedPipeline(),
      api.scanLastRun().then((r) => r.lastRun).catch(() => null),
      api.spend().catch(() => null),
      api.prefills().catch(() => []),
      // Fresh matches at the notify bar (server applies the freshness window).
      api.jobs(`?minScore=${NOTIFY_BAR}&excludeStates=applied,skipped&excludeZeroScore=1&excludeUnscored=1&limit=200`).catch(() => []),
      api.jobs("?state=applied&allAges=1&allRegions=1&limit=200").catch(() => []),
    ]);
    online = health != null;
  } catch {
    online = false;
  }
  state.pollRunning = health?.poll?.running ?? false;
  state.scoringRunning = health?.scoring?.running ?? false;

  const watchContent = (): Child[] => {
    if (!watch) return ["LinkedIn watch: ", el("b", {}, "no runs yet")];
    const at = Number(watch.reported_at);
    const stale = Date.now() - at > 3 * 3600 * 1000;
    return [
      "LinkedIn watch: ",
      el("b", { style: stale ? "color:var(--amber)" : "", title: new Date(at).toLocaleString() }, timeAgo(at)),
      watch.error ? el("span", { style: "color:var(--red)", title: String(watch.error) }, " ⚠") : "",
      ` · ${watch.scanned} scanned · ${watch.persisted} saved`,
    ];
  };
  const spendContent = (): Child[] => {
    if (!spend) return [];
    const t = spend.today ?? {};
    const usd = t.usd != null ? ` · $${Number(t.usd).toFixed(2)}` : "";
    const tokens = `${Math.round(((t.promptTokens ?? 0) + (t.completionTokens ?? 0)) / 1000)}k tok`;
    const cap =
      spend.tailorDailyCap > 0 ? ` · tailored ${spend.tailorQueuedToday}/${spend.tailorDailyCap}` : "";
    return [
      el(
        "span",
        {
          title:
            `LLM today: ${t.calls ?? 0} calls, ${tokens}${usd}\n` +
            `7d: ${spend.last7d?.calls ?? 0} calls${spend.last7d?.usd != null ? `, $${Number(spend.last7d.usd).toFixed(2)}` : ""}` +
            (spend.pricesConfigured ? "" : "\nSet LLM_PRICE_IN_PER_M / LLM_PRICE_OUT_PER_M in .env for $ estimates") +
            (spend.tailorDailyCap > 0 ? `\nAuto-tailor cap: ${spend.tailorDailyCap}/day (TAILOR_DAILY_CAP)` : ""),
        },
        "LLM today: ",
        el("b", {}, `${t.calls ?? 0} calls${usd}`),
        cap
      ),
    ];
  };

  // ---- KPI row: the four numbers that decide what to do next --------------
  // Everything else (scheduler, poll, discovery, pipeline, LLM, spend, extension
  // activity) is grouped under a collapsed "System" row below.
  const DAY = 24 * 3600 * 1000;
  const activePrefills = prefills.filter(
    (p) => ["queued", "running", "ready"].includes(p.status) && p.jobState !== "applied" && p.jobState !== "skipped"
  );
  const readyForms = activePrefills.filter((p) => p.status === "ready");
  const openQuestions = readyForms.reduce((n, p) => n + p.unanswered.length, 0);
  const submitReady = readyForms.filter((p) => p.unanswered.length === 0).length;
  const freshWithResume = fresh.filter((j) => j.resume?.status === "ready").length;
  const appliedWeek = applied.filter((j) => (j.applied_at ?? 0) >= Date.now() - 7 * DAY).length;
  const appliedToday = applied.filter((j) => (j.applied_at ?? 0) >= Date.now() - DAY).length;
  const watchAt = watch ? Number(watch.reported_at) : 0;
  const watchAge = watchAt ? Date.now() - watchAt : Infinity;
  const watchState: "ok" | "warn" | "off" = !watchAt ? "off" : watchAge > 3 * 3600 * 1000 ? "warn" : "ok";

  const tile = (
    label: string,
    value: string,
    sub: string,
    tone: "accent" | "good" | "warn" | "muted",
    onclick?: () => void,
    title?: string
  ) =>
    el(
      "div",
      { class: `kpi kpi-${tone}${onclick ? " kpi-click" : ""}`, onclick: onclick ?? null, title: title ?? "" },
      el("div", { class: "kpi-label" }, label),
      el("div", { class: "kpi-value" }, value),
      el("div", { class: "kpi-sub" }, sub)
    );
  const goQueue = (mode: QueueMode) => {
    state.tab = "queue";
    state.queueMode = mode;
    localStorage.setItem("jh-queue-mode", mode);
    render();
  };
  const kpis = el(
    "div",
    { class: "kpis" },
    tile(
      "To review",
      String(readyForms.length),
      readyForms.length
        ? `${openQuestions} question${openQuestions === 1 ? "" : "s"} need you · ${submitReady} ready to submit` +
          (activePrefills.length - readyForms.length ? ` · ${activePrefills.length - readyForms.length} queued` : "")
        : activePrefills.length
          ? `${activePrefills.length} being filled on the desktop`
          : "no forms prefilled yet",
      readyForms.length ? "accent" : "muted",
      () => goQueue("apply"),
      "Forms the desktop has prefilled — open to answer the rest"
    ),
    tile(
      "Fresh matches",
      String(fresh.length),
      `≥ ${Math.round(NOTIFY_BAR * 100)}% · last ${health?.freshnessHours ?? 24}h · ${freshWithResume} with résumé`,
      fresh.length ? "good" : "muted",
      () => goQueue("apply"),
      "Jobs at or above the notify bar, not yet applied or skipped"
    ),
    tile(
      "Applied",
      String(appliedWeek),
      `last 7 days · ${appliedToday} today`,
      appliedWeek ? "good" : "muted",
      undefined,
      "Applications recorded (extension submit detection + manual marks)"
    ),
    tile(
      "LinkedIn watch",
      watchAt ? timeAgo(watchAt).replace(/ ago$/, "") : "—",
      watchAt
        ? (watchState === "warn" ? "⚠ stale · " : "✓ ") + `${watch.scanned} scanned · ${watch.persisted} saved`
        : "no scan reported yet",
      watchState === "ok" ? "good" : watchState === "warn" ? "warn" : "muted",
      undefined,
      watchAt ? `Last auto-scan report ${new Date(watchAt).toLocaleString()}` : "The extension scans weekdays 07:00–17:00 every ~90 min"
    )
  );

  // ---- System row: collapsed by default; the live poller keeps its ids fresh --
  const sysSummaryBits: string[] = [];
  if (!online) sysSummaryBits.push("backend offline");
  else {
    sysSummaryBits.push(`scheduler ${health.scheduler.enabled ? "on" : "manual"}`);
    sysSummaryBits.push(`LLM ${health.llm?.status ?? (health.llmEnabled ? "ok" : "off")}`);
    if (spend?.today) sysSummaryBits.push(`${spend.today.calls ?? 0} calls today${spend.today.usd != null ? ` · $${Number(spend.today.usd).toFixed(2)}` : ""}`);
    const pipe = pipelineBadgeText(pipeline);
    if (pipe) sysSummaryBits.push(pipe);
    if (health.poll?.running) sysSummaryBits.push("poll running");
  }
  const statusbar = el(
    "div",
    { class: "statusbar" },
    online
      ? el("span", {}, "Scheduler: ", el("b", {}, health.scheduler.enabled ? "on" : "manual"))
      : el("span", { class: "err" }, "backend offline"),
    el("span", { class: "sep" }, "·"),
    el("span", { id: "sb-poll" }, ...pollStatusContent(health)),
    el("span", { class: "sep" }, "·"),
    el("span", { id: "sb-discovery" }, ...discoveryStatusContent(health)),
    el("span", { class: "sep" }, "·"),
    activity &&
      el(
        "span",
        {},
        "Today (extension): ",
        el("b", {}, `${activity.jobsCaptured}`),
        " captured · ",
        el("b", {}, `${activity.jobsViewed}`),
        " viewed · ",
        el("b", {}, `${activity.referralLeads}`),
        " referrals · ",
        el("b", {}, `${activity.applications}`),
        " applied"
      ),
    online && el("span", { class: "sep" }, "·"),
    online && el("span", { id: "sb-llm" }, llmStatusBadge(health.llm, health.llmEnabled)),
    el("span", { id: "sb-pipeline" }, ...pipelineStatusContent(pipeline)),
    online && el("span", { class: "sep" }, "·"),
    online && el("span", { id: "sb-watch" }, ...watchContent()),
    online && spend && el("span", { class: "sep" }, "·"),
    online && el("span", { id: "sb-spend" }, ...spendContent())
  );
  const sysDetails = el(
    "details",
    { class: "sys", open: localStorage.getItem("jh-sys-open") === "1" ? "" : null,
      ontoggle: (e: Event) => localStorage.setItem("jh-sys-open", (e.target as HTMLDetailsElement).open ? "1" : "0") },
    el("summary", {},
      el("span", { class: `dot ${online ? "" : "off"}` }),
      el("span", { class: "sys-label" }, "System"),
      el("span", { class: "muted sys-summary" }, sysSummaryBits.join(" · "))),
    statusbar
  );

  queueKpis = kpis;

  const tabBtn = (id: Tab, label: string, n?: number) =>
    el(
      "button",
      { class: state.tab === id ? "active" : "", onclick: () => { state.tab = id; render(); } },
      label,
      n != null ? el("span", { class: "count", "data-tab-count": id }, String(n)) : null
    );

  return el(
    "header",
    { class: "top" },
    el(
      "div",
      { class: "brand-row" },
      el("div", { class: "brand" }, el("span", { class: `dot ${online ? "" : "off"}` }), el("h1", {}, "Job Hunt Assistant")),
      el(
        "div",
        { class: "header-actions" },
        // Account + sign-out only matter for remote (token) sessions — loopback is
        // always the owner with no login, so the link would just be confusing there.
        online && health?.account && isRemoteSession()
          ? el(
              "span",
              { class: "account" },
              el("b", {}, String(health.account.name)),
              " · ",
              el("a", { href: "/logout", title: "Sign out to switch accounts" }, "Sign out")
            )
          : null,
        themeSwitch(),
        el(
          "button",
          {
            class: "ghost btn-sm",
            onclick: publishToSlack,
            title: "Send every not-yet-notified job at or above the notify threshold to your Slack channel",
          },
          "Publish to Slack"
        ),
        el(
          "button",
          {
            class: "ghost btn-sm",
            disabled: state.pollRunning,
            onclick: poll,
          },
          state.pollRunning ? "Polling…" : "Poll now"
        )
      )
    ),
    sysDetails,
    el(
      "nav",
      { class: "tabs" },
      tabBtn("queue", "Queue", counts.queue),
      tabBtn("captures", "Captures", counts.captures),
      tabBtn("referrals", "Referrals", counts.referrals),
      tabBtn("companies", "Companies"),
      tabBtn("keywords", "Keywords", counts.keywords),
      tabBtn("profile", "Profile")
    )
  );
}

async function tabCounts() {
  try {
    return await api.tabCounts();
  } catch {
    return { queue: 0, captures: 0, referrals: 0, keywords: 0 };
  }
}

async function poll() {
  if (state.pollRunning) {
    toast("Poll already in progress…");
    return;
  }
  toast("Polling ATS adapters… (may take 10+ minutes)");
  try {
    const r = await api.pollNow();
    if (r.skipped) {
      toast("Poll already in progress");
      render();
      return;
    }
    toast(`Polled ${r.companiesPolled} companies · ${r.jobsNew} new · ${r.notificationsSent} notified`);
    render();
  } catch (err) {
    toast((err as Error).message, true);
  }
}

async function publishToSlack() {
  toast("Publishing high matches to Slack…");
  try {
    const r = await api.publishToSlack();
    const pct = Math.round((r.threshold ?? 0.7) * 100);
    if (r.notified > 0) {
      toast(`Published ${r.notified} job(s) ≥ ${pct}% to Slack`);
    } else if (r.matched > 0) {
      toast(`${r.matched} match(es) ≥ ${pct}% but Slack send failed — check the webhook`, true);
    } else {
      toast(`Nothing to publish — every job ≥ ${pct}% was already notified`);
    }
    render();
  } catch (err) {
    toast((err as Error).message, true);
  }
}

async function runResumePipeline() {
  try {
    const r = await api.runResumePipeline();
    if (r.enqueued > 0) {
      toast(`Queued ${r.enqueued} résumé(s) — generating in the background`);
    } else if (r.skippedReason) {
      toast(`Nothing queued — ${r.skippedReason}`, true);
    } else {
      toast("Nothing new to generate — all fresh high matches already have résumés");
    }
    render();
  } catch (err) {
    toast((err as Error).message, true);
  }
}

async function scorePending() {
  if (state.scoringRunning) {
    toast("Scoring already in progress…");
    return;
  }
  toast("Scoring pending jobs via LLM (may take a few minutes)…");
  try {
    const r = await api.scoreUnscored(50);
    if (r.skipped) {
      toast("Scoring already in progress");
    } else {
      toast(
        `Scored ${r.scored} job(s) · ${r.remaining} still pending` +
          (r.remaining > 0 ? " — click again for more" : "")
      );
    }
    render();
  } catch (err) {
    toast((err as Error).message, true);
  }
}

// ---- queue -----------------------------------------------------------------
// Targeted card updates: actions patch/remove single cards in place (no full
// render), so scroll position, filters, and keyboard selection survive triage.
const jobsById = new Map<string, Job>();
let selectedJobId: string | null = null;
let queueKeyHandler: ((e: KeyboardEvent) => void) | null = null;

function teardownQueueKeys(): void {
  if (queueKeyHandler) {
    document.removeEventListener("keydown", queueKeyHandler);
    queueKeyHandler = null;
  }
  selectedJobId = null;
}

function findCard(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-job-id="${CSS.escape(id)}"]`);
}

/** Does this (freshly-updated) job still belong in the current queue view? */
function matchesCurrentFilter(j: Job): boolean {
  if (state.queueMode === "apply") {
    return (
      j.state !== "applied" &&
      j.state !== "skipped" &&
      (j.relevance_score ?? -1) >= SHORTLIST_MIN_SCORE &&
      !["contract", "part_time", "intern"].includes(j.employment_type ?? "unknown") &&
      !belowSalaryFloor(j)
    );
  }
  const f = state.jobFilter;
  if (f.state && j.state !== f.state) return false;
  if (f.source && j.source !== f.source) return false;
  if (f.sourceKind && j.source_kind !== f.sourceKind) return false;
  if (f.employmentType) {
    const et = j.employment_type ?? "unknown";
    if (et !== f.employmentType) return false;
  }
  // Queue always excludes zero/unscored.
  if (j.relevance_score == null || j.relevance_score <= 0) return false;
  return true;
}

function replaceJobCard(j: Job): void {
  // PATCH responses don't carry the resume status — keep the one we listed with.
  const merged = { ...j, resume: j.resume ?? jobsById.get(j.id)?.resume };
  jobsById.set(j.id, merged);
  findCard(j.id)?.replaceWith(jobCard(merged));
  if (selectedJobId === j.id) findCard(j.id)?.classList.add("selected");
}

function removeJobCard(id: string): void {
  const card = findCard(id);
  if (!card) return;
  const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-job-id]"));
  const idx = cards.indexOf(card);
  card.remove();
  jobsById.delete(id);
  if (selectedJobId === id) {
    const rest = Array.from(document.querySelectorAll<HTMLElement>("[data-job-id]"));
    const next = rest[Math.min(idx, rest.length - 1)] ?? null;
    selectCard(next?.getAttribute("data-job-id") ?? null);
  }
  bumpCounts(-1);
}

/** In-place count updates: toolbar count from the DOM, tab badge by delta. */
function bumpCounts(tabDelta = 0): void {
  const count = document.querySelectorAll("[data-job-id]").length;
  const label = document.getElementById("queue-count");
  if (label) label.textContent = `${count} jobs`;
  if (tabDelta) {
    const badge = document.querySelector('[data-tab-count="queue"]');
    if (badge) badge.textContent = String(Math.max(0, Number(badge.textContent || "0") + tabDelta));
  }
}

function selectCard(id: string | null): void {
  selectedJobId = id;
  document.querySelectorAll(".job.selected").forEach((n) => n.classList.remove("selected"));
  if (!id) return;
  const card = findCard(id);
  if (!card) return;
  card.classList.add("selected");
  card.scrollIntoView({ block: "nearest" });
}

/** Shared by buttons and keyboard: PATCH state, then update the DOM in place. */
async function applyJobState(id: string, s: string): Promise<void> {
  try {
    const updated = await api.patchJob(id, { state: s });
    if (matchesCurrentFilter(updated)) replaceJobCard(updated);
    else removeJobCard(updated.id);
    bumpCounts(0);
  } catch (err) {
    toast((err as Error).message, true);
  }
}

function onQueueKeydown(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if (document.querySelector(".modal-bg")) return;
  const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-job-id]"));
  if (!cards.length) return;
  const idx = cards.findIndex((c) => c.getAttribute("data-job-id") === selectedJobId);
  const selectAt = (i: number) => {
    const clamped = Math.max(0, Math.min(cards.length - 1, i));
    selectCard(cards[clamped]?.getAttribute("data-job-id") ?? null);
  };
  const job = selectedJobId ? jobsById.get(selectedJobId) : undefined;
  switch (e.key) {
    case "j":
    case "ArrowDown":
      e.preventDefault();
      selectAt(idx < 0 ? 0 : idx + 1);
      break;
    case "k":
    case "ArrowUp":
      e.preventDefault();
      selectAt(idx < 0 ? 0 : idx - 1);
      break;
    case "Enter":
    case "a":
      if (selectedJobId) {
        e.preventDefault();
        void openApply(selectedJobId);
      }
      break;
    case "s":
      if (selectedJobId) {
        e.preventDefault();
        void applyJobState(selectedJobId, "skipped");
      }
      break;
    case "r":
      if (selectedJobId && job?.state !== "relevant") {
        e.preventDefault();
        void applyJobState(selectedJobId, "relevant");
      }
      break;
    case "o":
      if (job) {
        e.preventDefault();
        const href = jobPostingHref(job.url);
        if (href) window.open(href, "_blank", "noopener");
      }
      break;
    case "?": {
      e.preventDefault();
      document.getElementById("kbd-help")?.classList.toggle("open");
      break;
    }
  }
}

function kbdHelpCard(): HTMLElement {
  const key = (k: string, what: string) =>
    el("span", {}, el("kbd", {}, k), ` ${what}`);
  return el(
    "div",
    { id: "kbd-help", class: "card kbd-help" },
    key("j / ↓", "next"),
    key("k / ↑", "prev"),
    key("Enter / a", "apply"),
    key("s", "skip"),
    key("r", "relevant"),
    key("o", "open posting"),
    key("?", "toggle help")
  );
}

async function queueView(): Promise<HTMLElement> {
  let freshH = 24;
  let scoringPending = 0;
  let llmDegraded = false;
  try {
    const h = await fetchHealth();
    freshH = h?.freshnessHours ?? 24;
    if (h?.salaryFloor) salaryFloors = { hybridCad: h.salaryFloor.hybridCad ?? 0, remoteCad: h.salaryFloor.remoteCad ?? 0 };
    scoringPending = h?.scoring?.freshInRegion ?? 0;
    state.scoringRunning = h?.scoring?.running ?? false;
    llmDegraded = ((h?.alerts as HealthAlert[]) ?? []).some(
      (a) => a.id === "llm_down" || a.id === "llm_fallback"
    );
  } catch {
    /* offline */
  }

  const applyMode = state.queueMode === "apply";

  const buildQuery = (): string => {
    const q = new URLSearchParams();
    if (applyMode) {
      // Queue: actionable + ≥ 70% + FRESH (last 24h only — stale postings are
      // already picked over; effort goes to new ones) + above the configured
      // salary floor, if any (unknowns pass). Résumé readiness is
      // shown per card, not gated: ≥ 70% jobs auto-tailor within minutes.
      q.set("minScore", String(SHORTLIST_MIN_SCORE));
      q.set("excludeStates", "applied,skipped");
      q.set("sort", "score");
      q.set("limit", "200");
      q.set("excludeZeroScore", "1");
      q.set("excludeUnscored", "1");
      q.set("salaryFloor", "1");
      return `?${q.toString()}`;
    }
    if (state.jobFilter.state) q.set("state", state.jobFilter.state);
    if (state.jobFilter.source) q.set("source", state.jobFilter.source);
    if (state.jobFilter.sourceKind) q.set("sourceKind", state.jobFilter.sourceKind);
    if (state.jobFilter.employmentType) q.set("employmentType", state.jobFilter.employmentType);
    // Sort applies in BOTH modes; default "first_seen" = newest fetched/posted on top.
    q.set("sort", state.jobFilter.sort);
    q.set("limit", "200");
    q.set("excludeZeroScore", "1");
    q.set("excludeUnscored", "1");
    return `?${q.toString()}`;
  };

  const list = el("div", {});
  const countLabel = el("span", { class: "muted", id: "queue-count" }, "…");
  // Apply mode, phone-first: the forms the desktop has already filled, with what
  // is left for the human — the thing to look at first on the phone.
  const prefillBanner = el("div", {});
  const renderPrefillBanner = async () => {
    if (!applyMode) return;
    let rows: Awaited<ReturnType<typeof api.prefills>> = [];
    try {
      rows = await api.prefills();
    } catch {
      return;
    }
    const active = rows.filter((p) => ["queued", "running", "ready"].includes(p.status) && p.jobState !== "applied" && p.jobState !== "skipped");
    prefillBanner.innerHTML = "";
    if (!active.length) return;
    const ready = active.filter((p) => p.status === "ready");
    const waiting = active.length - ready.length;
    const openCount = ready.reduce((n, p) => n + p.unanswered.length, 0);
    const row = (p: (typeof rows)[number]) =>
      el(
        "div",
        {
          class: "prefill-row",
          onclick: () => void openApply(p.jobId),
          title: "Open — answer the remaining questions here; the desktop tab re-fills",
        },
        el("span", { class: "prefill-row-main" },
          el("b", {}, p.company ?? "—"), " · ", p.title),
        el("span", { class: `tag ${p.status !== "ready" ? "prefill-queued" : p.unanswered.length ? "prefill-open" : "prefill-ready"}` },
          p.status === "queued" ? "queued" : p.status === "running" ? "filling…" : p.unanswered.length ? `${p.unanswered.length} to answer` : "ready to submit")
      );
    prefillBanner.append(
      el("div", { class: "card panel-ready" },
        el("div", { class: "panel-head" },
          el("h3", {}, ready.length ? `${ready.length} form${ready.length === 1 ? "" : "s"} waiting on you` : "Prefill in progress"),
          el("span", { class: "muted" },
            (openCount ? `${openCount} question${openCount === 1 ? "" : "s"} still blank` : "nothing left to answer") +
            (waiting ? ` · ${waiting} filling on the desktop` : ""))),
        ...ready.map(row),
        ...active.filter((p) => p.status !== "ready").slice(0, 3).map(row)
      )
    );
  };
  // Score-ordered ids of the current apply queue — consumed by the batch stepper.
  let applyQueueIds: string[] = [];

  const loadList = async () => {
    list.innerHTML = "";
    list.append(el("div", { class: "muted", style: "padding:20px 0" }, "Loading…"));
    try {
      let jobs = await api.jobs(buildQuery());
      if (applyMode) {
        // FTE-probable only (contract / part-time / intern stay visible under All).
        jobs = jobs.filter(
          (j) =>
            !["contract", "part_time", "intern"].includes(j.employment_type ?? "unknown") &&
            !belowSalaryFloor(j)
        );
        // Stream apply / Prefill all act on the résumé-ready subset only.
        applyQueueIds = jobs.filter((j) => j.resume?.status === "ready").map((j) => j.id);
        void renderPrefillBanner();
      }
      list.innerHTML = "";
      jobsById.clear();
      if (jobs.length === 0) {
        list.append(
          el(
            "div",
            { class: "empty" },
            applyMode
              ? "Queue is empty — no fresh FTE jobs ≥ 70% above the salary floor right now. Switch to All to browse everything, or Poll now."
              : "No jobs yet. Add companies and Poll now, or capture some with the extension."
          )
        );
      }
      const frag = document.createDocumentFragment();
      for (const j of jobs) {
        jobsById.set(j.id, j);
        frag.append(jobCard(j));
      }
      list.append(frag);
      countLabel.textContent = `${jobs.length} jobs`;
      selectCard(null);
    } catch (err) {
      list.innerHTML = "";
      list.append(el("div", { class: "banner err" }, (err as Error).message));
    }
  };

  const modeBtn = (mode: QueueMode, label: string) =>
    el(
      "button",
      {
        class: `seg ${state.queueMode === mode ? "active" : ""}`,
        onclick: () => {
          if (state.queueMode === mode) return;
          state.queueMode = mode;
          localStorage.setItem("jh-queue-mode", mode);
          render();
        },
      },
      label
    );

  const sel = (val: string, opts: { v: string; l: string }[], on: (v: string) => void) =>
    el(
      "select",
      {
        onchange: (e: Event) => {
          on((e.target as HTMLSelectElement).value);
          void loadList();
        },
      },
      ...opts.map((o) => el("option", { value: o.v, selected: o.v === val }, o.l))
    );

  // Filter dropdowns are fed by server-side facets (all matching rows, with
  // counts), not just the 200 rows on screen. "All" mode only.
  let filterSelects: HTMLElement[] = [];
  if (!applyMode) {
    let facets: import("./api.js").JobFacets | null = null;
    try {
      facets = await api.jobFacets("?excludeZeroScore=1&excludeUnscored=1");
    } catch {
      /* facets are progressive enhancement */
    }
    const withCounts = (
      dim: { value: string; count: number }[] | undefined,
      fallback: { v: string; l: string }[]
    ): { v: string; l: string }[] =>
      dim?.length
        ? dim.map((d) => ({ v: d.value, l: `${d.value} (${d.count})` }))
        : fallback;
    filterSelects = [
      sel(state.jobFilter.state, [
        { v: "", l: "All states" },
        ...withCounts(facets?.states, [
          { v: "discovered", l: "Discovered" },
          { v: "relevant", l: "Relevant" },
          { v: "notified", l: "Notified" },
          { v: "applied", l: "Applied" },
          { v: "skipped", l: "Skipped" },
        ]),
      ], (v) => (state.jobFilter.state = v)),
      sel(state.jobFilter.source, [
        { v: "", l: "All sources" },
        ...withCounts(facets?.sources, []),
      ], (v) => (state.jobFilter.source = v)),
      sel(state.jobFilter.sourceKind, [
        { v: "", l: "All channels" },
        ...withCounts(facets?.sourceKinds, [
          { v: "ats", l: "ATS poll" },
          { v: "discovery", l: "Discovery" },
          { v: "extension", l: "Extension" },
        ]),
      ], (v) => (state.jobFilter.sourceKind = v)),
      sel(state.jobFilter.employmentType, [
        { v: "", l: "All types" },
        ...withCounts(facets?.employmentTypes, [
          { v: "full_time", l: "Full-time" },
          { v: "contract", l: "Contract" },
          { v: "unknown", l: "Unknown" },
        ]),
      ], (v) => (state.jobFilter.employmentType = v)),
    ];
  }

  // Sort and the other dropdowns live on All only. The apply queue is always
  // relevance-sorted by the server (`sort=score` in buildQuery).
  const sortSel = sel(state.jobFilter.sort, [
    { v: "first_seen", l: "Sort: newest" },
    { v: "score", l: "Sort: relevance" },
  ], (v) => {
    state.jobFilter.sort = v;
    localStorage.setItem("jh-queue-sort", v);
  });

  const toolbar = el(
    "div",
    { class: "queue-chrome" },
    el(
      "div",
      { class: "toolbar toolbar-main" },
      el("span", { class: "seg-group" },
        modeBtn("apply", "Queue"),
        modeBtn("all", "All")),
      countLabel,
      applyMode
        ? el("span", {
            class: "queue-rule",
            title: `≥ 70% · FTE${salaryFloorLabel()} · last ${freshH}h · best match first`,
          }, `Fresh · ≥70% · last ${freshH}h`)
        : el("span", { class: "queue-rule" }, `Last ${freshH}h · US & Canada`),
      el("span", { class: "toolbar-spacer" }),
      applyMode &&
        el("button", {
          class: "primary",
          title:
            "One tab through EVERY queue job: ATS jobs auto-fill and advance on Submit; " +
            "LinkedIn/Indeed/other jobs are assisted by the Copilot side panel, which has the ✓ Applied → next button",
          onclick: async () => {
            if (!applyQueueIds.length) { toast("Apply queue is empty", true); return; }
            try {
              const res = await api.startApplyStream(applyQueueIds);
              if (!res.streamId || !res.first) {
                toast("Nothing streamable — needs fresh, résumé-ready jobs", true);
                return;
              }
              window.open(res.first.url, "_blank");
              toast(
                `Stream started — ${res.total} job(s): ${res.counts.auto} auto-fill, ${res.counts.manual} panel-assisted` +
                  (res.skipped.length ? ` (${res.skipped.length} skipped)` : "")
              );
            } catch (err) {
              toast((err as Error).message, true);
            }
          },
        }, "Stream apply"),
      applyMode &&
        el("button", {
          class: "ghost",
          title:
            "Queue every engine-host job here (Greenhouse / Ashby / Lever) for prefill-ahead: the desktop Chrome " +
            "opens each form in a background window, attaches the résumé and fills what it can — never submits. " +
            "Answer the leftovers from your phone.",
          onclick: async () => {
            const targets = [...jobsById.values()].filter(
              (j) =>
                j.resume?.status === "ready" &&
                PREFILL_HOST_RE.test(j.url) &&
                !(j.prefill && PREFILL_ACTIVE.has(j.prefill.status))
            );
            if (!targets.length) { toast("Nothing to prefill — no engine-host jobs without an active prefill", true); return; }
            let queued = 0;
            for (const j of targets) {
              try {
                const r = await api.requestPrefill(j.id);
                if (r.ok) queued++;
              } catch { /* keep going */ }
            }
            toast(`${queued}/${targets.length} queued for prefill — the desktop fills up to 5 at a time`);
            void loadList();
          },
        }, "Prefill all"),
      (scoringPending > 0 || state.scoringRunning)
        ? el(
            "button",
            {
              class: "ghost",
              disabled: state.scoringRunning || state.pollRunning,
              onclick: scorePending,
            },
            state.scoringRunning ? "Scoring…" : `Score pending (${scoringPending})`
          )
        : null,
      el("button", { class: "ghost", onclick: runResumePipeline, title: "Queue tailored résumés for all fresh matches ≥ 70% that don't have one yet" }, "Generate résumés")
    ),
    (!applyMode)
      ? el("div", { class: "toolbar toolbar-filters" }, sortSel, ...filterSelects)
      : null
  );

  const degradedBanner = llmDegraded
    ? el(
        "div",
        { class: "banner warn" },
        "LLM scoring is degraded — some fresh jobs carry low-confidence keyword scores (amber “approx. score” tag). Re-score them once the LLM is healthy."
      )
    : null;

  queueKeyHandler = onQueueKeydown;
  document.addEventListener("keydown", queueKeyHandler);

  await loadList();
  return el("div", { class: "stack" }, queueKpis, degradedBanner, toolbar, kbdHelpCard(), prefillBanner, list);
}

// ---- prefill-ahead (phone decides, desktop fills) ---------------------------
const PREFILL_HOST_RE = /greenhouse\.io\/|jobs\.ashbyhq\.com|jobs\.lever\.co/i;
const PREFILL_ACTIVE = new Set(["queued", "running", "ready"]);

function prefillStatusTag(j: Job): HTMLElement | null {
  const p = j.prefill;
  if (!p) return null;
  const map: Record<string, [string, string, string]> = {
    queued: ["prefill-queued", "Prefill queued", "Waiting for the desktop Chrome to open and fill this form"],
    running: ["prefill-running", "Filling…", "The apply engine is filling this form on the desktop"],
    ready: [
      p.unanswered ? "prefill-open" : "prefill-ready",
      p.unanswered ? `${p.unanswered} to answer` : "Ready to submit",
      p.unanswered ? "Form filled on the desktop — open the job to answer the remaining questions from here" : "Form filled and parked on the desktop — Submit is yours",
    ],
    needs_desktop: ["prefill-needs", "Needs desktop", "Couldn't prefill unattended (no form / login wall / unsupported host) — apply from the desktop"],
    error: ["prefill-needs", "Prefill failed", "The engine never reported — apply from the desktop"],
    submitted: ["prefill-ready", "Submitted", "Application submitted"],
    cancelled: ["prefill-muted", "Prefill cancelled", ""],
    expired: ["prefill-muted", "Prefill expired", "Parked form was closed after 12h — queue it again"],
  };
  const [cls, text, title] = map[p.status] ?? ["prefill-muted", p.status, ""];
  return el("span", { class: `tag ${cls}`, title }, text);
}

async function requestPrefillFor(id: string): Promise<boolean> {
  try {
    const r = await api.requestPrefill(id);
    if (r.ok) {
      toast(r.reason === "already_active" ? "Already queued for prefill" : "📱 Queued — the desktop Chrome will fill it within a minute");
      return true;
    }
    toast(
      r.reason === "no_resume"
        ? "No tailored résumé yet — generate one first"
        : r.reason === "unsupported_host"
          ? "Not an engine host (LinkedIn / Workday / company site) — apply from the desktop"
          : `Can't prefill: ${r.reason ?? "unknown"}`,
      true
    );
    return false;
  } catch (err) {
    toast((err as Error).message, true);
    return false;
  }
}

/**
 * Apply-view section: prefill status, the filled field table, the open questions
 * as inputs (answers are banked + the parked tab re-fills), screenshot. Polls
 * while the desktop is working. `alive()` stops the poll once the modal closes.
 */
function prefillSection(id: string, j: Job, alive: () => boolean): HTMLElement {
  const box = el("div", { class: "section-block prefill-box" });
  let timer = 0;
  const stop = () => { if (timer) { window.clearInterval(timer); timer = 0; } };

  const render = async () => {
    if (!alive()) { stop(); return; }
    let d: import("./api.js").PrefillDetail | null = null;
    try {
      d = await api.prefill(id);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        box.innerHTML = "";
        box.append(el("h4", {}, "📱 Prefill-ahead"), el("div", { class: "banner err" }, (err as Error).message));
        return;
      }
    }
    if (!alive()) { stop(); return; }
    box.innerHTML = "";
    box.append(el("h4", {}, "📱 Prefill-ahead (desktop fills, you decide)"));

    const canQueue = PREFILL_HOST_RE.test(j.url) && j.state !== "applied" && j.state !== "skipped";
    const queueBtn = (label = "📱 Prefill on desktop") =>
      el("button", { class: "primary", onclick: async () => { if (await requestPrefillFor(id)) void render(); } }, label);

    if (!d || ["cancelled", "expired"].includes(d.status)) {
      box.append(
        el("div", { class: "muted", style: "margin-bottom:8px" },
          canQueue
            ? "Queue it and the desktop Chrome opens the form in a background window, attaches the résumé and fills what it can. You review and answer the rest from here."
            : PREFILL_HOST_RE.test(j.url) ? "Not actionable." : "Unsupported host for unattended fill (LinkedIn / Workday / company site) — use the desktop Copilot panel."),
        canQueue ? queueBtn(d?.status === "expired" ? "📱 Prefill again" : undefined) : ""
      );
      return;
    }

    const statusLine: Record<string, string> = {
      queued: "⏳ queued — the desktop picks it up on its next poll (≤ 1 min, Chrome must be open).",
      running: "⚙️ filling on the desktop…",
      ready: d.unanswered.length ? `✅ filled — ${d.unanswered.length} question(s) need you below.` : "✅ filled — nothing left for the engine. Submit is yours (desktop tab is parked).",
      needs_desktop: `🖥 needs the desktop: ${d.error ?? "couldn't fill unattended"}`,
      error: `⚠ ${d.error ?? "the engine never reported"}`,
      submitted: "✓ submitted.",
    };
    box.append(el("div", { style: "margin-bottom:8px" }, statusLine[d.status] ?? d.status));
    if (d.status === "ready" && d.refillRequested) {
      box.append(el("div", { class: "muted", style: "margin-bottom:8px" }, "↻ new answers sent — the desktop is re-filling…"));
    }
    if (d.resumeState && d.status === "ready") {
      box.append(el("div", { class: "muted", style: "margin-bottom:8px" },
        d.resumeState === "injected" || d.resumeState === "already" ? "📄 résumé attached" : `⚠ résumé not attached (${d.resumeState}) — attach it on the desktop`));
    }

    // Open questions → inputs. Sensitive ones are flagged "(yours to answer)" by the engine.
    if (d.status === "ready" && d.unanswered.length) {
      const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
      const form = el("div", { class: "prefill-questions" });
      for (const q of d.unanswered) {
        const long = /why|tell us|describe|explain|cover/i.test(q);
        const input = (long
          ? el("textarea", { rows: "3", placeholder: "your answer" })
          : el("input", { type: "text", placeholder: "your answer" })) as HTMLInputElement | HTMLTextAreaElement;
        inputs.set(q, input);
        form.append(el("label", { class: "field" }, el("span", {}, q), input));
      }
      const send = el("button", { class: "primary", onclick: async () => {
        const answers: Record<string, string> = {};
        for (const [q, inp] of inputs) if (inp.value.trim()) answers[q] = inp.value.trim();
        if (!Object.keys(answers).length) { toast("Type at least one answer", true); return; }
        (send as HTMLButtonElement).disabled = true;
        try {
          const r = await api.answerPrefill(id, answers);
          toast(`Saved ${r.banked} answer(s)${r.refill ? " — desktop is re-filling" : ""}`);
          void render();
        } catch (err) {
          toast((err as Error).message, true);
          (send as HTMLButtonElement).disabled = false;
        }
      } }, "Send answers → re-fill");
      box.append(form, el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 10px" }, send));
    }

    // Filled field table (collapsed by default on phones — it can be long).
    if (d.fields.length) {
      const det = el("details", {});
      det.append(el("summary", { class: "muted", style: "cursor:pointer" }, `${d.fields.filter((f) => f.value).length}/${d.fields.length} fields filled — show`));
      const tbl = el("table", { class: "prefill-fields" });
      for (const f of d.fields) {
        tbl.append(el("tr", {},
          el("td", { class: "muted" }, f.label),
          el("td", { class: f.value ? "" : "muted" }, f.value || "—"),
          el("td", { class: "muted", style: "white-space:nowrap" }, f.source === "engine" ? "🤖" : f.source === "empty" ? "" : "👤")));
      }
      det.append(el("div", { style: "overflow-x:auto" }, tbl));
      box.append(det);
    }
    if (d.hasScreenshot) {
      const img = el("img", {
        src: `${api.prefillScreenshotUrl(id)}?t=${d.updatedAt}`,
        alt: "form screenshot",
        style: "max-width:100%;border:1px solid var(--border);border-radius:8px;margin-top:8px",
        loading: "lazy",
      });
      box.append(img);
    }

    const actions = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:10px" });
    if (PREFILL_ACTIVE.has(d.status)) {
      actions.append(el("button", { class: "ghost", onclick: async () => { await api.cancelPrefill(id); toast("Prefill cancelled — the parked tab closes on the next poll"); void render(); } }, "Cancel prefill"));
    } else if (canQueue && (d.status === "needs_desktop" || d.status === "error")) {
      actions.append(queueBtn("📱 Try again"));
    }
    box.append(actions);

    // Poll while the desktop is working, or a refill is pending.
    const busy = d.status === "queued" || d.status === "running" || (d.status === "ready" && d.refillRequested);
    if (busy && !timer) timer = window.setInterval(() => void render(), 5000);
    if (!busy) stop();
  };
  void render();
  return box;
}

// Per-job auto résumé indicator. "Ready" links straight to the tailored PDF.
function resumeStatusTag(j: Job): HTMLElement | null {
  const r = j.resume;
  if (!r || r.status === "none") return null;
  if (r.status === "ready") {
    const fmt = r.formats.includes("pdf") ? "pdf" : r.formats[0] ?? "txt";
    return el(
      "a",
      {
        class: "tag resume-ready",
        href: api.resumeFileUrl(j.id, fmt),
        target: "_blank",
        title: `Tailored résumé ready (${r.formats.join(", ")}) — click for ${fmt.toUpperCase()}`,
      },
      "Résumé ready"
    );
  }
  if (r.status === "generating") return el("span", { class: "tag resume-generating" }, "Résumé…");
  if (r.status === "queued") return el("span", { class: "tag resume-queued" }, "Résumé queued");
  return el("span", { class: "tag resume-error", title: r.error ?? "generation failed" }, "Résumé failed");
}

function jobPostingHref(url: string | null | undefined): string | null {
  if (!url?.startsWith("http")) return null;
  return url.replace("https://boards.greenhouse.io/", "https://job-boards.greenhouse.io/");
}

/** Hosts the fill script has an adapter for (mirrors extension/applyAdapters.js). */
const ASSIST_HOST_RE =
  /^https:\/\/(job-boards\.greenhouse\.io|boards\.greenhouse\.io|jobs\.ashbyhq\.com|jobs\.lever\.co)\//i;

/**
 * The application form itself, not the posting page. Ashby and Lever park the
 * form one segment below; the desktop engine navigates there on its own, but a
 * script injected by a Shortcut dies with the navigation, so the phone link has
 * to land on the form directly.
 *
 * The `#jh-apply=<id>` handoff is appended because it serves both phone paths
 * without having to detect which one is present: an extension (Android
 * Chromium browsers run this one) picks the hash up and fills automatically,
 * and the iOS Shortcut ignores it — /apply/fill-script resolves the job from
 * the URL instead.
 */
function applyFormHref(url: string | null | undefined, jobId?: string): string | null {
  const href = jobPostingHref(url);
  if (!href) return null;
  const bare = href.replace(/\/$/, "");
  let form = href;
  if (/jobs\.ashbyhq\.com/i.test(bare) && !/\/application$/.test(bare)) form = `${bare}/application`;
  else if (/jobs\.lever\.co/i.test(bare) && !/\/apply$/.test(bare)) form = `${bare}/apply`;
  return jobId ? `${form}#jh-apply=${jobId}` : form;
}

/** Append the job-id handoff without losing the rest of the URL. */
function withApplyHandoff(url: string | null | undefined, jobId: string): string | null {
  if (!url?.startsWith("http")) return null;
  try {
    const u = new URL(url);
    u.hash = `jh-apply=${jobId}`;
    return u.toString();
  } catch {
    return `${url}#jh-apply=${jobId}`;
  }
}

/** One tap = one value on the clipboard. The chip itself is the feedback. */
function copyChip(label: string, value: string): HTMLElement {
  const chip = el(
    "button",
    { class: "copy-chip", type: "button" },
    el("span", { class: "k" }, label),
    el("span", { class: "v", title: value }, value)
  );
  chip.addEventListener("click", async () => {
    const ok = await copyText(value);
    if (!ok) {
      toast("Couldn't reach the clipboard — long-press the text to copy", true);
      return;
    }
    chip.classList.add("copied");
    setTimeout(() => chip.classList.remove("copied"), 1200);
  });
  return chip;
}

/**
 * The phone half of the apply flow.
 *
 * On a supported ATS this is mostly instructions, because the iOS Shortcut does
 * the filling (docs/phone-apply-design.md). Everywhere else — Workday,
 * LinkedIn, custom career sites — the chips are the whole answer: the human
 * types, but never has to remember or re-derive a value, and the banked
 * screening answers ride along.
 */
async function phoneApplyBlock(pkg: ApplyPackage): Promise<HTMLElement> {
  const j = pkg.job;
  const formHref = applyFormHref(j.url, j.id);
  const assisted = ASSIST_HOST_RE.test(jobPostingHref(j.url) ?? "");
  const resumeReady = j.resume?.status === "ready" || (pkg.renderedResume ?? "") !== "";

  let fields: import("./api.js").ApplyFields | null = null;
  try {
    fields = await api.applyFields();
  } catch {
    /* no master profile yet — the steps still apply, there's just nothing to copy */
  }

  const chips: HTMLElement[] = [];
  if (fields) {
    const contact: [string, string][] = [
      ["name", fields.fullName],
      ["email", fields.email],
      ["phone", fields.phone],
      ["location", fields.location],
      ["linkedin", fields.linkedinUrl],
      ["website", fields.websiteUrl],
      ["company", fields.currentCompany],
      ["title", fields.currentTitle],
    ];
    for (const [k, v] of contact) if (v) chips.push(copyChip(k, v));
  }
  for (const [q, a] of Object.entries(pkg.screeningAnswers ?? {})) {
    if (a) chips.push(copyChip(q.length > 28 ? `${q.slice(0, 28)}…` : q, a));
  }
  if (pkg.tailored?.cover_letter) chips.push(copyChip("cover letter", pkg.tailored.cover_letter));

  return el(
    "div",
    { class: "section-block" },
    el("h4", {}, "📱 Apply from this phone"),
    assisted
      ? el(
          "div",
          {},
          el(
            "ol",
            { class: "step-list" },
            el("li", {}, "Open the form below."),
            el(
              "li",
              {},
              "With the extension installed (Android): it fills automatically. ",
              el("span", { class: "muted" }, "Otherwise: Share → JobHunt Fill (iOS Shortcut).")
            ),
            el("li", {}, "Review every field, then tap the form's own Submit."),
            el("li", {}, "The extension records it; the Shortcut sheet has a “✓ I submitted” link.")
          )
        )
      : el(
          "div",
          { class: "muted", style: "font-size:12.5px" },
          `${j.source} has no full auto-fill — open it, then tap a field for presets (extension or Share → JobHunt Fill). ` +
            "Login and Next stay yours. Tap Upload to attach this job's résumé. Submit is always you."
        ),
    !resumeReady &&
      el(
        "div",
        { class: "banner warn", style: "margin-top:8px" },
        "No tailored résumé yet — generate it below first so the shortcut has something to attach."
      ),
    el(
      "div",
      { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:10px" },
      formHref &&
        el(
          "a",
          { class: "copy-chip", href: formHref, target: "_blank", rel: "noopener noreferrer",
            style: "border-color:var(--accent);color:var(--text)" },
          assisted ? "Open the form ▸" : "Open the application ▸"
        ),
      resumeReady &&
        el(
          "a",
          { class: "copy-chip", href: api.resumeFileUrl(j.id, "pdf"), target: "_blank", rel: "noopener noreferrer" },
          "⤓ Résumé PDF → Files"
        )
    ),
    chips.length > 0 &&
      el(
        "div",
        { style: "margin-top:10px" },
        el("div", { class: "muted", style: "font-size:12px;margin-bottom:4px" }, "Tap to copy:"),
        ...chips
      )
  );
}

// ---- salary floor (read from /health; backend config.salary, off by default) ---
// Known-below-floor jobs leave the apply queue/stream/notify; unknown salary
// always passes (tagged in the apply queue instead of hidden).
let salaryFloors = { hybridCad: 0, remoteCad: 0 };
function salaryFloorLabel(): string {
  if (!salaryFloors.hybridCad && !salaryFloors.remoteCad) return "";
  const k = (n: number) => `${Math.round(n / 1000)}K`;
  return ` · ≥${k(salaryFloors.hybridCad)} CAD hybrid / ${k(salaryFloors.remoteCad)} remote`;
}
function belowSalaryFloor(j: Job): boolean {
  if (j.salary_max_cad == null) return false;
  const floor =
    j.workplace === "hybrid" || j.workplace === "onsite" ? salaryFloors.hybridCad : salaryFloors.remoteCad;
  return floor > 0 && j.salary_max_cad < floor;
}
function salaryTag(j: Job): HTMLElement | null {
  if (j.salary_max_cad != null) {
    const fmt = (n: number) => `${Math.round(n / 1000)}K`;
    const range =
      j.salary_min_cad != null && j.salary_min_cad !== j.salary_max_cad
        ? `${fmt(j.salary_min_cad)}–${fmt(j.salary_max_cad)}`
        : fmt(j.salary_max_cad);
    const below = belowSalaryFloor(j);
    return el(
      "span",
      {
        class: `tag ${below ? "salary-below" : "salary-ok"}`,
        title: `Annualized, CAD-normalized (parsed from the posting)${j.workplace && j.workplace !== "unknown" ? ` · ${j.workplace}` : ""}`,
      },
      `${range} CAD${below ? " below floor" : ""}`
    );
  }
  // Unknown salary: tag only in the apply queue — that's where "verify before
  // investing time" matters; everywhere else it's noise.
  return state.queueMode === "apply"
    ? el("span", { class: "tag salary-unknown", title: "No salary in the posting — verify before investing time" }, "No salary")
    : null;
}

function jobCard(j: Job): HTMLElement {
  const score = j.relevance_score;
  const regionBlocked = score != null && score < 0;
  const pct = score == null || regionBlocked ? "—" : `${Math.round(score * 100)}`;
  const cls = score == null || regionBlocked ? "low" : score >= 0.7 ? "high" : score >= 0.45 ? "mid" : "low";
  const fresh = score != null && score >= 0.7 && j.state !== "applied" && j.state !== "skipped";
  // Heuristic-scored = LLM was down when this job was scored → visibly flagged.
  const heuristic = j.scored_by === "heuristic" && score != null && !regionBlocked;

  const act = (label: string, fn: () => void, primary = false) =>
    el("button", { class: primary ? "primary" : "ghost", onclick: (e: Event) => { e.stopPropagation(); fn(); } }, label);

  const setState = (s: string) => void applyJobState(j.id, s);
  const showState = state.queueMode === "all" || (j.state !== "discovered" && j.state !== "notified");
  const flags = [
    showState ? el("span", { class: `tag state-${j.state}` }, j.state) : null,
    heuristic
      ? el(
          "span",
          {
            class: "tag score-heuristic",
            title: "Scored by keyword heuristics — LLM was unavailable. Re-score when the LLM is back.",
          },
          "approx. score"
        )
      : null,
    resumeStatusTag(j),
    prefillStatusTag(j),
    salaryTag(j),
  ].filter(Boolean) as HTMLElement[];

  return el(
    "div",
    {
      class: `card job ${fresh ? "fresh" : ""} ${j.state === "applied" ? "applied" : ""} ${j.state === "skipped" ? "skipped" : ""}`,
      "data-job-id": j.id,
      onclick: () => selectCard(j.id),
    },
    el(
      "div",
      {
        class: `score ${cls}${heuristic ? " heur" : ""}`,
        title: (heuristic ? "Scored by keyword heuristics (LLM unavailable)\n" : "") + (j.relevance_reason ?? ""),
      },
      pct,
      el("small", {}, regionBlocked ? "region" : heuristic ? "approx" : "match")
    ),
    el(
      "div",
      { class: "job-main" },
      el("h3", {}, (() => {
        const href = jobPostingHref(j.url);
        return href
          ? el("a", { href, target: "_blank", rel: "noopener noreferrer" }, j.title)
          : j.title;
      })()),
      el(
        "div",
        { class: "job-kicker" },
        el("span", { class: "company" }, j.company ?? "—"),
        j.location && el("span", {}, j.location),
        j.workplace &&
          j.workplace !== "unknown" &&
          !(j.location ?? "").toLowerCase().includes(j.workplace) &&
          el("span", {}, j.workplace),
        j.employment_type &&
          j.employment_type !== "full_time" &&
          j.employment_type !== "unknown" &&
          el("span", {}, j.employment_type.replaceAll("_", " ")),
        el("span", {}, timeAgo(jobAge(j))),
        el("span", {}, j.source)
      ),
      flags.length ? el("div", { class: "job-flags" }, ...flags) : null,
      j.relevance_reason && el("div", { class: "reason", title: j.relevance_reason }, j.relevance_reason)
    ),
    el(
      "div",
      { class: "row-actions" },
      j.state !== "applied" && act("Apply", () => openApply(j.id), true),
      j.state !== "applied" &&
        j.state !== "skipped" &&
        j.resume?.status === "ready" &&
        PREFILL_HOST_RE.test(j.url) &&
        !(j.prefill && PREFILL_ACTIVE.has(j.prefill.status)) &&
        act("Prefill", async () => {
          if (await requestPrefillFor(j.id)) {
            j.prefill = { status: "queued", unanswered: 0, updatedAt: Date.now() };
            replaceJobCard(j);
          }
        }),
      j.state !== "relevant" && j.state !== "applied" && act("Relevant", () => setState("relevant")),
      j.state !== "skipped" && j.state !== "applied" && act("Skip", () => setState("skipped")),
      j.state === "skipped" && act("Un-skip", () => setState("relevant"))
    )
  );
}

// ---- paste-anything capture (recruiter email / LinkedIn message / any text) --
// LLM extracts title/company/location + a cleaned JD from whatever is pasted,
// then the normal capture → score → résumé pipeline applies.
function pasteTextCard(): HTMLElement {
  const text = el("textarea", {
    rows: "8",
    placeholder:
      "Paste anything containing a job — a recruiter email, LinkedIn message, Slack post… The AI extracts the title, company, and job description automatically.",
    style: "width:100%",
  }) as HTMLTextAreaElement;
  const url = el("input", {
    type: "url",
    placeholder: "Original link, if you have one (optional)",
    style: "width:100%",
  }) as HTMLInputElement;
  const status = el("span", { class: "muted" });
  // Manual fix-up row, shown only when extraction isn't confident.
  const title = el("input", { placeholder: "Title", style: "width:100%" }) as HTMLInputElement;
  const company = el("input", { placeholder: "Company", style: "width:100%" }) as HTMLInputElement;
  const location = el("input", { placeholder: "Location", style: "width:100%" }) as HTMLInputElement;
  const manualRow = el(
    "div",
    { style: "display:none;flex-direction:column;gap:8px" },
    el("div", { class: "muted", style: "font-size:12px" },
      "Couldn't confidently auto-extract — check/fix these fields and capture anyway:"),
    el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
      el("div", { style: "flex:1;min-width:140px" }, title),
      el("div", { style: "flex:1;min-width:140px" }, company),
      el("div", { style: "flex:1;min-width:140px" }, location)),
    el("button", { class: "ghost", style: "align-self:flex-start", onclick: () => void captureManually() }, "Capture with these fields")
  );

  const captureManually = async () => {
    const raw = text.value.trim();
    if (raw.length < 100) return toast("Paste more of the job text first", true);
    if (!title.value.trim()) return toast("A title is required", true);
    try {
      status.textContent = "Saving…";
      const res = await api.pageCapture({
        url: url.value.trim() || `pasted://${Date.now().toString(36)}`,
        rawText: raw,
        title: title.value.trim(),
        company: company.value.trim() || undefined,
        location: location.value.trim() || undefined,
        source: "manual-paste",
        captureKind: "right_click",
      });
      toast(res.jobId ? "Captured — scoring now" : "Captured");
      render();
    } catch (err) {
      status.textContent = "";
      toast((err as Error).message, true);
    }
  };

  const extract = async () => {
    const raw = text.value.trim();
    if (raw.length < 100) return toast("Paste more of the job text first (100+ characters)", true);
    try {
      status.textContent = "Extracting…";
      const r = await api.captureFromText({ rawText: raw, url: url.value.trim() || undefined });
      status.textContent = "";
      if (r.ok) {
        toast(`Captured: ${r.extracted.title ?? "job"}${r.extracted.company ? ` @ ${r.extracted.company}` : ""} — scoring now`);
        render();
        return;
      }
      // Low confidence / LLM down — prefill the fix-up row.
      title.value = r.extracted.title ?? "";
      company.value = r.extracted.company ?? "";
      location.value = r.extracted.location ?? "";
      manualRow.style.display = "flex";
      toast(r.error ?? "Couldn't auto-extract — fix the fields below", true);
    } catch (err) {
      status.textContent = "";
      toast((err as Error).message, true);
    }
  };

  const body = el(
    "div",
    { class: "fold-body" },
    el("div", { class: "muted", style: "font-size:12px" },
      "Got a job via email or LinkedIn message? Paste the whole thing — greetings, signatures and all. The extractor pulls out the actual job and cleans it up. Works from the extension too: select text on any page → right-click → Capture selection as job."),
    text,
    url,
    el("div", { style: "display:flex; gap:10px; align-items:center" },
      el("button", { class: "primary", onclick: () => void extract() }, "Extract & capture"),
      status),
    manualRow
  );

  const details = el("details", { class: "card fold", open: true }) as HTMLDetailsElement;
  details.append(
    el("summary", {}, "Paste anything (email / message / JD)"),
    body
  );
  return details;
}

// ---- manual capture (iPad / phone / any device without the extension) ------
// Paste a job posting's URL + description straight into the queue. Same pipeline
// as the extension's right-click capture: creates a job, saves the JD, auto-scores.
function manualCaptureCard(): HTMLElement {
  const url = el("input", { type: "url", placeholder: "Job posting URL (paste from Safari share/address bar)", style: "width:100%" }) as HTMLInputElement;
  const title = el("input", { placeholder: "Title (optional)", style: "width:100%" }) as HTMLInputElement;
  const company = el("input", { placeholder: "Company (optional)", style: "width:100%" }) as HTMLInputElement;
  const location = el("input", { placeholder: "Location (optional)", style: "width:100%" }) as HTMLInputElement;
  const jd = el("textarea", {
    rows: "8",
    placeholder: "Paste the full job description here (select-all + copy on the job page, then paste). Used for matching + tailoring — never copied into your résumé.",
    style: "width:100%",
  }) as HTMLTextAreaElement;
  const status = el("span", { class: "muted" });

  const fetchFromUrl = async () => {
    const u = url.value.trim();
    if (!/^https?:\/\//i.test(u)) {
      toast("Paste the job's URL first (starting with http/https)", true);
      return;
    }
    try {
      status.textContent = "Fetching…";
      const r = await api.captureFromUrl(u);
      if (r.ok && r.jobId) {
        toast("Captured from URL — scoring now.");
        render();
        return;
      }
      // Couldn't read the full JD — prefill what we found and ask for a paste.
      if (r.extracted?.title && !title.value) title.value = r.extracted.title;
      if (r.extracted?.company && !company.value) company.value = r.extracted.company;
      if (r.extracted?.location && !location.value) location.value = r.extracted.location;
      if (r.extracted?.description && !jd.value) jd.value = r.extracted.description;
      status.textContent = "";
      toast(
        (r.error ?? "Couldn't auto-read the description") +
          " — paste the JD below and tap Capture.",
        true
      );
    } catch (err) {
      status.textContent = "";
      toast((err as Error).message, true);
    }
  };

  const save = async () => {
    const u = url.value.trim();
    const text = jd.value.trim();
    if (!/^https?:\/\//i.test(u)) {
      toast("Paste the job's URL (starting with http/https)", true);
      return;
    }
    if (text.length < 40) {
      toast("Paste the job description (a bit more text)", true);
      return;
    }
    try {
      status.textContent = "Saving…";
      const res = await api.pageCapture({
        url: u,
        rawText: text,
        title: title.value.trim() || undefined,
        company: company.value.trim() || undefined,
        location: location.value.trim() || undefined,
        source: "manual",
        captureKind: "right_click",
      });
      toast(res.jobId ? "Job captured — scoring now. Generate a résumé below." : "Captured");
      render();
    } catch (err) {
      status.textContent = "";
      toast((err as Error).message, true);
    }
  };

  const body = el(
    "div",
    { class: "fold-body" },
    el("div", { class: "muted", style: "font-size:12px" },
      "Paste a job URL and tap Fetch — for many sites (Greenhouse, Lever, Ashby, LinkedIn) it auto-reads the posting. If it can't, copy the description from the page and paste it below, then Capture."),
    el("div", { style: "display:flex; gap:8px; flex-wrap:wrap; align-items:center" },
      el("div", { style: "flex:1; min-width:180px" }, url),
      el("button", { class: "ghost", onclick: fetchFromUrl }, "Fetch from URL")),
    el("div", { style: "display:flex; gap:8px; flex-wrap:wrap" },
      el("div", { style: "flex:1; min-width:140px" }, title),
      el("div", { style: "flex:1; min-width:140px" }, company),
      el("div", { style: "flex:1; min-width:140px" }, location)),
    jd,
    el("div", { style: "display:flex; gap:10px; align-items:center" },
      el("button", { class: "primary", onclick: save }, "Capture job"),
      status)
  );

  const details = el("details", { class: "card fold" }) as HTMLDetailsElement;
  details.append(
    el("summary", {}, "Paste a job URL (phone / no extension)"),
    body
  );
  return details;
}

// ---- scan a LinkedIn search (server-side, works on iPad / phone) -----------
// Paste a LinkedIn Jobs search URL; the backend re-runs it via the public guest API,
// fetches each JD, triages against your profile, and saves the matches to the queue.
function linkedinScanCard(): HTMLElement {
  const url = el("input", {
    type: "url",
    placeholder: "Paste a LinkedIn Jobs search URL (with your keyword + filters)",
    style: "width:100%",
  }) as HTMLInputElement;
  const status = el("span", { class: "muted" });
  const resultsBox = el("div", { style: "margin-top:8px" });

  const scan = async () => {
    const u = url.value.trim();
    if (!/linkedin\.com/i.test(u)) {
      toast("Paste a LinkedIn Jobs search URL", true);
      return;
    }
    resultsBox.innerHTML = "";
    status.textContent = "Scanning… (fetching + triaging, ~10–20s)";
    try {
      const r = await api.scanLinkedIn(u, { persist: true });
      status.textContent = "";
      toast(`Scanned ${r.scanned} · ${r.strong} strong / ${r.maybe} maybe · ${r.persisted} added to queue`);
      const strong = r.results.filter((x) => x.verdict === "strong").length;
      resultsBox.append(
        el("div", { class: "muted", style: "font-size:12px;margin-bottom:6px" },
          `${r.scanned} scanned · ${strong} strong · added to your queue (sorted by match).`)
      );
      for (const x of r.results.slice().sort((a, b) => b.score - a.score)) {
        const pct = Math.round(x.score * 100);
        const cls = x.verdict === "strong" ? "state-relevant" : x.verdict === "maybe" ? "state-notified" : "state-skipped";
        const weak = pct < 70; // below the "good match" bar → explain why
        resultsBox.append(
          el("div", { style: "padding:6px 0;border-top:1px solid var(--border);font-size:13px" },
            el("div", { style: "display:flex;gap:8px;align-items:baseline" },
              el("span", { class: `tag ${cls}`, style: "min-width:64px;text-align:center" }, `${pct}%`),
              el("a", { href: x.url, target: "_blank", rel: "noopener noreferrer", style: "flex:1" },
                `${x.title}${x.company ? " · " + x.company : ""}`)),
            x.reason &&
              el("div", {
                style: `margin:2px 0 0 72px;font-size:12px;color:${weak ? "var(--amber,#d29922)" : "var(--muted)"}`,
              }, (weak ? "Why not a strong match: " : "") + x.reason))
        );
      }
      render();
    } catch (err) {
      status.textContent = "";
      toast((err as Error).message, true);
    }
  };

  const body = el(
    "div",
    { class: "fold-body" },
    el("div", { class: "muted", style: "font-size:12px" },
      "In the LinkedIn app/site, run a Jobs search (set your keyword + filters like 'past 24 hours'), copy the URL, paste it here. The backend scans the whole result list and adds matches to your queue — no extension needed."),
    el("div", { style: "display:flex; gap:8px; flex-wrap:wrap; align-items:center" },
      el("div", { style: "flex:1; min-width:180px" }, url),
      el("button", { class: "primary", onclick: scan }, "Scan search")),
    status,
    resultsBox
  );

  const details = el("details", { class: "card fold" }) as HTMLDetailsElement;
  details.append(
    el("summary", {}, "Scan a LinkedIn search"),
    body
  );
  return details;
}

// ---- captures (right-click JD snapshots) -----------------------------------
async function capturesView(): Promise<HTMLElement> {
  let llmOn = false;
  try {
    llmOn = (await api.health()).llmEnabled;
  } catch {
    /* offline */
  }

  const rows = await api.captures(100);
  const wrap = el("div", { class: "stack" });
  wrap.append(
    pageHead("Captures", "Paste, scan, or import a posting. The full JD is saved here for matching and tailoring."),
    el(
      "div",
      { class: "banner warn" },
      "From LinkedIn or any job page: right-click → Capture this job. ",
      llmOn ? "Generate a tailored résumé when you're ready." : "Add DEEPSEEK_API_KEY for LLM tailoring (offline mode otherwise)."
    )
  );

  wrap.append(pasteTextCard());
  wrap.append(linkedinScanCard());
  wrap.append(manualCaptureCard());

  try {
    const prof = await api.profile();
    const src = await api.tailorSource();
    if (!src.masterResumeAdequate) {
      wrap.append(
        el(
          "div",
          { class: "banner err" },
          "Your Profile master resume is only a short stub (",
          String((prof.masterResume ?? "").length),
          " chars). Paste your ",
          el("strong", {}, "full resume"),
          " with Experience + bullet points under ",
          el("strong", {}, "Profile"),
          ", then Re-generate. The JD is used for matching only — it is never copied into the résumé."
        )
      );
    }
  } catch {
    /* ignore */
  }

  if (rows.length === 0) {
    wrap.append(
      el(
        "div",
        { class: "empty" },
        "No captures yet. On LinkedIn, open a job in the split view, right-click → Capture this job for Job Hunt Assistant, then refresh this tab."
      )
    );
    return wrap;
  }

  const resumeBadge = (r: import("./api.js").CaptureRow) => {
    if (r.resume.status === "ready") return el("span", { class: "tag resume-ready" }, "Résumé ready");
    if (r.resume.status === "partial") return el("span", { class: "tag resume-generating" }, "Partial PDF");
    return el("span", { class: "tag resume-queued" }, "Not tailored");
  };

  for (const r of rows) {
    const jdBox = el("div", {
      class: "muted capture-jd",
      style: "max-height:0;overflow:hidden;white-space:pre-wrap;transition:max-height .2s",
    });
    let expanded = false;

    const toggleJd = async () => {
      if (!expanded) {
        try {
          const detail = await api.capture(r.captureId);
          jdBox.textContent = detail.jd;
        } catch {
          jdBox.textContent = r.jdPreview + "…";
        }
        jdBox.style.maxHeight = "320px";
        jdBox.style.overflow = "auto";
        jdBox.style.marginTop = "8px";
        expanded = true;
      } else {
        jdBox.style.maxHeight = "0";
        jdBox.style.overflow = "hidden";
        expanded = false;
      }
    };

    const gen = async () => {
      try {
        toast("DeepSeek tailoring + saving DOCX/PDF…");
        const result = await api.generateResume(r.jobId);
        if (result.renderError) toast(`Saved with note: ${result.renderError}`, true);
        else toast("Résumé ready — scroll for downloads");
        render();
      } catch (err) {
        toast((err as Error).message, true);
      }
    };

    const dlRow = el("div", { class: "dl-row" });
    if (r.resume.status !== "none") {
      for (const fmt of ["docx", "pdf", "txt"]) {
        if (r.resume.formats.includes(fmt)) {
          dlRow.append(
            el(
              "a",
              {
                class: "ghost",
                href: api.resumeFileUrl(r.jobId, fmt),
                download: "",
              },
              fmt.toUpperCase()
            )
          );
        }
      }
    }

    wrap.append(
      el(
        "div",
        { class: "card capture-card" },
        el(
          "div",
          { class: "capture-head" },
          el(
            "div",
            { style: "flex:1;min-width:200px" },
            el("h3", {},
              el("a", { href: r.url, target: "_blank" }, r.title || "(untitled)")),
            el(
              "div",
              { class: "meta" },
              el("span", {}, r.company ?? "—"),
              r.location && el("span", {}, r.location),
              el("span", {}, r.source ?? "capture"),
              el("span", {}, timeAgo(r.capturedAt)),
              el("span", { class: `tag state-${r.jobState}` }, r.jobState)
            ),
            r.salaryText &&
              el("div", { style: "margin-top:6px;color:var(--accent,#5b8cff);font-weight:600" }, r.salaryText),
            !r.salaryText &&
              el("div", { class: "muted", style: "margin-top:4px;font-size:12px" }, "No salary on the posting")
          ),
          el(
            "div",
            { class: "capture-actions" },
            resumeBadge(r),
            el(
              "div",
              { class: "row-actions" },
              el("button", { type: "button", class: "ghost", onclick: (e: Event) => { e.stopPropagation(); void toggleJd(); } }, "Show JD"),
              el("button", { type: "button", class: "primary", onclick: (e: Event) => { e.stopPropagation(); void gen(); } }, r.resume.status === "none" ? "Generate résumé" : "Re-generate"),
              el("button", {
                type: "button",
                class: "ghost",
                onclick: (e: Event) => {
                  e.stopPropagation();
                  toast("Opening apply view…");
                  void openApply(r.jobId);
                },
              }, "Apply")
            )
          )
        ),
        el("div", { class: "muted", style: "font-size:12px;margin-top:4px" },
          `${r.jdLength.toLocaleString()} chars captured · ${r.captureKind ?? "right_click"}`,
          !r.jdPreview.toLowerCase().includes("about the job") &&
            el("span", { style: "color:var(--amber);margin-left:8px" }, "JD may be incomplete — re-capture with the job detail open")),
        jdBox,
        dlRow
      )
    );
  }
  return wrap;
}

// ---- apply view (modal) ----------------------------------------------------
/**
 * Friendly dead-end when a job fetch 404s — jobs are scoped per account, so a
 * Slack deep link clicked while the browser is signed in as a different account
 * lands here (as does a link whose job no longer exists).
 */
async function jobNotFoundNotice(id: string): Promise<HTMLElement> {
  const box = el("div", { style: "display:flex;flex-direction:column;gap:10px" });
  box.append(el("div", { class: "banner err" }, `Job ${id} isn't in this account.`));
  if (isRemoteSession()) {
    const account = (await fetchHealth())?.account?.name;
    box.append(
      el(
        "div",
        { class: "muted" },
        "You're signed in as ",
        el("b", {}, String(account ?? "an account")),
        ". If this link came from a different account's Slack channel, ",
        el("a", { href: "/logout" }, "sign out"),
        " and sign in with that account's token, then open the link again."
      )
    );
  }
  box.append(
    el(
      "div",
      { class: "muted" },
      "The link may also be outdated — the job may no longer exist in this queue."
    )
  );
  return box;
}

/** Batch context for the apply-queue stepper: fixed id list + current position. */
interface ApplyBatch {
  ids: string[];
  index: number;
}

async function openApply(id: string, batch?: ApplyBatch) {
  // Résumé-generation UI timer (elapsed label + 3s status poll). Cleared on every
  // close path; each tick also self-clears if the modal has left the DOM.
  let genTimer: number | undefined;
  const bg = el("div", { class: "modal-bg" });
  bg.addEventListener("click", (e) => {
    if (e.target === bg) {
      window.clearInterval(genTimer);
      bg.remove();
    }
  });
  const modal = el("div", { class: "modal" }, el("div", { class: "muted" }, "Loading apply package…"));
  bg.append(modal);
  document.body.append(bg);

  let pkg: ApplyPackage;
  try {
    pkg = await api.applyPackage(id);
  } catch (err) {
    modal.innerHTML = "";
    if (err instanceof ApiError && err.status === 404) {
      modal.append(await jobNotFoundNotice(id));
    } else {
      modal.append(el("div", { class: "banner err" }, (err as Error).message));
    }
    return;
  }
  modal.innerHTML = "";
  const j = pkg.job;

  const close = () => {
    window.clearInterval(genTimer);
    bg.remove();
  };
  // Advance the batch stepper to the next job, or announce the end of the queue.
  const nextInBatch = () => {
    if (!batch) return;
    const nextIndex = batch.index + 1;
    if (nextIndex < batch.ids.length) {
      void openApply(batch.ids[nextIndex]!, { ids: batch.ids, index: nextIndex });
    } else {
      toast(`Batch done — ${batch.ids.length} job(s) reviewed 🎉`);
    }
  };
  // From the queue: update/remove just this job's card in place (scroll + filters
  // survive). From captures / deep links (no card in the DOM): full refresh.
  const finishFromModal = (updated: Job | null) => {
    close();
    if (updated && findCard(updated.id)) {
      if (matchesCurrentFilter(updated)) replaceJobCard(updated);
      else removeJobCard(updated.id);
      bumpCounts(0);
    } else if (!batch) {
      // In batch mode the next modal opens immediately — skip the full re-render
      // that would reset queue scroll under it.
      render();
    }
    nextInBatch();
  };
  const doApply = async () => {
    // Open the posting with #jh-apply so the extension (and the phone
    // fill-script) know which résumé and answers to use. Login, account
    // creation, Next, CAPTCHA and Submit stay human — the helper only
    // offers presets on focus and attaches the PDF when you click Upload.
    const knownAssist = ASSIST_HOST_RE.test(jobPostingHref(j.url) ?? "");
    const linkedIn = /linkedin\.com\/jobs/i.test(j.url);
    const href =
      isPhone() && knownAssist
        ? applyFormHref(j.url, id)
        : withApplyHandoff(jobPostingHref(j.url) ?? j.url, id);
    if (!href) {
      toast("This job has no URL to open", true);
      return;
    }
    window.open(href, "_blank");
    toast(
      knownAssist || linkedIn
        ? "Assist launched — login/Next yourself if asked; tap a field for presets; Upload gets the résumé. You click Submit."
        : "Opened — in the extension, turn on “Field helper on every site” once (or right-click the page). Tap a field for presets; Upload gets this résumé. You click Submit."
    );
    close();
    nextInBatch();
  };
  // ---- résumé generation feedback ------------------------------------------
  // Generation takes ~30–120s (DeepSeek tailoring + DOCX/PDF render). The
  // synchronous POST is the primary completion signal for the button; the 3s
  // status poll (see genTimer below) covers jobs picked up by the background
  // resume_tasks pipeline and completions from other tabs/devices.
  const GEN_BTN_LABEL = "Generate résumé (TXT+DOCX+PDF)";
  type GenPhase = "idle" | "inflight" | "queued" | "running";
  let genPhase: GenPhase = "idle";
  let genStartedAt = 0;
  let genErrorMsg: string | null = null;
  // manifest.json is written LAST by generateResumeForJob, so its generated_at
  // marks a completed run — the poll compares it against this baseline to detect
  // a fresh generation without misreading mid-run partial artifacts as done.
  let seenManifestAt = 0;
  const manifestAt = (st: import("./api.js").JobResumeStatus): number =>
    st.artifacts.find((a) => a.format === "manifest")?.generatedAt ?? st.generatedAt ?? 0;

  const genBtn = el("button", { class: "ghost", onclick: () => void generateResume() }, GEN_BTN_LABEL);

  const genElapsedLabel = () => {
    const ms = Date.now() - genStartedAt;
    return ms < 3000 ? "Generating… ~1 min" : `Generating… ${formatDuration(ms)}`;
  };

  function showGenInProgress(phase: "queued" | "running") {
    genBtn.disabled = true;
    genBtn.textContent = phase === "queued" ? "Queued…" : genElapsedLabel();
    resumeDownloadsEl.innerHTML = "";
    resumeDownloadsEl.append(
      el("h4", {}, "Saved résumé files"),
      el(
        "div",
        { class: "gen-progress" },
        el("span", { class: "gen-spinner" }),
        el(
          "span",
          {},
          phase === "queued"
            ? "Queued — waiting for the résumé worker…"
            : "Tailoring with DeepSeek + rendering DOCX/PDF… usually ~1 min."
        ),
        el("span", { class: "gen-progress-elapsed muted" }, "")
      )
    );
  }

  function resetGenUi() {
    genBtn.disabled = false;
    genBtn.textContent = GEN_BTN_LABEL;
  }

  /** Re-render the downloads section from current server state (also re-baselines). */
  async function refreshDownloadsFromStatus(): Promise<void> {
    try {
      const st = await api.resumeStatus(id);
      seenManifestAt = manifestAt(st);
      if (st.artifacts.length) {
        renderResumeDownloads({
          jobId: id,
          dir: st.dir,
          artifacts: st.artifacts,
          keywordCoverage: null,
          changesSummary: null,
          renderError: null,
          renderedResume: null,
        });
      } else {
        renderResumeDownloads();
      }
    } catch {
      renderResumeDownloads();
    }
  }

  const generateResume = async () => {
    if (genPhase !== "idle") return; // already generating — ignore repeat clicks
    genPhase = "inflight";
    genErrorMsg = null;
    genStartedAt = Date.now();
    showGenInProgress("running");
    try {
      const gen = await api.generateResume(id);
      genPhase = "idle";
      resetGenUi();
      if (gen.renderError) toast(`Partial: ${gen.renderError}`, true);
      else if (gen.tailoredMode === "offline")
        toast("Saved, but NOT tailored — LLM was offline (see banner)", true);
      else toast("Résumé ready — download links below");
      renderResumeDownloads(gen);
      // Re-baseline so the poll doesn't re-announce this same result.
      void api.resumeStatus(id).then((st) => { seenManifestAt = manifestAt(st); }).catch(() => {});
    } catch (err) {
      genPhase = "idle";
      genErrorMsg = (err as Error).message;
      resetGenUi();
      toast((err as Error).message, true);
      // Shows the inline error banner + whatever artifacts exist. If the request
      // died but the server is still generating, the poll announces completion.
      void refreshDownloadsFromStatus();
    }
  };
  const tailoredModeBadge = (mode: "llm" | "offline" | null | undefined) => {
    if (mode === "offline")
      return el(
        "div",
        { class: "banner warn", style: "margin:6px 0" },
        "⚠ NOT tailored — generated in offline mode (LLM unavailable). This is your master résumé filtered by keyword overlap, not a model-tailored draft. Re-generate once the LLM is back."
      );
    if (mode === "llm")
      return el(
        "div",
        { class: "muted", style: "margin:6px 0;font-size:12px" },
        "✓ LLM-tailored to this job."
      );
    return el("span", {});
  };
  const resumeDownloadsEl = el("div", { class: "section-block", id: "resume-downloads" });

  function renderResumeDownloads(gen?: import("./api.js").GenerateResumeResult) {
    resumeDownloadsEl.innerHTML = "";
    resumeDownloadsEl.append(el("h4", {}, "Saved résumé files"));
    if (genErrorMsg) {
      resumeDownloadsEl.append(
        el("div", { class: "banner err", style: "margin:6px 0" },
          `Generation failed: ${genErrorMsg} — click Generate résumé to retry.`)
      );
    }
    if (!gen?.artifacts?.length) {
      resumeDownloadsEl.append(el("div", { class: "muted" }, "Not generated yet — click Generate résumé."));
      return;
    }
    if (gen.tailoredMode) resumeDownloadsEl.append(tailoredModeBadge(gen.tailoredMode));
    const row = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px" });
    for (const fmt of ["docx", "pdf", "txt", "cover_letter"]) {
      if (gen.artifacts.some((a) => a.format === fmt)) {
        const label = fmt === "cover_letter" ? "Cover letter" : fmt.toUpperCase();
        row.append(
          el("a", {
            class: "ghost",
            href: api.resumeFileUrl(id, fmt),
            download: "",
            style: "padding:6px 10px;border:1px solid var(--border);border-radius:6px;text-decoration:none",
          }, `⬇ ${label}`)
        );
      }
    }
    row.append(
      el("button", {
        class: "ghost",
        onclick: async () => {
          try {
            const r = await api.openResumeFolder(id);
            toast(r.dir ? `Opened ${r.dir}` : "Opened folder");
          } catch (e) {
            toast((e as Error).message, true);
          }
        },
      }, "📂 Open folder")
    );
    resumeDownloadsEl.append(row);
    if (gen.dir) resumeDownloadsEl.append(el("div", { class: "muted", style: "margin-top:6px;font-size:12px" }, gen.dir));
  }
  const markApplied = async () => {
    try { const updated = await api.apply(id, {}); toast("Marked applied"); finishFromModal(updated); }
    catch (err) { toast((err as Error).message, true); }
  };
  const skip = async () => {
    try { const updated = await api.patchJob(id, { state: "skipped" }); finishFromModal(updated); }
    catch (err) { toast((err as Error).message, true); }
  };

  modal.append(
    el("button", { class: "ghost close", onclick: close }, "✕"),
    batch
      ? el("div", { class: "muted", style: "font-size:12px;margin-bottom:4px" },
          `📮 Batch apply — job ${batch.index + 1} of ${batch.ids.length}`)
      : "",
    el("h2", {}, j.title),
    jobPostingHref(j.url)
      ? el(
          "a",
          {
            href: jobPostingHref(j.url)!,
            target: "_blank",
            rel: "noopener noreferrer",
            style: "font-size:13px;display:block;margin-bottom:8px",
          },
          "Open job posting ↗"
        )
      : "",
    el("div", { class: "meta" },
      el("span", {}, j.company ?? "—"),
      j.location && el("span", {}, j.location),
      el("span", {}, j.source),
      el("span", { class: `tag state-${j.state}` }, j.state),
      j.applied_at && el("span", {}, `applied ${timeAgo(j.applied_at)}`)
    ),
  );

  if (!pkg.masterResumePresent) {
    modal.append(el("div", { class: "banner warn" }, "No master resume set — add one in the Profile tab to enable tailored drafts. The application can still proceed."));
  }
  // Phone: the apply steps and the copy chips come FIRST — on a 6" screen the
  // JD and the coverage report are reference material, not the decision.
  if (isPhone()) {
    const slot = el("div", {});
    modal.append(slot);
    void phoneApplyBlock(pkg).then((block) => slot.replaceWith(block));
  }
  modal.append(
    el(
      "div",
      { class: "section-block" },
      el("h4", {}, `Job description (${pkg.descriptionSource === "apply_capture" ? "captured from page" : "from listing"})`),
      el("div", { class: "muted", style: "max-height:280px;overflow:auto;white-space:pre-wrap;font-size:12px" }, pkg.description || ""),
    )
  );

  // Per-JD-requirement coverage — the pre-apply gut check. Which JD asks does
  // this résumé explicitly cover, which are gaps, which can't be truthfully claimed?
  const reqCoverageBlock = (() => {
    const rc = pkg.requirementsCoverage;
    if (!rc?.length) {
      return pkg.tailored
        ? el("div", { class: "section-block" },
            el("h4", {}, "JD requirements vs your résumé"),
            el("div", { class: "muted", style: "font-size:12px" },
              "No requirement report for this résumé yet — Re-generate to get one."))
        : null;
    }
    const dot = (status: string) => {
      if (status === "soft") {
        return el(
          "span",
          {
            class: "kw",
            style: "background:rgba(139,148,158,.12);color:var(--muted)",
            title: "Soft skill — a résumé can't keyword-prove this; the cover letter and interview address it",
          },
          "✍ cover letter"
        );
      }
      return el("span", { class: `kw ${status === "covered" ? "present" : status === "gap" ? "partial" : "missing"}` },
        status === "covered" ? "✓ covered" : status === "gap" ? "◐ gap" : "✕ can't claim");
    };
    const musts = rc.filter((r) => r.kind === "must");
    const nice = rc.filter((r) => r.kind === "nice");
    const row = (r: NonNullable<typeof rc>[number]) =>
      el("div", { style: "display:flex;gap:8px;align-items:baseline;padding:3px 0" },
        dot(r.status),
        el("span", {}, r.requirement),
        r.bulletIds.length > 0 &&
          el("span", { class: "muted", style: "font-size:11px" }, `via ${r.bulletIds.join(", ")}`));
    return el("div", { class: "section-block" },
      el("h4", {}, "JD requirements vs your résumé"),
      musts.length > 0 && el("div", {}, el("div", { class: "muted", style: "margin-bottom:2px" }, "Must-have:"), ...musts.map(row)),
      nice.length > 0 && el("div", { style: "margin-top:6px" }, el("div", { class: "muted", style: "margin-bottom:2px" }, "Nice-to-have:"), ...nice.map(row)),
      rc.some((r) => r.status === "unprovable") &&
        el("div", { class: "muted", style: "margin-top:6px;font-size:12px" },
          "“Can't claim” = the JD asks for it but your profile can't prove it — it is intentionally NOT on the résumé."),
      rc.some((r) => r.status === "soft") &&
        el("div", { class: "muted", style: "margin-top:2px;font-size:12px" },
          "“Cover letter” = a soft skill résumés can't keyword-prove — the cover letter and interview carry it."));
  })();

  if (pkg.tailored) {
    const t = pkg.tailored;
    const cov = el(
      "div",
      { class: "section-block" },
      el("h4", {}, "Keyword coverage (report only — never auto-injected)"),
      el("div", {}, ...t.keyword_coverage.present.slice(0, 30).map((k) => el("span", { class: "kw present" }, k))),
      t.keyword_coverage.missing.length > 0 &&
        el("div", { style: "margin-top:6px" },
          el("div", { class: "muted", style: "margin-bottom:4px" }, "Missing from your resume (decide if truthful to add):"),
          ...t.keyword_coverage.missing.slice(0, 30).map((k) => el("span", { class: "kw missing" }, k))
        )
    );
    modal.append(
      el("div", { class: "section-block" },
        el("h4", {}, "Changes summary"),
        tailoredModeBadge(t.tailoredMode),
        el("div", { class: "muted" }, t.changes_summary)),
      cov,
      reqCoverageBlock ?? "",
      el("div", { class: "section-block" }, el("h4", {}, "Parser-safe resume draft (from your master resume — not the JD)"),
        pkg.renderError ? el("div", { class: "banner err" }, `Render lint failed: ${pkg.renderError}`) : el("pre", { class: "render" }, pkg.renderedResume ?? ""),
        pkg.renderedResume && el("button", { class: "ghost", onclick: () => downloadText(`${j.company ?? "resume"}-${j.title}.txt`, pkg.renderedResume!) }, "⬇ Download .txt")
      ),
      el("div", { class: "section-block" }, el("h4", {}, "Cover letter draft"), el("textarea", { rows: "6" }, t.cover_letter))
    );
  }

  modal.append(
    el(
      "div",
      { style: "display:flex;gap:8px;margin-top:8px;flex-wrap:wrap" },
      pkg.masterResumePresent && genBtn,
    ),
    resumeDownloadsEl
  );

  try {
    const st = await api.resumeStatus(id);
    seenManifestAt = manifestAt(st);
    if (st.status === "queued" || st.status === "running") {
      // The background pipeline is already working on this job — show it live.
      genPhase = st.status;
      genStartedAt = st.startedAt ?? st.queuedAt ?? Date.now();
      showGenInProgress(st.status);
    } else {
      if (st.status === "failed") genErrorMsg = st.error ?? "generation failed";
      if (st.artifacts.length) {
        renderResumeDownloads({
          jobId: id,
          dir: st.dir,
          artifacts: st.artifacts,
          keywordCoverage: null,
          changesSummary: null,
          renderError: null,
          renderedResume: null,
        });
      } else {
        renderResumeDownloads();
      }
    }
  } catch {
    renderResumeDownloads();
  }

  // Prefill-ahead: the desktop fills, the phone answers the rest. Only meaningful
  // for engine hosts; the section explains itself elsewhere.
  if (PREFILL_HOST_RE.test(j.url) || j.prefill) {
    modal.append(prefillSection(id, j, () => document.body.contains(bg)));
  }

  modal.append(
    el(
      "div",
      { class: "modal-actions", style: "display:flex;gap:8px;margin-top:16px;flex-wrap:wrap" },
      el("button", { class: "primary", onclick: doApply },
        isPhone() && ASSIST_HOST_RE.test(jobPostingHref(j.url) ?? "")
          ? "Open the form ▸"
            : /greenhouse\.io\/|jobs\.ashbyhq\.com|jobs\.lever\.co/i.test(j.url)
            ? "Approve → Apply assist ▸"
            : /linkedin\.com\/jobs/i.test(j.url)
              ? "Approve → Easy Apply assist ▸"
              : "Open application ▸"),
      el("button", { class: "ghost", onclick: markApplied }, "Mark applied"),
      el("button", { class: "ghost", onclick: skip }, "Skip"),
      // Batch-only: move on without changing this job's state (stays in the queue).
      batch && el("button", { class: "ghost", onclick: () => { close(); nextInBatch(); } }, "Later ▸")
    )
  );

  // 1s tick: live elapsed labels; every 3rd tick polls the per-job status. State
  // lives in this closure, so a global dataVersion re-render (which rebuilds #app
  // but never touches this body-mounted modal) can't lose or duplicate it.
  let genTick = 0;
  genTimer = window.setInterval(() => {
    if (!document.body.contains(bg)) {
      window.clearInterval(genTimer);
      return;
    }
    if (genPhase === "inflight" || genPhase === "running") {
      genBtn.textContent = genElapsedLabel();
      const elapsedEl = resumeDownloadsEl.querySelector(".gen-progress-elapsed");
      if (elapsedEl) elapsedEl.textContent = formatDuration(Date.now() - genStartedAt);
    }
    if (++genTick % 3 !== 0 || genPhase === "inflight") return;
    void (async () => {
      let st: import("./api.js").JobResumeStatus;
      try {
        st = await api.resumeStatus(id);
      } catch {
        return; // transient fetch failure — try again next tick
      }
      // Re-check after the await: a Generate click may have started an in-flight
      // request meanwhile (TS narrowing can't see that cross-closure mutation).
      if (!document.body.contains(bg) || (genPhase as GenPhase) === "inflight") return;
      if (st.status === "queued") {
        if (genPhase !== "queued") {
          genPhase = "queued";
          genStartedAt = st.queuedAt ?? Date.now();
          showGenInProgress("queued");
        }
      } else if (st.status === "running") {
        if (genPhase !== "running") {
          genPhase = "running";
          genStartedAt = st.startedAt ?? Date.now();
          showGenInProgress("running");
        }
      } else if (st.status === "failed") {
        if (genPhase !== "idle") {
          genPhase = "idle";
          genErrorMsg = st.error ?? "generation failed";
          resetGenUi();
          await refreshDownloadsFromStatus();
          toast(`Résumé generation failed: ${genErrorMsg}`, true);
        }
      } else if (st.status === "done" && manifestAt(st) > seenManifestAt) {
        // A new completed run landed (pipeline worker, another tab, or a dropped
        // connection whose server side finished) — refresh the files in place.
        genPhase = "idle";
        genErrorMsg = null;
        resetGenUi();
        await refreshDownloadsFromStatus();
        toast("Résumé ready — download links updated below");
      }
    })();
  }, 1000);
}

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: "text/plain" });
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  a.click();
}

// ---- referrals -------------------------------------------------------------
async function referralsView(): Promise<HTMLElement> {
  const refs = await api.referrals();
  const wrap = el("div", { class: "stack" });
  wrap.append(pageHead("Referrals", "Leads from community forum posts — the contact is the value."),
    el("div", { class: "banner warn" }, "Captured via the extension. The ATS poll path never produces these."));
  if (refs.length === 0) wrap.append(el("div", { class: "empty" }, "No referral leads yet. Paste a forum post or message under Captures."));
  for (const r of refs) {
    // State change updates just this card's tag in place — no full re-render.
    const set = async (s: string) => {
      try {
        const updated = await api.patchReferral(r.id, { state: s });
        const tag = card.querySelector(".tag");
        if (tag) {
          tag.className = `tag state-${updated.state}`;
          tag.textContent = updated.state;
        }
      } catch (e) {
        toast((e as Error).message, true);
      }
    };
    const card: HTMLElement = el("div", { class: "card" },
        el("div", { class: "split-row" },
          el("div", {},
            el("h3", { style: "margin:0 0 4px" }, r.company ?? "(unknown company)", el("span", { class: `tag state-${r.state}`, style: "margin-left:8px" }, r.state)),
            el("div", { class: "meta" },
              r.roles && el("span", {}, r.roles),
              r.referrer && el("span", {}, `referrer: ${r.referrer}`),
              r.contact && el("span", {}, r.contact),
              r.deadline && el("span", {}, `due ${r.deadline}`),
              el("a", { href: r.thread_url, target: "_blank" }, "thread ↗")
            )
          ),
          el("div", { class: "row-actions" },
            el("button", { class: "ghost", onclick: () => set("contacted") }, "Contacted"),
            el("button", { class: "ghost", onclick: () => set("applied") }, "Applied"),
            el("button", { class: "ghost", onclick: () => set("skipped") }, "Skip")
          )
        )
    );
    wrap.append(card);
  }
  return wrap;
}

// ---- companies + poll observability --------------------------------------
/** 15 colored dots, oldest → newest: poll run health at a glance. */
function pollTrendStrip(runs: import("./api.js").PollRunRow[]): HTMLElement {
  const dot = (r: import("./api.js").PollRunRow) => {
    let cls = "trend-ok";
    let label = r.status;
    if (r.status === "running") {
      cls = "trend-running";
    } else if (r.status === "success") {
      cls = "trend-ok";
    } else if (r.status === "partial") {
      cls = "trend-warn";
    } else {
      cls = "trend-err";
    }
    let errCount = 0;
    try {
      if (r.errors_json) errCount = Object.keys(JSON.parse(r.errors_json)).length;
    } catch { /* ignore */ }
    return el("span", {
      class: `trend-dot ${cls}`,
      title: `${timeAgo(r.started_at)} · ${label}${errCount ? ` · ${errCount} error(s)` : ""}`,
    });
  };
  return el(
    "div",
    { class: "trend-strip", title: "Last poll runs, oldest → newest" },
    ...runs.slice().reverse().map(dot)
  );
}

/** Full-width expandable row listing each board's error message from errors_json. */
function pollRunErrorsRow(run: import("./api.js").PollRunRow, colspan: number): HTMLTableRowElement {
  let errs: Record<string, string> = {};
  try {
    errs = run.errors_json ? (JSON.parse(run.errors_json) as Record<string, string>) : {};
  } catch { /* ignore */ }
  const cell = el("td", { colspan: String(colspan) });
  for (const [board, msg] of Object.entries(errs)) {
    cell.append(
      el("div", { style: "padding:2px 0" },
        el("b", {}, board === "aborted" ? "⛔ aborted" : board), ": ", msg)
    );
  }
  const tr = el("tr", { class: "run-errors" }, cell);
  return tr as HTMLTableRowElement;
}

async function companiesView(): Promise<HTMLElement> {
  let scoringPending = 0;
  let scoringRunning = false;
  const [companies, healthRows, pollRuns, health] = await Promise.all([
    api.companies(),
    api.companiesHealth(),
    api.pollRuns(15),
    fetchHealth(),
  ]);
  if (health) {
    scoringPending = health.scoring?.freshInRegion ?? 0;
    scoringRunning = health.scoring?.running ?? false;
    state.scoringRunning = scoringRunning;
  }
  const healthById = new Map(healthRows.map((h) => [h.id, h]));
  const wrap = el("div", { class: "stack" });
  wrap.append(pageHead("Companies", "ATS boards the scheduler polls. Each run ingests jobs posted in the last 24h, scores in-region matches, then notifies."));

  // Poll pipeline summary
  const last = pollRuns[0];
  const lastAborted =
    last?.errors_json && last.status !== "running" && (() => {
      try {
        return !!(JSON.parse(last.errors_json) as { aborted?: string }).aborted;
      } catch {
        return false;
      }
    })();
  const running = state.pollRunning || last?.status === "running";
  wrap.append(
    el("div", { class: "card" },
      el("div", { class: "split-row" },
        el("h4", { class: "section-title" }, "Poll pipeline"),
        pollRuns.length > 0 ? pollTrendStrip(pollRuns) : null),
      el("div", { class: "muted", style: "margin-bottom:10px;font-size:12px" },
        "Each poll fetches ATS boards, ingests only jobs posted in the last 24h (by ATS post date), scores new in-region jobs via LLM, then notifies on matches. Discovery (JSearch/Adzuna) is separate. Scheduler runs hourly (Mon–Sat); if a poll is still running at the next hour, that tick is skipped."
      ),
      last
        ? el("div", { class: "stat-row" },
            el("span", {}, "Last run: ", el("b", {}, timeAgo(last.started_at)), running ? " (running…)" : ""),
            last.duration_ms != null && el("span", {}, "Duration: ", el("b", {}, `${(last.duration_ms / 1000).toFixed(1)}s`)),
            el("span", {}, "Boards: ", el("b", {}, String(last.companies_polled ?? 0))),
            el("span", {}, "Fresh ingested: ", el("b", {}, String(last.jobs_seen ?? 0))),
            el("span", {}, "New: ", el("b", {}, String(last.jobs_new ?? 0))),
            el("span", {}, "Scored: ", el("b", {}, String(last.jobs_scored ?? 0))),
            el("span", {}, "Notified: ", el("b", {}, String(last.notifications_sent ?? 0))),
            el("span", { class: `tag state-${running ? "notified" : lastAborted ? "skipped" : last.status === "success" ? "relevant" : "skipped"}` },
              running ? "RUNNING" : lastAborted ? "ABORTED" : last.status.toUpperCase())
          )
        : el("div", { class: "muted" }, "No poll runs yet — click Poll now in the header."),
      el("div", {
        style: "display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap",
      },
        el("span", { class: "muted", style: "font-size:13px" },
          scoringPending > 0
            ? `${scoringPending} fresh US/Canada job(s) waiting for LLM scores (hidden from queue until scored).`
            : "All fresh in-region jobs are scored."
        ),
        el(
          "button",
          {
            class: "ghost",
            disabled: scoringRunning || state.pollRunning || scoringPending === 0,
            onclick: scorePending,
          },
          scoringRunning ? "Scoring…" : `Score pending (${scoringPending})`
        )
      ),
      pollRuns.length > 0
        ? el("table", { style: "font-size:12px" },
            el("thead", {},
              el("tr", {},
                el("th", {}, "When"),
                el("th", {}, "Trigger"),
                el("th", {}, "Status"),
                el("th", {}, "Duration"),
                el("th", {}, "Boards"),
                el("th", {}, "Fresh"),
                el("th", {}, "New"),
                el("th", {}, "Scored"),
                el("th", {}, "Slack"),
                el("th", {}, "Errors")
              )
            ),
            el("tbody", {},
              ...pollRuns.flatMap((r) => {
                let errCount = 0;
                let aborted = false;
                try {
                  if (r.errors_json) {
                    const errs = JSON.parse(r.errors_json) as Record<string, string>;
                    if (errs.aborted) aborted = true;
                    errCount = Object.keys(errs).length;
                  }
                } catch { /* ignore */ }
                const statusLabel =
                  r.status === "running"
                    ? "running"
                    : aborted
                      ? "aborted"
                      : r.status;
                // ⚠ N is a toggle: clicking inserts/removes a full-width row with
                // the actual per-board error messages (already in errors_json).
                let detailRow: HTMLTableRowElement | null = null;
                const errCell = errCount
                  ? el("button", {
                      class: "ghost err-toggle",
                      title: "Show per-board error details",
                      onclick: (e: Event) => {
                        e.stopPropagation();
                        if (detailRow?.isConnected) {
                          detailRow.remove();
                          return;
                        }
                        detailRow = pollRunErrorsRow(r, 10);
                        row.after(detailRow);
                      },
                    }, `⚠ ${errCount} ▸`)
                  : "—";
                const row = el("tr", {},
                  el("td", {}, timeAgo(r.started_at)),
                  el("td", {}, r.trigger),
                  el("td", {}, statusLabel),
                  el("td", {}, r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(0)}s` : "—"),
                  el("td", {}, String(r.companies_polled ?? 0)),
                  el("td", {}, String(r.jobs_seen ?? 0)),
                  el("td", {}, String(r.jobs_new ?? 0)),
                  el("td", {}, String(r.jobs_scored ?? 0)),
                  el("td", {}, String(r.notifications_sent ?? 0)),
                  el("td", {}, errCell)
                );
                return [row];
              })
            )
          )
        : null
    )
  );

  const nameI = el("input", { placeholder: "Company name" }) as HTMLInputElement;
  const atsS = el("select", {}, ...["greenhouse", "lever", "ashby", "workday", "oracle"].map((a) => el("option", { value: a }, a))) as HTMLSelectElement;
  const tokenI = el("input", { placeholder: "board token / slug (workday: host|tenant|site · oracle: host|siteNumber)" }) as HTMLInputElement;
  const add = async () => {
    if (!nameI.value || !tokenI.value) return toast("Name and token required", true);
    try { await api.addCompany({ name: nameI.value, ats: atsS.value, boardToken: tokenI.value }); toast("Company added"); render(); }
    catch (err) { toast((err as Error).message, true); }
  };
  wrap.append(
    el("div", { class: "card" },
      el("h4", { style: "margin-top:0;color:var(--muted)" }, "Add ATS company to poll"),
      el("div", { class: "toolbar" }, nameI, atsS, tokenI, el("button", { class: "primary", onclick: add }, "+ Add"))
    )
  );
  if (companies.length === 0) wrap.append(el("div", { class: "empty" }, "No companies yet. Add a Greenhouse/Lever/Ashby company above."));
  else {
    const rows = companies.flatMap((c) => {
      const h = healthById.get(c.id);
      const failing = (h?.consecutive_failures ?? 0) > 0;
      const pollLabel = h?.last_polled_at
        ? `${h.last_poll_status ?? "?"} · ${h.last_job_count ?? 0} fresh · ${timeAgo(h.last_polled_at)}`
        : "not polled yet";
      // Expandable error line: click the fail badge to see the actual message.
      let errRow: HTMLTableRowElement | null = null;
      const failBadge = failing
        ? el("button", {
            class: "ghost err-toggle",
            title: h?.last_error ?? "",
            onclick: (e: Event) => {
              e.stopPropagation();
              if (errRow?.isConnected) {
                errRow.remove();
                return;
              }
              errRow = el("tr", { class: "run-errors" },
                el("td", { colspan: "6" }, el("b", {}, c.name), ": ", h?.last_error ?? "(no message)")
              ) as HTMLTableRowElement;
              row.after(errRow);
            },
          }, `✕ ${h!.consecutive_failures} fail${h!.consecutive_failures > 1 ? "s" : ""} ▸`)
        : null;
      const autoDisabled = h?.auto_disabled_at
        ? el("span", {
            class: "tag state-skipped",
            title: `${h.auto_disabled_reason ?? "permanent error"} · ${timeAgo(h.auto_disabled_at)} — Enable to retry`,
          }, "AUTO-DISABLED")
        : null;
      const row = el("tr", {},
        el("td", {}, c.name, " ", autoDisabled),
        el("td", {}, c.ats),
        el("td", { class: "muted", style: "max-width:180px;overflow:hidden;text-overflow:ellipsis" }, c.board_token),
        el("td", {}, el("span", { class: `tag ${c.enabled ? "state-applied" : ""}` }, c.enabled ? "On" : "Off")),
        el("td", { class: failing ? "err" : "muted", style: "font-size:12px" }, pollLabel, " ", failBadge),
        el("td", {}, el("button", { class: "ghost", onclick: async () => { await api.toggleCompany(c.id, !c.enabled); render(); } }, c.enabled ? "Disable" : h?.auto_disabled_at ? "Re-enable" : "Enable"))
      );
      return [row];
    });
    wrap.append(el("div", { class: "card" },
      el("h4", { style: "margin-top:0" }, "ATS watchlist"),
      el("table", {},
        el("thead", {}, el("tr", {},
          el("th", {}, "Name"),
          el("th", {}, "ATS"),
          el("th", {}, "Token"),
          el("th", {}, "On"),
          el("th", {}, "Last poll"),
          el("th", {}, "")
        )),
        el("tbody", {}, ...rows)
      )
    ));
  }
  return wrap;
}

// ---- keywords --------------------------------------------------------------
async function keywordsView(): Promise<HTMLElement> {
  const kws = await api.keywords();
  const wrap = el("div", { class: "stack" });
  wrap.append(
    pageHead("Keywords", "Suggestions never auto-search — open Indeed when you want to use one."),
    el("div", { class: "toolbar" },
      el("button", { class: "primary", onclick: async () => { toast("Generating suggestions…"); try { await api.recommendKeywords(); render(); } catch (e) { toast((e as Error).message, true); } } }, "Suggest next keywords")
    )
  );
  const pending = kws.filter((k) => k.status === "suggested");
  if (pending.length === 0) wrap.append(el("div", { class: "empty" }, "No pending suggestions. Click suggest above."));
  for (const k of pending) {
    // Resolve actions remove just this card — no full re-render.
    const card: HTMLElement = el("div", { class: "card" },
      el("div", { class: "split-row" },
        el("div", {}, el("h3", { style: "margin:0 0 2px" }, k.term), k.rationale && el("div", { class: "reason" }, k.rationale)),
        el("div", { class: "row-actions" },
          el("a", { class: "", href: `https://www.indeed.com/jobs?q=${encodeURIComponent(k.term)}`, target: "_blank" }, el("button", { class: "primary" }, "Search ↗")),
          el("button", { class: "ghost", onclick: async () => { try { await api.patchKeyword(k.id, "used"); card.remove(); } catch (e) { toast((e as Error).message, true); } } }, "Mark used"),
          el("button", { class: "ghost", onclick: async () => { try { await api.patchKeyword(k.id, "dismissed"); card.remove(); } catch (e) { toast((e as Error).message, true); } } }, "Dismiss")
        )
      )
    );
    wrap.append(card);
  }
  return wrap;
}

// ---- profile ---------------------------------------------------------------
async function profileView(): Promise<HTMLElement> {
  const p = await api.profile();
  const resume = el("textarea", { rows: "12", placeholder: "Paste your master resume (source of truth — never auto-edited)." }, p.masterResume ?? "") as HTMLTextAreaElement;
  const titles = el("input", { value: (p.preferences.titles ?? []).join(", "), placeholder: "Backend Software Engineer, Senior Software Engineer" }) as HTMLInputElement;
  const locations = el("input", { value: (p.preferences.locations ?? []).join(", "), placeholder: "New York, Remote - US, Toronto" }) as HTMLInputElement;
  const keywords = el("input", { value: (p.preferences.keywords ?? []).join(", "), placeholder: "backend, node, typescript" }) as HTMLInputElement;
  const seniority = el("input", { value: p.preferences.seniority ?? "", placeholder: "senior" }) as HTMLInputElement;
  const dealbreakers = el("input", {
    value: ((p.preferences.dealbreakers as string[] | undefined) ?? []).join(", "),
    placeholder: "contract, staffing, c2c",
  }) as HTMLInputElement;
  const targetCompanies = el("input", {
    value: ((p.preferences.targetCompanies as string[] | undefined) ?? []).join(", "),
    placeholder: "Stripe, Datadog, Cloudflare",
  }) as HTMLInputElement;
  const regions = (p.preferences.allowedRegions as string[] | undefined) ?? ["US", "CA"];
  const usOnly = el("input", { type: "checkbox", checked: regions.includes("US") }) as HTMLInputElement;
  const caOnly = el("input", { type: "checkbox", checked: regions.includes("CA") }) as HTMLInputElement;
  const sl = (p.preferences.searchLinks ?? {}) as Record<string, string>;
  const linkedinUrl = el("input", {
    value: sl.linkedin ?? "",
    placeholder: "Your LinkedIn jobs search URL (with filters)",
    style: "width:100%",
  }) as HTMLInputElement;
  const indeedUrl = el("input", {
    value: sl.indeed ?? "",
    placeholder: "Your Indeed search URL",
    style: "width:100%",
  }) as HTMLInputElement;

  const save = async () => {
    const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
    const allowedRegions: string[] = [];
    if (usOnly.checked) allowedRegions.push("US");
    if (caOnly.checked) allowedRegions.push("CA");
    try {
      await api.saveProfile({
        masterResume: resume.value,
        preferences: {
          titles: split(titles.value),
          locations: split(locations.value),
          keywords: split(keywords.value),
          seniority: seniority.value,
          dealbreakers: split(dealbreakers.value),
          targetCompanies: split(targetCompanies.value),
          allowedRegions: allowedRegions.length ? allowedRegions : ["US", "CA"],
          searchLinks: {
            linkedin: linkedinUrl.value.trim() || undefined,
            indeed: indeedUrl.value.trim() || undefined,
          },
        },
      });
      toast("Profile saved");
      render();
    } catch (err) { toast((err as Error).message, true); }
  };

  // ---- answer bank (screening answers) ----------------------------------
  // Written by the extension (submit snapshots, Ask AI, panel edits); this is
  // the audit/edit surface so auto-banked answers never go stale unseen.
  const bank: Record<string, string> = { ...((p as { screeningAnswers?: Record<string, string> }).screeningAnswers ?? {}) };
  const bankList = el("div", {});
  const renderBank = () => {
    bankList.innerHTML = "";
    const entries = Object.entries(bank);
    if (!entries.length) {
      bankList.append(el("div", { class: "muted" }, "Empty — answers bank themselves when you submit applications with the assist, or from the Copilot panel."));
      return;
    }
    for (const [q, a] of entries) {
      const ta = el("textarea", { rows: "2", style: "width:100%" }, a) as HTMLTextAreaElement;
      ta.addEventListener("input", () => { bank[q] = ta.value; });
      bankList.append(
        el("div", { style: "margin-bottom:10px" },
          el("div", { style: "display:flex;justify-content:space-between;gap:8px;align-items:baseline" },
            el("div", { style: "font-weight:600" }, q),
            el("button", { class: "ghost", onclick: () => { delete bank[q]; renderBank(); } }, "✕")
          ),
          ta
        )
      );
    }
  };
  renderBank();
  const saveBank = async () => {
    try {
      const cleaned = Object.fromEntries(Object.entries(bank).filter(([, v]) => v.trim()));
      await api.saveProfile({ screeningAnswers: cleaned });
      toast("Answer bank saved");
    } catch (err) { toast((err as Error).message, true); }
  };

  const f = (label: string, node: Node) => el("label", { class: "field" }, el("span", {}, label), node);
  return el("div", { class: "stack" },
    pageHead("Profile", "Master résumé and preferences that drive scoring. Never auto-edited."),
    el("div", { class: "grid2" },
    el("div", { class: "card" },
      el("h4", { class: "section-title" }, "Master resume"), f("", resume),
      el("h4", { class: "section-title", style: "margin-top:16px" }, "Answer bank"),
      el("div", { class: "muted", style: "margin-bottom:8px" }, "Your own words, reused verbatim on matching questions. EEO/demographic questions are never banked."),
      bankList,
      el("button", { class: "primary", onclick: saveBank, style: "margin-top:6px" }, "Save answer bank")
    ),
    el("div", { class: "card" },
      el("h4", { class: "section-title" }, "Preferences"),
      el("div", { class: "banner warn" }, "Jobs outside your allowed countries are hidden from the queue and won't trigger Slack alerts."),
      el("label", { class: "field" },
        el("span", {}, "Allowed countries"),
        el("div", { class: "check-row" },
          el("label", {}, usOnly, " United States"),
          el("label", {}, caOnly, " Canada"))),
      f("Target titles", titles), f("Preferred cities (within US/Canada)", locations), f("Keywords", keywords), f("Seniority", seniority),
      f("Dealbreakers (hard knockout — job scores 0 if any term appears)", dealbreakers),
      f("Target companies (notify at a lower match bar)", targetCompanies),
      el("h4", { class: "section-title", style: "margin-top:16px" }, "Morning Slack links"),
      f("LinkedIn search URL", linkedinUrl), f("Indeed search URL", indeedUrl),
      el("button", { class: "primary", onclick: save, style: "margin-top:10px" }, "Save profile")
    )
  ));
}

render();
// One shared status poller (5s while poll/scoring/pipeline runs, 15s idle) drives
// the alert banner, statusbar patches, and the single post-work full refresh.
startStatusPoller();
