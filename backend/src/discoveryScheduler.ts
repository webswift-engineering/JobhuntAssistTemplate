import cron, { type ScheduledTask } from "node-cron";
import type { DB } from "./db/client.js";
import { config } from "./config.js";
import { runDiscovery } from "./discovery.js";

let task: ScheduledTask | null = null;

/** Daily JSearch + Adzuna discovery (market search beyond ATS slug list). */
export function startDiscoveryScheduler(db: DB): void {
  if (!config.discovery.enabled) {
    console.log("[discovery] disabled (DISCOVERY_ENABLED=0); use POST /admin/discovery-now");
    return;
  }
  if (!cron.validate(config.discovery.cron)) {
    console.warn(`[discovery] invalid DISCOVERY_CRON '${config.discovery.cron}'`);
    return;
  }
  task = cron.schedule(
    config.discovery.cron,
    () => {
      runDiscovery(db, "schedule").catch((err) =>
        console.error("[discovery] run failed:", err)
      );
    },
    { timezone: config.scheduler.tz }
  );
  console.log(
    `[discovery] daily sweep — cron '${config.discovery.cron}' TZ '${config.scheduler.tz}' query '${config.discovery.query}'`
  );
}

export function stopDiscoveryScheduler(): void {
  task?.stop();
  task = null;
}
