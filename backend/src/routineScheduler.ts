import cron, { type ScheduledTask } from "node-cron";
import type { DB } from "./db/client.js";
import { config } from "./config.js";
import { sendRoutineDigest, type RoutineDigestKind } from "./routineDigest.js";
import { checkScanWatchStale } from "./scanWatch.js";
import { listUsers, OWNER_USER_ID } from "./users.js";

let morningTask: ScheduledTask | null = null;
let eveningTask: ScheduledTask | null = null;
let watchNudgeTask: ScheduledTask | null = null;

async function forEachUser(db: DB, fn: (userId: number) => Promise<unknown>): Promise<void> {
  let ids: number[];
  try {
    ids = (await listUsers(db)).map((u) => u.id);
  } catch {
    ids = [OWNER_USER_ID];
  }
  if (!ids.length) ids = [OWNER_USER_ID];
  for (const id of ids) await fn(id);
}

function digestForAllUsers(db: DB, kind: RoutineDigestKind): void {
  forEachUser(db, (userId) =>
    sendRoutineDigest(db, userId, kind).catch((err) =>
      console.error(`[routine] ${kind} digest failed (user ${userId}):`, err)
    )
  ).catch((err) => console.error(`[routine] ${kind} digest loop failed:`, err));
}

/** Morning + evening Slack reminders (LinkedIn, Indeed, manual career sites). */
export function startRoutineScheduler(db: DB): void {
  if (!config.routine.enabled) {
    console.log("[routine] disabled (ROUTINE_ENABLED=0)");
    return;
  }

  const tz = config.scheduler.tz;

  if (cron.validate(config.routine.morningCron)) {
    morningTask = cron.schedule(
      config.routine.morningCron,
      () => digestForAllUsers(db, "morning"),
      { timezone: tz }
    );
    console.log(`[routine] morning digest — cron '${config.routine.morningCron}' TZ '${tz}'`);
  } else {
    console.warn(`[routine] invalid ROUTINE_CRON '${config.routine.morningCron}'`);
  }

  if (cron.validate(config.routine.eveningCron)) {
    eveningTask = cron.schedule(
      config.routine.eveningCron,
      () => digestForAllUsers(db, "evening"),
      { timezone: tz }
    );
    console.log(`[routine] evening digest — cron '${config.routine.eveningCron}' TZ '${tz}'`);
  } else {
    console.warn(`[routine] invalid ROUTINE_EVENING_CRON '${config.routine.eveningCron}'`);
  }

  // Hourly guard for the browser-driven LinkedIn watch: if the extension has been
  // reporting scans recently but went silent for >8h during waking hours, Slack one
  // warning per stall (Chrome closed / PC asleep / auto-scan disabled).
  watchNudgeTask = cron.schedule(
    "10 * * * *",
    () => {
      forEachUser(db, (userId) =>
        checkScanWatchStale(db, userId).catch((err) =>
          console.error(`[routine] scan watch stale check failed (user ${userId}):`, err)
        )
      ).catch((err) => console.error("[routine] scan watch nudge loop failed:", err));
    },
    { timezone: tz }
  );
}

export function stopRoutineScheduler(): void {
  morningTask?.stop();
  eveningTask?.stop();
  watchNudgeTask?.stop();
  morningTask = null;
  eveningTask = null;
  watchNudgeTask = null;
}

export { sendRoutineDigest, sendMorningDigest } from "./routineDigest.js";
