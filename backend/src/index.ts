import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { config, isLoopbackHost } from "./config.js";
import { getDb, ensurePgSchema } from "./db/client.js";
import { buildRouter } from "./routes.js";
import { mountAuth, authEnabled } from "./auth.js";
import { ensureOwnerUser } from "./users.js";
import { startScheduler, reconcileStalePollRuns } from "./scheduler.js";
import { startRoutineScheduler } from "./routineScheduler.js";
import { startDiscoveryScheduler } from "./discoveryScheduler.js";
import { wireLlmUsageSink } from "./llmUsage.js";
import {
  enqueueEligibleResumes,
  requeueInterruptedResumeTasks,
  startResumeWorker,
} from "./resumePipeline.js";

async function main(): Promise<void> {
  // Safety gate: never expose beyond loopback without an access token.
  if (!isLoopbackHost(config.host) && !authEnabled()) {
    console.error(
      `[server] Refusing to bind to non-loopback host "${config.host}" without ACCESS_TOKEN.\n` +
        `[server] Set ACCESS_TOKEN in backend/.env (see 'npm run gen-token'), then restart.`
    );
    process.exit(1);
  }

  const db = getDb();
  // Schema + owner account must exist before any request resolves a user.
  await ensurePgSchema(db); // no-op on SQLite (schema applied at open)
  await ensureOwnerUser(db);
  wireLlmUsageSink(db); // spend meter: every LLM call → llm_usage

  const app = express();

  const corsOrigin = config.corsOrigins.includes("*") ? true : config.corsOrigins;
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: false }));

  // Auth (login/logout + guard) — enforced only when ACCESS_TOKEN is set.
  mountAuth(app, db);

  app.use("/", buildRouter(db));

  // Serve the built dashboard so every device hits one URL. Build it with:
  //   cd dashboard && npm run build
  const distIndex = path.join(config.dashboardDist, "index.html");
  if (fs.existsSync(distIndex)) {
    app.use(express.static(config.dashboardDist));
    // SPA fallback: any other GET (not an API route matched above) returns the app shell.
    app.get("*", (_req, res) => res.sendFile(distIndex));
    console.log(`[server] Serving dashboard from ${config.dashboardDist}`);
  } else {
    console.log(
      `[server] Dashboard build not found at ${config.dashboardDist} — run 'cd dashboard && npm run build' to serve it here.`
    );
  }

  app.listen(config.port, config.host, async () => {
    const shownHost = config.host === "0.0.0.0" ? "<this-device-ip>" : config.host;
    console.log(`[server] Job Hunt Assistant API on http://${shownHost}:${config.port}`);
    console.log(`[server] Auth ${authEnabled() ? "enabled (ACCESS_TOKEN set)" : "disabled (localhost-only)"}`);
    console.log(`[server] LLM ${config.llm.apiKey ? "enabled" : "disabled (heuristic fallbacks)"}`);
    console.log(`[server] DB engine: ${db.engine}${process.env.DATABASE_URL ? "" : ` (${config.dbPath})`}`);
    await reconcileStalePollRuns(db, Date.now(), { startup: true });
    startScheduler(db, { enqueueResumes: (d, uid) => void enqueueEligibleResumes(d, uid) });
    startRoutineScheduler(db);
    startDiscoveryScheduler(db);
    // Resume the résumé queue after a restart (tasks interrupted mid-generation).
    await requeueInterruptedResumeTasks(db);
    void startResumeWorker(db);
  });
}

main().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
