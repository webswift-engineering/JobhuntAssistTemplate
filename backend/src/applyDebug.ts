// Apply-assist debug log — the "instrument before theorizing" mechanism.
// The extension (engine + background worker) reports every stream step here:
// record results, advance requests/responses, tab navigations, failures, and
// the engine's stuck-watchdog — with an optional screenshot on failure events.
// Everything lands in flat files so a stuck run can be diagnosed after the
// fact without reproducing it under a debugger:
//   logs/apply-debug.jsonl        one JSON event per line
//   logs/apply-shots/<ts>-<event>.jpg
import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "apply-debug.jsonl");
const SHOT_DIR = path.join(LOG_DIR, "apply-shots");
const MAX_EVENTS_READ = 200;

export interface ApplyDebugEvent {
  event: string;
  jobId?: string;
  streamId?: string;
  data?: unknown;
  /** JPEG screenshot (no data: prefix) — saved to apply-shots/, path logged. */
  screenshotBase64?: string;
}

export function appendApplyDebug(e: ApplyDebugEvent): { screenshotPath: string | null } {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  let screenshotPath: string | null = null;
  if (e.screenshotBase64) {
    try {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${e.event.replace(/[^a-z0-9-]/gi, "_")}.jpg`;
      screenshotPath = path.join(SHOT_DIR, name);
      fs.writeFileSync(screenshotPath, Buffer.from(e.screenshotBase64, "base64"));
    } catch {
      screenshotPath = null;
    }
  }
  const line = JSON.stringify({
    at: new Date().toISOString(),
    event: e.event,
    jobId: e.jobId ?? null,
    streamId: e.streamId ?? null,
    data: e.data ?? null,
    screenshot: screenshotPath,
  });
  fs.appendFileSync(LOG_FILE, line + "\n");
  return { screenshotPath };
}

/** Last `limit` events, newest last — the quick circle-back read. */
export function readApplyDebug(limit = 50): unknown[] {
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n");
    return lines.slice(-Math.min(limit, MAX_EVENTS_READ)).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
  } catch {
    return [];
  }
}
