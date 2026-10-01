import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { DB } from "./db/client.js";
import { config } from "./config.js";
import { getDataVersion, bumpDataVersion } from "./dataVersion.js";
import { getLlm, getLlmHealth } from "./llm/client.js";
import { scoreJob } from "./llm/scoreJob.js";
import { triageJobs, type TriageInput } from "./llm/triageJob.js";
import { generateSiteAdapter } from "./llm/siteAdapter.js";
import { getTailorSource, loadMasterProfile } from "./profile/tailorSource.js";
import { buildApplyFields } from "./profile/applyFields.js";
import { buildFillScript, MAX_INLINE_RESUME_BYTES } from "./apply/fillScript.js";
import { answerScreeningQuestions } from "./llm/answerScreening.js";
import { computeMatchFacts } from "./profile/matchFacts.js";
import { triageJdHash, getCachedTriage, putCachedTriage, storedTriageOverride } from "./triageStore.js";
import { getSiteAdapter, putSiteAdapter } from "./siteAdapterStore.js";
import {
  generateResumeForJob,
  NoMasterResumeError,
} from "./render/generateResume.js";
import {
  listArtifacts,
  readArtifact,
  resumeDir,
  latestGeneratedAt,
  downloadBasename,
  stageToOutbox,
  type ArtifactFormat,
} from "./render/resumeStore.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { extractReferral } from "./llm/extractReferral.js";
import { extractJobFromText } from "./llm/extractJobFromText.js";
import { recommendKeywords } from "./llm/recommendKeywords.js";
import { runPoll, scoreUnscoredJobs, getPollStatus, isScoreBackfillRunning, runScoreBackfill, rescoreFreshJobs } from "./scheduler.js";
import { runDiscovery, listDiscoveryRuns, lastDiscoveryRun } from "./discovery.js";
import { fetchJobFromUrl } from "./sources/fetchJobFromUrl.js";
import { parseLinkedInSearch, linkedinGuestSearch } from "./sources/linkedinGuest.js";
import { sendMorningDigest, sendRoutineDigest } from "./routineScheduler.js";
import {
  recordScanReport,
  setScanRunNotifications,
  lastScanRun,
} from "./scanWatch.js";
import {
  enqueueEligibleResumes,
  resumePipelineStatus,
  resumeStatusForJobs,
  resumeStatusForJob,
  tasksQueuedToday,
} from "./resumePipeline.js";
import { backfillMissingJds } from "./jdBackfill.js";
import { notifyHighScoreJobs } from "./highScoreNotify.js";
import { spendSummary } from "./llmUsage.js";
import {
  requestPrefill,
  cancelPrefill,
  getPrefill,
  answerPrefill,
  listPrefills,
  nextPrefillWork,
  markPrefillStarted,
  markPrefillReady,
  markPrefillFailed,
  markPrefillClosed,
  screenshotPathFor,
  prefillStatusForJobs,
} from "./applyPrefill.js";
import { startApplyStream, advanceApplyStream, endApplyStream, currentApplyStream } from "./applyStream.js";
import { appendApplyDebug, readApplyDebug } from "./applyDebug.js";
import { MANUAL_CAREER_SITES } from "./careerSites.js";
import {
  listCompanyHealth,
  listCareerWatches,
  pollCareerWatches,
  upsertCareerWatch,
  validateAllCompanies,
  recoverDisabledBoards,
} from "./companyHealth.js";
import { getNotifier } from "./notify/slack.js";
import { collectAlerts, scoringMethodStats } from "./monitoring/alerts.js";
import { checkJobRegion, regionPolicyFromPrefs } from "./regionFilter.js";
import { freshnessMs } from "./freshness.js";
import { InvalidTransitionError } from "./state.js";
import {
  NotFoundError,
  addCompany,
  getJob,
  getProfile,
  ingestMany,
  listCompanies,
  listJobs,
  updateCompany,
  setJobNotes,
  setJobState,
  setProfile,
  setRelevance,
  seenStates,
  listUnscoredJobs,
  unscoredJobsStats,
  tabBadgeCounts,
  markExtensionCaptureJobsApplied,
  backfillRegionStatus,
  backfillEmploymentType,
  backfillSalary,
  repairPostingUrls,
  bulkAutoScreen,
  jobFacets,
  findJobByPostingUrl,
} from "./store.js";
import {
  activityStats,
  addKeywordSuggestion,
  lastPollRun,
  latestPageCapture,
  listKeywords,
  listPollRuns,
  listReferrals,
  recordApplication,
  recordEvent,
  recordPageCapture,
  listCaptures,
  getCapture,
  updateKeyword,
  updateReferral,
  upsertReferral,
} from "./captures.js";
import type { JobState, RawJob, ReferralState } from "./types.js";
import type { CaptureListRow } from "./captures.js";
import { OWNER_USER_ID, getUser } from "./users.js";

function resumeStatus(row: CaptureListRow): {
  status: "none" | "partial" | "ready";
  generatedAt: number | null;
  formats: string[];
} {
  const formats = row.resume_formats ? row.resume_formats.split(",").filter(Boolean) : [];
  const hasCore = formats.includes("txt") && formats.includes("docx");
  const status = !row.resume_generated_at ? "none" : hasCore ? "ready" : "partial";
  return { status, generatedAt: row.resume_generated_at, formats };
}

/** Run `fn` over `items` with at most `limit` in flight; preserves input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function wrap(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      if (err instanceof InvalidTransitionError) {
        res.status(409).json({ error: err.message });
      } else if (err instanceof NotFoundError) {
        res.status(404).json({ error: err.message });
      } else if (err instanceof NoMasterResumeError) {
        res.status(422).json({ error: err.message });
      } else if (err instanceof z.ZodError) {
        res.status(400).json({ error: "validation", details: err.errors });
      } else {
        console.error("[api] error:", err);
        res.status(500).json({ error: (err as Error).message ?? "internal error" });
      }
    });
  };
}

const RawJobSchema = z.object({
  source: z.string(),
  sourceKind: z.enum(["ats", "extension", "discovery"]),
  company: z.string().nullish(),
  title: z.string(),
  location: z.string().nullish(),
  url: z.string(),
  externalId: z.string().nullish(),
  description: z.string().nullish(),
  postedAt: z.number().nullish(),
  postedText: z.string().nullish(),
});

export function buildRouter(db: DB): Router {
  const r = Router();
  // Resolved account for the request (set by mountAuth; loopback / auth-off = owner).
  const uid = (req: Request): number => req.userId ?? OWNER_USER_ID;

  const unscoredStatsCache = new Map<number, { at: number; stats: Awaited<ReturnType<typeof unscoredJobsStats>> }>();
  const UNSCORED_STATS_TTL_MS = 60_000;

  async function cachedUnscoredJobsStats(userId: number): Promise<Awaited<ReturnType<typeof unscoredJobsStats>>> {
    const now = Date.now();
    const cached = unscoredStatsCache.get(userId);
    if (cached && now - cached.at < UNSCORED_STATS_TTL_MS) {
      return cached.stats;
    }
    const stats = await unscoredJobsStats(db, userId);
    unscoredStatsCache.set(userId, { at: now, stats });
    return stats;
  }
  const llm = getLlm();

  // ---- Jobs --------------------------------------------------------------
  r.post(
    "/jobs/ingest",
    wrap(async (req, res) => {
      const body = req.body;
      const arr = Array.isArray(body) ? body : body?.jobs;
      const jobs = z.array(RawJobSchema).parse(arr) as RawJob[];
      const userId = uid(req);
      const results = await ingestMany(db, userId, jobs);
      const extensionIds = (await Promise.all(results.map((r) => getJob(db, userId, r.id))))
        .filter((j) => j?.source_kind === "extension")
        .map((j) => j!.id);
      if (extensionIds.length) {
        await markExtensionCaptureJobsApplied(db, userId, extensionIds);
      }
      const scoreIds = results.map((r) => r.id).filter((id) => !extensionIds.includes(id));
      if (scoreIds.length) {
        const scoringStarted = Date.now();
        void scoreUnscoredJobs(db, userId, scoreIds, { llm })
          .then(() => notifyHighScoreJobs(db, userId, { scoredSince: scoringStarted }))
          .catch((err) => console.warn("[ingest] scoring failed:", (err as Error).message));
      }
      res.json(results);
    })
  );

  r.get(
    "/jobs",
    wrap(async (req, res) => {
      const q = req.query;
      const allRegions = q.allRegions === "1" || q.allRegions === "true";
      const allAges = q.allAges === "1" || q.allAges === "true";
      const jobs = await listJobs(db, uid(req), {
        state: q.state as JobState | undefined,
        source: q.source as string | undefined,
        sourceKind: q.sourceKind as "ats" | "extension" | "discovery" | undefined,
        minScore: q.minScore ? Number(q.minScore) : undefined,
        excludeZeroScore: q.excludeZeroScore === "1" || q.excludeZeroScore === "true",
        excludeUnscored: q.excludeUnscored === "1" || q.excludeUnscored === "true",
        sort: (q.sort as "score" | "first_seen") ?? "score",
        // Freshness must be a SQL filter, not post-fetch: otherwise a score-sorted
        // top-N is filled by stale high-scored rows that the 24h cull then removes,
        // leaving the queue near-empty when sorting by relevance.
        freshSince: allAges ? undefined : Date.now() - freshnessMs(),
        // Region filter is SQL too (jobs.region_status, stamped at ingest/score) —
        // no over-fetch + post-filter round trip.
        inRegionOnly: !allRegions,
        excludeStates: q.excludeStates
          ? (String(q.excludeStates).split(",").filter(Boolean) as JobState[])
          : undefined,
        employmentType: q.employmentType as
          | "full_time"
          | "contract"
          | "part_time"
          | "intern"
          | "unknown"
          | undefined,
        salaryFloor: q.salaryFloor === "1" || q.salaryFloor === "true",
        limit: q.limit ? Number(q.limit) : 100,
        offset: q.offset ? Number(q.offset) : undefined,
        omitDescription: true,
      });
      const ids = jobs.map((j) => j.id);
      const [resumeStatus, prefillStatus] = await Promise.all([
        resumeStatusForJobs(db, ids),
        prefillStatusForJobs(db, ids),
      ]);
      res.json(jobs.map((j) => ({ ...j, resume: resumeStatus.get(j.id), prefill: prefillStatus.get(j.id) ?? null })));
    })
  );

  // Facet counts for the queue filter dropdowns (server-wide, not just the visible page).
  r.get(
    "/jobs/facets",
    wrap(async (req, res) => {
      const q = req.query;
      const allRegions = q.allRegions === "1" || q.allRegions === "true";
      const allAges = q.allAges === "1" || q.allAges === "true";
      res.json(
        await jobFacets(db, uid(req), {
          freshSince: allAges ? undefined : Date.now() - freshnessMs(),
          inRegionOnly: !allRegions,
          excludeZeroScore: q.excludeZeroScore === "1" || q.excludeZeroScore === "true",
          excludeUnscored: q.excludeUnscored === "1" || q.excludeUnscored === "true",
        })
      );
    })
  );

  // The daily click-through list: fresh, in-region, high-score, actionable jobs.
  r.get(
    "/shortlist",
    wrap(async (req, res) => {
      const entries = await listJobs(db, uid(req), {
        freshSince: Date.now() - freshnessMs(),
        minScore: config.screening.shortlistMin,
        inRegionOnly: true,
        excludeStates: ["applied", "skipped"],
        sort: "score",
        limit: config.screening.shortlistSize,
        omitDescription: true,
      });
      const resumeStatus = await resumeStatusForJobs(db, entries.map((j) => j.id));
      res.json({
        generatedAt: Date.now(),
        minScore: config.screening.shortlistMin,
        entries: entries.map((j) => ({ ...j, resume: resumeStatus.get(j.id) })),
      });
    })
  );

  r.get(
    "/jobs/seen",
    wrap(async (req, res) => {
      const keys = String(req.query.keys ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      res.json(await seenStates(db, uid(req), keys));
    })
  );

  // Single-job detail + résumé status — the Copilot panel's job header.
  // Registered AFTER /jobs/facets and /jobs/seen so ":id" can't shadow them.
  r.get(
    "/jobs/:id",
    wrap(async (req, res) => {
      const job = await getJob(db, uid(req), req.params.id!);
      if (!job) throw new NotFoundError(`job ${req.params.id!}`);
      const resume = (await resumeStatusForJobs(db, [job.id])).get(job.id);
      const prefill = (await prefillStatusForJobs(db, [job.id])).get(job.id) ?? null;
      res.json({ ...job, resume, prefill });
    })
  );

  r.patch(
    "/jobs/:id",
    wrap(async (req, res) => {
      const { state, notes } = z
        .object({
          state: z.enum(["discovered", "relevant", "notified", "applied", "skipped"]).optional(),
          notes: z.string().optional(),
        })
        .parse(req.body);
      const userId = uid(req);
      let job = await getJob(db, userId, req.params.id!);
      if (!job) throw new NotFoundError(`job ${req.params.id!}`);
      if (notes !== undefined) job = await setJobNotes(db, userId, req.params.id!, notes);
      if (state) job = await setJobState(db, userId, req.params.id!, state);
      res.json(job);
    })
  );

  r.get(
    "/jobs/:id/apply-package",
    wrap(async (req, res) => {
      const userId = uid(req);
      const job = await getJob(db, userId, req.params.id!);
      if (!job) throw new NotFoundError(`job ${req.params.id!}`);
      const source = await getTailorSource(db, userId);
      const captured = (await latestPageCapture(db, userId, job.id))?.raw_text;
      const jd = captured ?? job.description ?? `${job.title} at ${job.company ?? ""}`;

      // No LLM tailoring here — opening the apply package is instant. Tailoring is an
      // explicit, on-demand action (Generate résumé button / Captures tab). If a résumé
      // was already generated for this job, surface that saved draft without re-running.
      let tailored: {
        keyword_coverage: { present: string[]; missing: string[] };
        changes_summary: string;
        cover_letter: string;
        tailoredMode: "llm" | "offline" | null;
      } | null = null;
      let requirementsCoverage: unknown = null;
      let rendered: string | null = null;
      const manifestBuf = await readArtifact(db, job.id, "manifest");
      if (manifestBuf) {
        try {
          const manifest = JSON.parse(manifestBuf.toString("utf8")) as {
            keyword_coverage?: { present: string[]; missing: string[] };
            changes_summary?: string;
            tailoredMode?: "llm" | "offline";
            requirement_coverage?: unknown;
          };
          requirementsCoverage = manifest.requirement_coverage ?? null;
          const coverLetter = (await readArtifact(db, job.id, "cover_letter"))?.toString("utf8") ?? "";
          tailored = {
            keyword_coverage: manifest.keyword_coverage ?? { present: [], missing: [] },
            changes_summary: manifest.changes_summary ?? "",
            cover_letter: coverLetter,
            // Older manifests predate the field: infer offline from the summary text.
            tailoredMode:
              manifest.tailoredMode ??
              (/^(profile-based selection \(offline\)|no llm tailoring)/i.test(
                manifest.changes_summary ?? ""
              )
                ? "offline"
                : manifest.changes_summary
                  ? "llm"
                  : null),
          };
        } catch {
          /* ignore malformed manifest */
        }
      }
      rendered = (await readArtifact(db, job.id, "txt"))?.toString("utf8") ?? null;

      res.json({
        job,
        descriptionSource: captured ? "apply_capture" : "listing",
        description: jd,
        tailored,
        renderedResume: rendered,
        renderError: null,
        keywordCoverage: tailored?.keyword_coverage ?? null,
        // Per-JD-requirement coverage from the last generation (null = regenerate to see it).
        requirementsCoverage,
        screeningAnswers: (await getProfile(db, userId)).screeningAnswers,
        masterResumePresent: source.masterResumePresent,
        masterResumeAdequate: source.masterResumeAdequate,
      });
    })
  );

  r.post(
    "/jobs/:id/generate-resume",
    wrap(async (req, res) => {
      const result = await generateResumeForJob(db, uid(req), req.params.id!, llm);
      // The global status poller re-renders on version change, so résumé badges
      // (queue cards, captures tab) catch up without a manual page refresh.
      bumpDataVersion();
      res.json(result);
    })
  );

  // Per-job generation status for the apply modal's poller: covers the queued
  // resume_tasks pipeline (scan/poll auto-tailoring) and fresh-artifact detection
  // for the synchronous Generate button path.
  r.get(
    "/jobs/:id/resume-status",
    wrap(async (req, res) => {
      const job = await getJob(db, uid(req), req.params.id!);
      if (!job) throw new NotFoundError(`job ${req.params.id!}`);
      const status = await resumeStatusForJob(db, job.id);
      res.json({ ...status, dir: resumeDir(job) });
    })
  );

  r.get(
    "/jobs/:id/resume",
    wrap(async (req, res) => {
      const job = await getJob(db, uid(req), req.params.id!);
      if (!job) throw new NotFoundError(`job ${req.params.id!}`);
      const artifacts = await listArtifacts(db, job.id);
      if (!artifacts.length) {
        res.status(404).json({ error: "no resume generated for this job" });
        return;
      }
      res.json({
        dir: resumeDir(job),
        artifacts: artifacts.map((a) => ({
          format: a.format,
          path: a.path,
          bytes: a.bytes,
        })),
        generatedAt: await latestGeneratedAt(db, job.id),
      });
    })
  );

  const MIME: Record<string, string> = {
    txt: "text/plain",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pdf: "application/pdf",
    cover_letter: "text/plain",
    manifest: "application/json",
  };

  r.get(
    "/jobs/:id/resume/file",
    wrap(async (req, res) => {
      const job = await getJob(db, uid(req), req.params.id!);
      if (!job) throw new NotFoundError(`job ${req.params.id!}`);
      const format = String(req.query.format ?? "txt") as ArtifactFormat;
      const allowed: ArtifactFormat[] = ["txt", "docx", "pdf", "cover_letter", "manifest"];
      if (!allowed.includes(format)) {
        res.status(400).json({ error: "invalid format" });
        return;
      }
      const buf = await readArtifact(db, job.id, format);
      if (!buf) {
        res.status(404).json({ error: "artifact not found" });
        return;
      }
      const ext =
        format === "cover_letter" ? "txt" : format === "manifest" ? "json" : format;
      const filename = downloadBasename(job, ext);
      res.setHeader("Content-Type", MIME[format] ?? "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(buf);
    })
  );

  // Copilot "stage to outbox": clear the fixed outbox folder and copy this
  // job's tailored PDF there as the ONLY file — the OS file picker then always
  // finds the right résumé at the same path (navigate there once, ever).
  r.post(
    "/jobs/:id/stage-resume",
    wrap(async (req, res) => {
      const addr = req.socket.remoteAddress ?? "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr)) {
        res.status(403).json({ error: "localhost only" });
        return;
      }
      const job = await getJob(db, uid(req), req.params.id!);
      if (!job) throw new NotFoundError(`job ${req.params.id!}`);
      const buf = await readArtifact(db, job.id, "pdf");
      if (!buf) {
        res.status(404).json({ error: "no tailored PDF yet — generate a résumé for this job first" });
        return;
      }
      const filename = stageToOutbox(job, buf, config.outboxDir);
      res.json({ ok: true, dir: config.outboxDir, filename });
    })
  );

  r.post(
    "/jobs/:id/open-folder",
    wrap(async (req, res) => {
      const addr = req.socket.remoteAddress ?? "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr)) {
        res.status(403).json({ error: "localhost only" });
        return;
      }
      const job = await getJob(db, uid(req), req.params.id!);
      if (!job) throw new NotFoundError(`job ${req.params.id!}`);
      const dir = resumeDir(job);
      if (!fs.existsSync(dir)) {
        res
          .status(404)
          .json({ error: "no résumé folder yet — generate a résumé for this job first", dir });
        return;
      }

      // Reveal the folder in the OS file manager. Report launch failures instead of
      // silently claiming success (explorer.exe can exit non-zero even on success,
      // so we only treat a spawn *error* — bad path, missing binary — as failure).
      const platform = process.platform;
      const [cmd, args] =
        platform === "win32"
          ? ["explorer.exe", [dir]]
          : platform === "darwin"
            ? ["open", [dir]]
            : ["xdg-open", [dir]];
      try {
        const child = spawn(cmd as string, args as string[], {
          detached: true,
          stdio: "ignore",
        });
        let failed = false;
        child.on("error", (err) => {
          failed = true;
          console.warn(`[open-folder] ${cmd} failed:`, err.message);
        });
        child.unref();
        // Give a synchronous spawn error a tick to surface before responding.
        setTimeout(() => {
          if (failed) {
            res.status(500).json({ error: `could not open folder (${cmd} unavailable)`, dir });
          } else {
            res.json({ ok: true, dir });
          }
        }, 50);
      } catch (err) {
        res.status(500).json({ error: `could not open folder: ${(err as Error).message}`, dir });
      }
    })
  );

  r.post(
    "/jobs/:id/apply",
    wrap(async (req, res) => {
      const { resumeVariant, coverLetter, notes } = z
        .object({
          resumeVariant: z.string().optional(),
          coverLetter: z.string().optional(),
          notes: z.string().optional(),
        })
        .parse(req.body ?? {});
      const userId = uid(req);
      const job = await getJob(db, userId, req.params.id!);
      if (!job) throw new NotFoundError(`job ${req.params.id!}`);
      const updated = await setJobState(db, userId, job.id, "applied");
      await recordApplication(db, userId, job.id, { resumeVariant, coverLetter, notes });
      res.json(updated);
    })
  );

  // ---- Prefill-ahead (phone decides, desktop fills) -------------------------
  // Phone/dashboard side: queue, inspect, answer open questions, cancel.
  r.post(
    "/jobs/:id/prefill",
    wrap(async (req, res) => {
      const result = await requestPrefill(db, uid(req), req.params.id!);
      if (!result.ok && result.reason === "not_found") throw new NotFoundError(`job ${req.params.id!}`);
      res.json(result);
    })
  );
  r.get(
    "/jobs/:id/prefill",
    wrap(async (req, res) => {
      const detail = await getPrefill(db, uid(req), req.params.id!);
      if (!detail) throw new NotFoundError(`prefill for ${req.params.id!}`);
      res.json(detail);
    })
  );
  r.delete(
    "/jobs/:id/prefill",
    wrap(async (req, res) => {
      res.json({ ok: await cancelPrefill(db, uid(req), req.params.id!) });
    })
  );
  r.post(
    "/jobs/:id/prefill/answers",
    wrap(async (req, res) => {
      const { answers } = z
        .object({ answers: z.record(z.string().min(1).max(300), z.string().max(2000)) })
        .parse(req.body ?? {});
      const result = await answerPrefill(db, uid(req), req.params.id!, answers);
      if (!result) throw new NotFoundError(`prefill for ${req.params.id!}`);
      res.json({ ok: true, ...result });
    })
  );
  r.get(
    "/jobs/:id/prefill/screenshot",
    wrap(async (req, res) => {
      const p = await screenshotPathFor(db, uid(req), req.params.id!);
      if (!p) throw new NotFoundError("screenshot");
      res.sendFile(p);
    })
  );
  r.get(
    "/prefill",
    wrap(async (req, res) => {
      res.json(await listPrefills(db, uid(req), req.query.limit ? Number(req.query.limit) : 50));
    })
  );
  // Extension side: one poll returns tabs to close, refills to run, next job to open.
  let lastPrefillPollLog = 0;
  r.get(
    "/prefill/next",
    wrap(async (req, res) => {
      const work = await nextPrefillWork(db, uid(req));
      // Observability for the unattended loop: one line per 10 min of quiet
      // polling, and always when there is work — "is the extension polling at
      // all?" must be answerable from server.log alone.
      const hasWork = work.next || work.close.length || work.refills.length;
      if (hasWork || Date.now() - lastPrefillPollLog > 10 * 60 * 1000) {
        lastPrefillPollLog = Date.now();
        console.log(
          `[prefill] extension poll — parked ${work.active}/${work.cap}` +
            (work.next ? ` · open ${work.next.jobId} (${work.next.company ?? "?"} · ${work.next.title})` : "") +
            (work.close.length ? ` · close ${work.close.length}` : "") +
            (work.refills.length ? ` · refill ${work.refills.length}` : "")
        );
      }
      res.json(work);
    })
  );
  r.post(
    "/prefill/:id/started",
    wrap(async (req, res) => {
      const { tabId } = z.object({ tabId: z.number().int() }).parse(req.body ?? {});
      res.json({ ok: await markPrefillStarted(db, uid(req), req.params.id!, tabId) });
    })
  );
  r.post(
    "/prefill/:id/ready",
    wrap(async (req, res) => {
      const report = z
        .object({
          fields: z
            .array(
              z.object({
                label: z.string(),
                value: z.string(),
                source: z.enum(["engine", "human", "human-edited", "empty"]),
              })
            )
            .max(200),
          unanswered: z.array(z.string()).max(60),
          resumeState: z.string().nullish(),
          drafted: z.number().int().optional(),
          screenshotBase64: z.string().max(4_000_000).optional(),
        })
        .parse(req.body ?? {});
      const detail = await markPrefillReady(db, uid(req), req.params.id!, report);
      if (!detail) throw new NotFoundError(`prefill for ${req.params.id!}`);
      bumpDataVersion();
      res.json(detail);
    })
  );
  r.post(
    "/prefill/:id/failed",
    wrap(async (req, res) => {
      const { reason } = z.object({ reason: z.string().max(300) }).parse(req.body ?? {});
      const ok = await markPrefillFailed(db, uid(req), req.params.id!, reason);
      bumpDataVersion();
      res.json({ ok });
    })
  );
  r.post(
    "/prefill/:id/closed",
    wrap(async (req, res) => {
      res.json({ ok: await markPrefillClosed(db, uid(req), req.params.id!) });
    })
  );

  // ---- Apply stream (chained batch apply) --------------------------------
  // Dashboard starts a stream from the apply queue; the extension's background
  // worker advances it after each human Submit and navigates the same tab to
  // the next job's URL (which carries the #jh-apply handoff hash).
  r.post(
    "/apply-stream",
    wrap(async (req, res) => {
      const { ids } = z.object({ ids: z.array(z.string().min(1)).min(1).max(100) }).parse(req.body);
      res.json(await startApplyStream(db, uid(req), ids));
    })
  );
  // The Copilot panel attaches to the live stream (it drives manual-mode jobs).
  r.get(
    "/apply-stream/current",
    wrap(async (req, res) => {
      res.json((await currentApplyStream(db, uid(req))) ?? { streamId: null, current: null, remaining: 0 });
    })
  );
  r.post(
    "/apply-stream/:id/advance",
    wrap(async (req, res) => {
      const { afterId } = z.object({ afterId: z.string().min(1) }).parse(req.body);
      const result = await advanceApplyStream(db, uid(req), req.params.id!, afterId);
      if (!result) throw new NotFoundError(`apply stream ${req.params.id!}`);
      res.json(result);
    })
  );
  r.delete(
    "/apply-stream/:id",
    wrap(async (req, res) => {
      res.json({ ended: endApplyStream(uid(req), req.params.id!) });
    })
  );

  // ---- Phone apply --------------------------------------------------------
  // The whole fill engine plus this job's data as ONE self-contained script.
  // The phone has no extension, and page JavaScript on an ATS host cannot reach
  // this backend (connect-src), so profile / cover letter / résumé bytes are
  // inlined rather than fetched. An iOS Shortcut feeds the response to Safari's
  // "Run JavaScript on Web Page". See docs/phone-apply-design.md.
  //
  // Default output is URL-encoded: it makes the payload safe to paste into the
  // Shortcut's `new Function(decodeURIComponent("…"))` wrapper, where a stray
  // quote or newline would otherwise be a syntax error. ?format=js returns the
  // readable source for debugging from a desktop console.
  r.get(
    "/apply/fill-script",
    wrap(async (req, res) => {
      const { url, resume, format } = z
        .object({
          url: z.string().url(),
          resume: z.enum(["0", "1"]).default("1"),
          format: z.enum(["encoded", "js"]).default("encoded"),
        })
        .parse(req.query);
      const userId = uid(req);
      const job = await findJobByPostingUrl(db, userId, url);
      const { screeningAnswers } = await getProfile(db, userId);
      const fields = buildApplyFields(loadMasterProfile(userId), screeningAnswers);
      const base = config.notify.dashboardUrl.replace(/\/$/, "");

      let coverLetter = "";
      let resumeBase64: string | null = null;
      let resumeUrl: string | null = null;
      if (job) {
        coverLetter = (await readArtifact(db, job.id, "cover_letter"))?.toString("utf8").trim() ?? "";
        const pdf = await readArtifact(db, job.id, "pdf");
        if (pdf) {
          resumeUrl = `${base}/jobs/${job.id}/resume/file?format=pdf`;
          if (resume === "1" && pdf.byteLength <= MAX_INLINE_RESUME_BYTES) {
            resumeBase64 = pdf.toString("base64");
          }
        }
      }

      const script = buildFillScript({
        jobId: job?.id ?? null,
        title: job?.title ?? null,
        company: job?.company ?? null,
        fields,
        coverLetter,
        resumeBase64,
        resumeUrl,
        // Recording needs an authenticated POST the page can't make; the human
        // taps this instead and the dashboard marks it applied.
        recordUrl: job ? `${base}/?applied=${encodeURIComponent(job.id)}` : null,
      });
      res.type("text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.send(format === "js" ? script : encodeURIComponent(script));
    })
  );

  // ---- Apply-assist debug log --------------------------------------------
  // The extension reports every stream/fill step here (with an optional
  // screenshot on failures) so a stuck run is diagnosable after the fact:
  // read logs/apply-debug.jsonl or GET /debug/apply?limit=50.
  r.post(
    "/debug/apply",
    wrap(async (req, res) => {
      const e = z
        .object({
          event: z.string().min(1).max(80),
          jobId: z.string().optional(),
          streamId: z.string().optional(),
          data: z.unknown().optional(),
          screenshotBase64: z.string().max(4_000_000).optional(),
        })
        .parse(req.body);
      res.json({ ok: true, ...appendApplyDebug(e) });
    })
  );
  r.get(
    "/debug/apply",
    wrap(async (req, res) => {
      res.json(readApplyDebug(req.query.limit ? Number(req.query.limit) : 50));
    })
  );

  // ---- Companies ---------------------------------------------------------
  r.get(
    "/companies",
    wrap(async (req, res) => res.json(await listCompanies(db, uid(req))))
  );
  r.get(
    "/companies/health",
    wrap(async (req, res) => res.json(await listCompanyHealth(db, uid(req))))
  );
  r.post(
    "/companies",
    wrap(async (req, res) => {
      const c = z
        .object({
          name: z.string(),
          ats: z.enum(["greenhouse", "lever", "ashby", "workday", "oracle"]),
          boardToken: z.string(),
          enabled: z.boolean().optional(),
        })
        .parse(req.body);
      res.json(await addCompany(db, uid(req), c));
    })
  );
  r.patch(
    "/companies/:id",
    wrap(async (req, res) => {
      const body = z
        .object({
          enabled: z.boolean().optional(),
          ats: z.enum(["greenhouse", "lever", "ashby", "workday", "oracle"]).optional(),
          boardToken: z.string().optional(),
        })
        .parse(req.body);
      res.json(
        await updateCompany(db, uid(req), Number(req.params.id!), {
          enabled: body.enabled,
          ats: body.ats,
          boardToken: body.boardToken,
        })
      );
    })
  );

  // ---- Profile -----------------------------------------------------------
  r.get(
    "/profile/tailor-source",
    wrap(async (req, res) => {
      const s = await getTailorSource(db, uid(req));
      res.json({
        masterResumePresent: s.masterResumePresent,
        masterResumeAdequate: s.masterResumeAdequate,
        sourceKind: s.kind,
        masterTextLength: s.masterText.length,
      });
    })
  );
  r.get(
    "/profile/match-facts",
    wrap(async (req, res) => {
      const userId = uid(req);
      const facts = computeMatchFacts(loadMasterProfile(userId), (await getProfile(db, userId)).preferences);
      res.json(facts);
    })
  );
  r.get(
    "/profile",
    wrap(async (req, res) => res.json(await getProfile(db, uid(req))))
  );
  // Flat, form-ready contact fields + normalized screening answers — consumed by
  // the extension's Easy Apply assist and the /apply skill for autofill.
  r.get(
    "/profile/apply-fields",
    wrap(async (req, res) => {
      const userId = uid(req);
      const { screeningAnswers } = await getProfile(db, userId);
      res.json(buildApplyFields(loadMasterProfile(userId), screeningAnswers));
    })
  );
  // Screening questions the deterministic fill couldn't answer: LLM answers the
  // factual-from-profile ones (years-of-experience etc., grounded + conservative);
  // sensitive categories (salary/visa/legal/demographics) always come back null so
  // the human answers them in the wizard. Non-null answers are merged into the
  // screeningAnswers bank — each question costs at most one LLM call ever.
  r.post(
    "/profile/answer-screening",
    wrap(async (req, res) => {
      const { questions } = z
        .object({ questions: z.array(z.string().min(1).max(300)).min(1).max(30) })
        .parse(req.body);
      const userId = uid(req);
      const profileDoc = loadMasterProfile(userId);
      if (!profileDoc) {
        res.json({ answers: Object.fromEntries(questions.map((q) => [q, null])), method: "unavailable" });
        return;
      }
      const result = await answerScreeningQuestions(llm, profileDoc, questions);
      const banked = Object.fromEntries(
        Object.entries(result.answers).filter(([, v]) => v != null)
      ) as Record<string, string>;
      if (Object.keys(banked).length) {
        const current = await getProfile(db, userId);
        await setProfile(db, userId, {
          screeningAnswers: { ...current.screeningAnswers, ...banked },
        });
      }
      res.json(result);
    })
  );
  // Submit-time answer banking (the improvement loop): the extension diffs the
  // form at the human's Submit click and sends what the HUMAN filled/corrected.
  // Their own words, merged into screeningAnswers so the next form asking the
  // same question auto-fills. Protected/EEO questions never leave the page.
  r.post(
    "/profile/bank-answers",
    wrap(async (req, res) => {
      const { answers } = z
        .object({ answers: z.record(z.string().min(1).max(300), z.string().min(1).max(2000)) })
        .parse(req.body);
      const entries = Object.entries(answers).slice(0, 40);
      const userId = uid(req);
      const current = await getProfile(db, userId);
      await setProfile(db, userId, {
        screeningAnswers: { ...current.screeningAnswers, ...Object.fromEntries(entries) },
      });
      res.json({ banked: entries.length });
    })
  );
  r.put(
    "/profile",
    wrap(async (req, res) => {
      const p = z
        .object({
          masterResume: z.string().nullish(),
          preferences: z
            .object({
              titles: z.array(z.string()).optional(),
              locations: z.array(z.string()).optional(),
              allowedRegions: z.array(z.enum(["US", "CA"])).optional(),
              keywords: z.array(z.string()).optional(),
              seniority: z.string().optional(),
              dealbreakers: z.array(z.string()).optional(),
              targetCompanies: z.array(z.string()).optional(),
            })
            .passthrough()
            .optional(),
          screeningAnswers: z.record(z.string()).optional(),
        })
        .parse(req.body);
      res.json(
        await setProfile(db, uid(req), {
          masterResume: p.masterResume ?? undefined,
          preferences: p.preferences,
          screeningAnswers: p.screeningAnswers,
        })
      );
    })
  );

  // ---- Keywords ----------------------------------------------------------
  r.get(
    "/keywords",
    wrap(async (req, res) =>
      res.json(await listKeywords(db, uid(req), req.query.status as string | undefined))
    )
  );
  r.patch(
    "/keywords/:id",
    wrap(async (req, res) => {
      const { status } = z
        .object({ status: z.enum(["suggested", "used", "dismissed"]) })
        .parse(req.body);
      res.json(await updateKeyword(db, uid(req), Number(req.params.id!), status));
    })
  );
  r.post(
    "/keywords/recommend",
    wrap(async (req, res) => {
      const userId = uid(req);
      const prefs = (await getProfile(db, userId)).preferences;
      const liked = (await listJobs(db, userId, { state: "relevant", limit: 50 }))
        .concat(await listJobs(db, userId, { state: "applied", limit: 50 }))
        .map((j) => j.title);
      const skipped = (await listJobs(db, userId, { state: "skipped", limit: 50 })).map((j) => j.title);
      const suggestions = await recommendKeywords(llm, {
        seedKeywords: prefs.keywords ?? [],
        likedTitles: liked,
        skippedTitles: skipped,
      });
      for (const s of suggestions) await addKeywordSuggestion(db, userId, s.term, s.rationale);
      res.json(await listKeywords(db, userId, "suggested"));
    })
  );

  // ---- Capture events (Path B) ------------------------------------------
  r.post(
    "/events",
    wrap(async (req, res) => {
      const e = z
        .object({
          source: z.string(),
          event: z.enum([
            "listed",
            "viewed",
            "thread_opened",
            "apply_page_opened",
            "apply_intent",
          ]),
          jobId: z.string().nullish(),
          url: z.string().nullish(),
          meta: z.record(z.unknown()).nullish(),
        })
        .parse(req.body);
      res.json(await recordEvent(db, uid(req), e));
    })
  );

  // ---- Page captures -----------------------------------------------------
  r.get(
    "/captures",
    wrap(async (req, res) => {
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      const rows = (await listCaptures(db, uid(req), limit)).map((row) => ({
        captureId: row.capture_id,
        jobId: row.job_id,
        url: row.url,
        source: row.source,
        title: row.title ?? row.job_title,
        company: row.company,
        location: row.location,
        salaryText: row.salary_text,
        captureKind: row.capture_kind,
        jdPreview: row.raw_text.slice(0, 400),
        jdLength: row.raw_text.length,
        capturedAt: row.captured_at,
        jobState: row.job_state,
        resume: resumeStatus(row),
      }));
      res.json(rows);
    })
  );

  r.get(
    "/captures/:id",
    wrap(async (req, res) => {
      const row = await getCapture(db, uid(req), Number(req.params.id));
      if (!row) throw new NotFoundError(`capture ${req.params.id}`);
      res.json({
        captureId: row.capture_id,
        jobId: row.job_id,
        url: row.url,
        source: row.source,
        title: row.title ?? row.job_title,
        company: row.company,
        location: row.location,
        salaryText: row.salary_text,
        captureKind: row.capture_kind,
        jd: row.raw_text,
        capturedAt: row.captured_at,
        jobState: row.job_state,
        resume: resumeStatus(row),
      });
    })
  );

  // Capture a job from just its URL (iPad / phone / iOS Shortcut — no extension).
  // Fetches the page server-side, extracts via schema.org JobPosting JSON-LD + meta,
  // and — when a usable description is found — records it like a right-click capture.
  r.post(
    "/captures/from-url",
    wrap(async (req, res) => {
      const { url } = z.object({ url: z.string().url() }).parse(req.body);
      const { ok, error, extracted } = await fetchJobFromUrl(url);
      if (!ok || !extracted.description) {
        // Return partial fields (title/company) so the client can prefill + prompt paste.
        res.json({ ok: false, needsManual: true, error, extracted });
        return;
      }
      const userId = uid(req);
      const result = await recordPageCapture(db, userId, {
        url,
        source: "manual-url",
        rawText: extracted.description,
        title: extracted.title ?? undefined,
        company: extracted.company ?? undefined,
        location: extracted.location ?? undefined,
        salaryText: extracted.salaryText ?? undefined,
        captureKind: "right_click",
      });
      if (result.jobId) {
        void scoreUnscoredJobs(db, userId, [result.jobId], { llm }).catch((err) =>
          console.warn("[capture-from-url] scoring failed:", (err as Error).message)
        );
      }
      res.json({ ok: true, jobId: result.jobId, extracted });
    })
  );

  // Ad-hoc capture: paste ANY text containing a job (recruiter email, LinkedIn
  // message, Slack post). The LLM extracts fields + a cleaned JD, then the normal
  // capture → score → (≥0.7) résumé pipeline applies.
  r.post(
    "/captures/from-text",
    wrap(async (req, res) => {
      const { rawText, url, source } = z
        .object({
          rawText: z.string().min(100, "paste at least ~100 characters of job text").max(50_000),
          url: z.string().url().nullish(),
          source: z.string().nullish(),
        })
        .parse(req.body);

      const { extracted, method } = await extractJobFromText(llm, rawText);
      if (extracted.confidence < 0.4 || !extracted.title) {
        // Not confident this is one specific job — hand the fields back so the
        // client can prefill the manual form (mirrors /captures/from-url).
        res.json({
          ok: false,
          needsManual: true,
          method,
          error:
            method === "fallback"
              ? "LLM unavailable — fill in the fields manually"
              : "Couldn't confidently identify a single job in that text",
          extracted,
        });
        return;
      }

      const userId = uid(req);
      const result = await recordPageCapture(db, userId, {
        // jobs.url is NOT NULL — synthesize a stable pasted:// URL when none exists.
        url:
          extracted.applyUrl ??
          url ??
          `pasted://${createHash("sha1").update(rawText).digest("hex").slice(0, 16)}`,
        source: source ?? "manual-paste",
        rawText: extracted.description,
        title: extracted.title ?? undefined,
        company: extracted.company ?? undefined,
        location: extracted.location ?? undefined,
        salaryText: extracted.salaryText ?? undefined,
        captureKind: "right_click",
        meta: { pasted: true, extractMethod: method },
      });
      if (result.jobId) {
        void scoreUnscoredJobs(db, userId, [result.jobId], { llm }).catch((err) =>
          console.warn("[capture-from-text] scoring failed:", (err as Error).message)
        );
      }
      res.json({ ok: true, captureId: result.id, jobId: result.jobId, method, extracted });
    })
  );

  r.post(
    "/page-captures",
    wrap(async (req, res) => {
      const c = z
        .object({
          url: z.string(),
          source: z.string().nullish(),
          rawText: z.string(),
          jobId: z.string().nullish(),
          title: z.string().nullish(),
          company: z.string().nullish(),
          location: z.string().nullish(),
          externalId: z.string().nullish(),
          salaryText: z.string().nullish(),
          captureKind: z.enum(["right_click", "apply_page"]).optional(),
          meta: z.record(z.unknown()).nullish(),
        })
        .parse(req.body);
      const userId = uid(req);
      const result = await recordPageCapture(db, userId, c);
      if (result.jobId) {
        void scoreUnscoredJobs(db, userId, [result.jobId], { llm }).catch((err) =>
          console.warn("[page-capture] scoring failed:", (err as Error).message)
        );
      }
      res.json(result);
    })
  );

  // ---- Referrals ---------------------------------------------------------
  r.post(
    "/referrals/ingest",
    wrap(async (req, res) => {
      const { threadUrl, rawText, source } = z
        .object({
          threadUrl: z.string(),
          rawText: z.string(),
          source: z.string().optional(),
        })
        .parse(req.body);
      const extracted = await extractReferral(llm, rawText);
      const userId = uid(req);
      const rows = await Promise.all(extracted.map((e, i) =>
        upsertReferral(db, userId, {
          source: source ?? "forum",
          company: e.company ?? null,
          roles: e.roles,
          referrer: e.referrer ?? null,
          contact: e.contact ?? null,
          deadline: e.deadline ?? null,
          threadUrl,
          rawText,
          index: i,
        })
      ));
      res.json(rows);
    })
  );
  r.get(
    "/referrals",
    wrap(async (req, res) =>
      res.json(await listReferrals(db, uid(req), req.query.state as ReferralState | undefined))
    )
  );
  r.patch(
    "/referrals/:id",
    wrap(async (req, res) => {
      const patch = z
        .object({
          state: z.enum(["new", "contacted", "applied", "skipped"]).optional(),
          jobId: z.string().nullish(),
          notes: z.string().optional(),
        })
        .parse(req.body);
      res.json(
        await updateReferral(db, uid(req), req.params.id!, {
          state: patch.state,
          jobId: patch.jobId ?? undefined,
          notes: patch.notes,
        })
      );
    })
  );

  // ---- Stats / progress --------------------------------------------------
  r.get(
    "/stats/activity",
    wrap(async (req, res) => {
      const since = req.query.since ? Number(req.query.since) : undefined;
      res.json(await activityStats(db, uid(req), since));
    })
  );
  r.get(
    "/stats/tab-counts",
    wrap(async (req, res) => {
      res.json(await tabBadgeCounts(db, uid(req)));
    })
  );
  r.get(
    "/poll-runs",
    wrap(async (req, res) =>
      res.json(await listPollRuns(db, uid(req), req.query.limit ? Number(req.query.limit) : 50))
    )
  );
  r.get(
    "/discovery-runs",
    wrap(async (req, res) =>
      res.json(await listDiscoveryRuns(db, req.query.limit ? Number(req.query.limit) : 20))
    )
  );
  r.post(
    "/admin/discovery-now",
    wrap(async (_req, res) => {
      const summary = await runDiscovery(db, "manual");
      res.json(summary);
    })
  );
  r.post(
    "/admin/poll-now",
    wrap(async (req, res) => {
      const summary = await runPoll(db, uid(req), "manual", {
        llm,
        enqueueResumes: (d, userId) => void enqueueEligibleResumes(d, userId, { llm }),
      });
      res.json(summary);
    })
  );

  // LLM spend meter: calls / tokens / est. USD today, 7d, 30d (+ per-day rows).
  r.get(
    "/admin/spend",
    wrap(async (_req, res) => {
      res.json({
        ...(await spendSummary(db)),
        tailorDailyCap: config.resume.dailyCap,
        tailorQueuedToday: await tasksQueuedToday(db, uid(_req)),
      });
    })
  );

  // ---- Auto résumé pipeline (batch tailoring for >=70% matches) -----------
  r.get(
    "/resume-pipeline",
    wrap(async (req, res) => {
      res.json(await resumePipelineStatus(db, uid(req)));
    })
  );

  r.post(
    "/resume-pipeline/run",
    wrap(async (req, res) => {
      const hours = req.body?.hours ? Number(req.body.hours) : undefined;
      const userId = uid(req);
      const result = await enqueueEligibleResumes(db, userId, { llm, hours });
      res.json({ ok: true, ...result, status: (await resumePipelineStatus(db, userId, 0)).counts });
    })
  );

  r.post(
    "/admin/score-unscored",
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as {
        freshOnly?: boolean;
        inRegionOnly?: boolean;
        limit?: number;
      };
      const freshOnly = body.freshOnly ?? true;
      const inRegionOnly = body.inRegionOnly ?? true;
      const limit = Math.min(Math.max(Number(body.limit ?? 50), 1), 200);
      const userId = uid(req);
      const pending = await listUnscoredJobs(db, userId, { freshOnly, inRegionOnly, limit });
      const scoringStarted = Date.now();
      const { scored, skipped } = await runScoreBackfill(db, userId, pending.map((j) => j.id), { llm });
      if (scored > 0) await notifyHighScoreJobs(db, userId, { scoredSince: scoringStarted });
      const remaining = (await listUnscoredJobs(db, userId, {
        freshOnly,
        inRegionOnly,
        limit: 500,
      })).length;
      res.json({
        ok: true,
        attempted: pending.length,
        scored,
        remaining,
        skipped,
        freshOnly,
        inRegionOnly,
      });
    })
  );

  r.post(
    "/admin/mark-capture-applied",
    wrap(async (req, res) => {
      const updated = await markExtensionCaptureJobsApplied(db, uid(req));
      res.json({ ok: true, updated });
    })
  );

  // Send a test notification through the real notifier (Slack if configured, else console).
  r.get(
    "/career-sites",
    wrap((_req, res) => {
      res.json(MANUAL_CAREER_SITES);
    })
  );

  r.get(
    "/career-watches",
    wrap(async (req, res) => res.json(await listCareerWatches(db, uid(req))))
  );

  r.post(
    "/admin/seed-career-watches",
    wrap(async (req, res) => {
      for (const s of MANUAL_CAREER_SITES) {
        await upsertCareerWatch(db, uid(req), {
          name: s.name,
          url: s.url,
          searchUrl: s.searchUrl,
          enabled: true,
        });
      }
      res.json({ ok: true, count: MANUAL_CAREER_SITES.length });
    })
  );

  r.post(
    "/admin/poll-career-watches",
    wrap(async (req, res) => {
      const result = await pollCareerWatches(db, uid(req));
      res.json({ ok: true, ...result });
    })
  );

  r.post(
    "/admin/validate-companies",
    wrap(async (req, res) => {
      const results = await validateAllCompanies(db, uid(req));
      const summary = {
        active: results.filter((r) => r.status === "active").length,
        empty: results.filter((r) => r.status === "empty").length,
        error: results.filter((r) => r.status === "error").length,
        disabled: results.filter((r) => !r.enabled).length,
      };
      res.json({ ok: true, summary, results });
    })
  );

  r.post(
    "/admin/morning-digest",
    wrap(async (req, res) => {
      const result = await sendMorningDigest(db, uid(req));
      res.json({ ok: true, sent: result.sent, preview: result.text });
    })
  );

  r.post(
    "/admin/evening-digest",
    wrap(async (req, res) => {
      const result = await sendRoutineDigest(db, uid(req), "evening");
      res.json({ ok: true, sent: result.sent, preview: result.text });
    })
  );

  r.post(
    "/admin/test-notify",
    wrap(async (_req, res) => {
      const notifier = getNotifier();
      await notifier.notify({
        title: "Test — Senior Backend Engineer",
        company: "Job Hunt Assistant",
        score: 0.95,
        reason: "This is a test ping confirming your notifier is wired up.",
        deepLink: `${config.notify.dashboardUrl}/`,
      });
      res.json({ ok: true, channel: config.notify.slackWebhookUrl ? "slack" : "console" });
    })
  );

  // Bulk-apply the auto-skip threshold to already-scored discovered jobs.
  r.post(
    "/admin/auto-screen",
    wrap(async (req, res) => {
      const threshold = Number(req.body?.threshold ?? config.screening.autoSkipBelow);
      if (!(threshold >= 0 && threshold <= 1)) {
        res.status(400).json({ error: "threshold must be 0..1" });
        return;
      }
      res.json({ ok: true, threshold, ...(await bulkAutoScreen(db, uid(req), threshold)) });
    })
  );

  // One-off: stamp region_status on rows that predate the column.
  r.post(
    "/admin/backfill-region-status",
    wrap(async (req, res) => {
      res.json({ ok: true, ...(await backfillRegionStatus(db, uid(req))) });
    })
  );

  // One-off: classify employment_type on rows that predate the column (regex only —
  // structured source fields are gone for old rows; untouched rows stay NULL = unknown).
  r.post(
    "/admin/backfill-employment",
    wrap(async (req, res) => {
      res.json({ ok: true, ...(await backfillEmploymentType(db, uid(req))) });
    })
  );

  // Alert-banner recovery: probe auto-disabled boards; still-broken ones get
  // DeepSeek-proposed candidate boards, accepted only when the public API
  // answers with live jobs.
  r.post(
    "/admin/recover-boards",
    wrap(async (req, res) => {
      res.json({ ok: true, results: await recoverDisabledBoards(db, uid(req), llm) });
    })
  );

  // "Mute" for boards that are PERMANENTLY gone (company left the supported
  // ATSes): keep them disabled but clear the auto_disabled markers so the
  // alert banner stops nagging. Reversible from the Companies tab.
  r.post(
    "/admin/acknowledge-boards",
    wrap(async (req, res) => {
      const result = await db
        .prepare(
          `UPDATE companies SET auto_disabled_at = NULL, auto_disabled_reason = NULL
           WHERE user_id = ? AND auto_disabled_at IS NOT NULL AND enabled = 0`
        )
        .run(uid(req));
      res.json({ ok: true, acknowledged: (result as { changes?: number }).changes ?? 0 });
    })
  );

  // One-off: stamp salary_min/max_cad + workplace on pre-migration rows.
  r.post(
    "/admin/backfill-salary",
    wrap(async (req, res) => {
      res.json({ ok: true, ...(await backfillSalary(db, uid(req))) });
    })
  );

  // One-off: canonicalize stored posting URLs (new rows are fixed at ingest).
  r.post(
    "/admin/repair-urls",
    wrap(async (req, res) => {
      res.json({ ok: true, ...(await repairPostingUrls(db, uid(req))) });
    })
  );

  // Re-apply US/Canada filter to existing jobs (skip out-of-region discovered/notified).
  r.post(
    "/admin/enforce-regions",
    wrap(async (req, res) => {
      const userId = uid(req);
      const prefs = (await getProfile(db, userId)).preferences;
      const policy = regionPolicyFromPrefs(prefs);
      const jobs = await listJobs(db, userId, { limit: 500 });
      let skipped = 0;
      let zeroed = 0;
      for (const job of jobs) {
        const region = checkJobRegion(job.location, job.description, policy);
        if (region.allowed) continue;
        await setRelevance(db, userId, job.id, 0, region.reason, { regionStatus: "out" });
        zeroed++;
        if (job.state === "discovered" || job.state === "notified" || job.state === "relevant") {
          await setJobState(db, userId, job.id, "skipped");
          skipped++;
        }
      }
      res.json({ ok: true, policy: policy.allowedRegions, zeroed, skipped });
    })
  );

  r.get(
    "/health",
    wrap(async (req, res) => {
      const userId = uid(req);
      res.json({
        ok: true,
        llmEnabled: llm.enabled,
        // Who this request resolved to — lets the dashboard show the signed-in
        // account and a sign-out link for switching between accounts.
        account: { id: userId, name: (await getUser(db, userId))?.name ?? "owner" },
        dataVersion: getDataVersion(),
        llm: getLlmHealth(),
        scheduler: { enabled: config.scheduler.enabled, cron: config.scheduler.cron, tz: config.scheduler.tz },
        routine: {
          enabled: config.routine.enabled,
          morningCron: config.routine.morningCron,
          eveningCron: config.routine.eveningCron,
        },
        discovery: {
          enabled: config.discovery.enabled,
          cron: config.discovery.cron,
          query: config.discovery.query,
          jsearchConfigured: !!config.discovery.jsearchApiKey,
          adzunaConfigured: !!(config.discovery.adzunaAppId && config.discovery.adzunaAppKey),
        },
        freshnessHours: config.freshness.hours,
        salaryFloor: { hybridCad: config.salary.floorHybridCad, remoteCad: config.salary.floorRemoteCad },
        db: await (async () => {
          const t0 = Date.now();
          try {
            await db.prepare("SELECT 1 AS ok").get();
            return { engine: db.engine, ok: true, latencyMs: Date.now() - t0 };
          } catch (err) {
            return { engine: db.engine, ok: false, error: (err as Error).message };
          }
        })(),
        poll: getPollStatus(),
        scoring: {
          ...(await cachedUnscoredJobsStats(userId)),
          running: isScoreBackfillRunning(),
          methods24h: await scoringMethodStats(db, userId, Date.now() - 24 * 3600 * 1000),
        },
        alerts: await collectAlerts(db, userId),
        lastPollRun: await lastPollRun(db, userId),
        lastDiscoveryRun: await lastDiscoveryRun(db),
        time: Date.now(),
      });
    })
  );

  // Bulk list triage (Scan this page). Deterministic knockouts + skill-fit, cached
  // by dedup key so re-scanning is instant and JDs are not re-fetched.
  const TriageRequestSchema = z.object({
    jobs: z.array(
      z.object({
        title: z.string(),
        company: z.string().nullish(),
        location: z.string().nullish(),
        description: z.string().nullish(),
        dedupKey: z.string().nullish(),
        url: z.string().nullish(),
        externalId: z.string().nullish(),
      })
    ),
    force: z.boolean().optional(),
    // When true, save strong/maybe matches into the job queue with their match score.
    persist: z.boolean().optional(),
    source: z.string().optional(),
  });

  r.post(
    "/jobs/triage",
    wrap(async (req, res) => {
      const body = TriageRequestSchema.parse(req.body);
      const { jobs, force } = body;
      const userId = uid(req);
      const scoringStarted = Date.now();
      const prefs = (await getProfile(db, userId)).preferences;
      const facts = computeMatchFacts(loadMasterProfile(userId), prefs);

      const results = new Array(jobs.length);
      const toCompute: { idx: number; key: string | null; hash: string | null; input: TriageInput }[] = [];

      for (const [idx, job] of jobs.entries()) {
        const key = job.dedupKey ?? null;
        const hash = triageJdHash(job.description);
        // Authoritative data wins: a request without a usable JD must neither repaint
        // nor overwrite a stored score that was produced WITH a description (the JD
        // backfill rescores persisted title-only cards within seconds — see jdBackfill).
        const stored = await storedTriageOverride(db, userId, body.source || "scan", job);
        if (stored) {
          results[idx] = stored;
          continue;
        }
        if (!force && key) {
          const cached = await getCachedTriage(db, userId, key);
          if (cached && cached.jdHash === hash) {
            results[idx] = cached.result;
            continue;
          }
        }
        toCompute.push({
          idx,
          key,
          hash,
          input: {
            title: job.title,
            company: job.company,
            location: job.location,
            description: job.description,
          },
        });
      }

      if (toCompute.length) {
        const computed = await triageJobs(
          llm,
          toCompute.map((t) => t.input),
          facts,
          prefs
        );
        for (const [i, result] of computed.entries()) {
          const t = toCompute[i]!;
          results[t.idx] = result;
          if (t.key) await putCachedTriage(db, userId, t.key, t.hash, result);
        }
      }

      // Optionally save the worth-a-look matches (strong/maybe) into the queue with
      // their match score, so they show up in the dashboard sorted by fit.
      let persisted = 0;
      if (body.persist) {
        const toSave = jobs
          .map((job, idx) => ({ job, result: results[idx] }))
          .filter(
            ({ job, result }) =>
              job.url && result && (result.verdict === "strong" || result.verdict === "maybe")
          );
        if (toSave.length) {
          const rawJobs: RawJob[] = toSave.map(({ job }) => ({
            source: body.source || "scan",
            sourceKind: "discovery",
            company: job.company ?? null,
            title: job.title,
            location: job.location ?? null,
            url: job.url!,
            externalId: job.externalId ?? null,
            description: job.description ?? null,
          }));
          const ingested = await ingestMany(db, userId, rawJobs);
          for (const [i, row] of ingested.entries()) {
            const r = toSave[i]!.result;
            // fromStore = the row's own score echoed back; re-stamping it would only
            // falsify scored_at (the ingest above already refreshed last_seen_at).
            if (r.fromStore) continue;
            await setRelevance(db, userId, row.id, r.score, `[${r.verdict}] ${r.reason}`.slice(0, 200), {
              method: "triage",
            });
          }
          persisted = ingested.length;
          await enqueueEligibleResumes(db, userId, { llm });
          // Push high matches persisted by THIS batch (scoredSince keeps older
          // unnotified backlog out — that's what POST /notify/publish is for).
          await notifyHighScoreJobs(db, userId, { scoredSince: scoringStarted });
          void backfillMissingJds(db, userId, { llm })
            .then(async (b) => {
              if (b.rescored > 0) {
                await enqueueEligibleResumes(db, userId, { llm });
                await notifyHighScoreJobs(db, userId, { scoredSince: scoringStarted });
              }
            })
            .catch((err) => console.warn("[jd-backfill] failed:", (err as Error).message));
        }
      }

      res.json({ yearsExperience: facts.yearsExperience, persisted, results });
    })
  );

  // Self-adapting scraper: DeepSeek synthesizes a stable extraction adapter for an
  // unknown job site from a compressed DOM digest. Cached per host; `force` regenerates.
  const SiteAdapterRequestSchema = z.object({
    host: z.string().min(1),
    digest: z.string().optional(),
    force: z.boolean().optional(),
  });

  r.post(
    "/scan/site-adapter",
    wrap(async (req, res) => {
      const { host, digest, force } = SiteAdapterRequestSchema.parse(req.body);
      if (!force) {
        const cached = await getSiteAdapter(db, host);
        if (cached) {
          res.json({ adapter: cached, cached: true });
          return;
        }
      }
      if (!digest || digest.length < 50) {
        throw new NotFoundError("no cached adapter and no digest provided to generate one");
      }
      if (!llm.enabled) {
        res.status(503).json({ error: "LLM not configured — cannot adapt this site" });
        return;
      }
      const adapter = await generateSiteAdapter(llm, host, digest);
      await putSiteAdapter(db, host, adapter);
      res.json({ adapter, cached: false });
    })
  );

  // Scan a whole LinkedIn Jobs search from any device (iPad / phone — no extension).
  // Re-runs the search against LinkedIn's public guest API, fetches each JD, triages
  // against your profile, and saves the strong/maybe matches into the queue.
  r.post(
    "/scan/linkedin-search",
    wrap(async (req, res) => {
      const { url, maxJobs, persist } = z
        .object({
          url: z.string().url(),
          maxJobs: z.number().optional(),
          persist: z.boolean().optional(),
        })
        .parse(req.body);

      const params = parseLinkedInSearch(url);
      if (!params) {
        res.status(400).json({ error: "Not a LinkedIn URL. Paste a LinkedIn Jobs search link." });
        return;
      }
      if (!params.keywords) {
        res
          .status(400)
          .json({ error: "That LinkedIn URL has no keyword. Open a Jobs search with a keyword, then copy its URL." });
        return;
      }

      const scanStarted = Date.now();
      // Default = first 3 LinkedIn pages (~25 jobs/page); guest API pages by 10
      // internally and hard-stops at 100.
      const cap = Math.min(Math.max(maxJobs ?? 75, 1), 100);
      const cards = await linkedinGuestSearch(params, cap);
      if (!cards.length) {
        res.json({ ok: true, scanned: 0, strong: 0, maybe: 0, persisted: 0, results: [] });
        return;
      }

      // Fetch each JD (bounded concurrency) so the triage LLM can arbitrate real matches.
      const withJd = await mapLimit(cards, 4, async (c) => {
        const r = await fetchJobFromUrl(c.url).catch(() => null);
        return { card: c, jd: r?.extracted.description ?? null };
      });

      const userId = uid(req);
      const prefs = (await getProfile(db, userId)).preferences;
      const facts = computeMatchFacts(loadMasterProfile(userId), prefs);
      const triaged = await triageJobs(
        llm,
        withJd.map((x) => ({
          title: x.card.title,
          company: x.card.company,
          location: x.card.location,
          description: x.jd,
        })),
        facts,
        prefs
      );

      let strong = 0;
      let maybe = 0;
      const toSave: { card: (typeof cards)[number]; jd: string | null; result: (typeof triaged)[number] }[] = [];
      triaged.forEach((result, i) => {
        if (result.verdict === "strong") strong++;
        else if (result.verdict === "maybe") maybe++;
        if ((persist ?? true) && (result.verdict === "strong" || result.verdict === "maybe")) {
          toSave.push({ card: withJd[i]!.card, jd: withJd[i]!.jd, result });
        }
      });

      let persisted = 0;
      if (toSave.length) {
        const rawJobs: RawJob[] = toSave.map(({ card, jd }) => ({
          source: "linkedin-scan",
          sourceKind: "discovery",
          company: card.company,
          title: card.title,
          location: card.location,
          url: card.url,
          externalId: card.externalId,
          description: jd,
        }));
        const ingested = await ingestMany(db, userId, rawJobs);
        for (const [i, row] of ingested.entries()) {
          const rr = toSave[i]!.result;
          await setRelevance(db, userId, row.id, rr.score, `[${rr.verdict}] ${rr.reason}`.slice(0, 200), {
            method: "triage",
          });
        }
        persisted = ingested.length;
        await notifyHighScoreJobs(db, userId, { scoredSince: scanStarted });
      }

      res.json({
        ok: true,
        scanned: cards.length,
        strong,
        maybe,
        persisted,
        results: triaged.map((r, i) => ({
          title: withJd[i]!.card.title,
          company: withJd[i]!.card.company,
          location: withJd[i]!.card.location,
          url: withJd[i]!.card.url,
          verdict: r.verdict,
          score: r.score,
          reason: r.reason,
        })),
      });
    })
  );

  // Auto-scan completion report (browser-driven LinkedIn watch). The extension's
  // alarm-triggered scan persists matches via /jobs/triage, then POSTs its summary
  // here; we record the run and Slack a digest of the newly persisted matches.
  const ScanReportSchema = z.object({
    source: z.string().default("linkedin-auto"),
    scanned: z.number().int().min(0).default(0),
    strong: z.number().int().min(0).default(0),
    maybe: z.number().int().min(0).default(0),
    persisted: z.number().int().min(0).default(0),
    cancelled: z.boolean().optional(),
    error: z.string().nullish(),
  });
  r.post(
    "/scan/report",
    wrap(async (req, res) => {
      const report = ScanReportSchema.parse(req.body ?? {});
      const userId = uid(req);
      const reportedAt = Date.now();
      // Window: everything triaged since the previous report (scan triage stamps
      // scored_at as it persists); notified_at dedup makes any overlap harmless.
      const prevRun = await lastScanRun(db, userId);
      const runId = await recordScanReport(db, userId, report);
      const push = await notifyHighScoreJobs(db, userId, {
        scoredSince: prevRun?.reported_at ?? reportedAt - freshnessMs(),
      });
      if (push.notified > 0) await setScanRunNotifications(db, runId, push.notified);
      const resumes = await enqueueEligibleResumes(db, userId, { llm });
      // Cards the scan couldn't read were persisted title-only with a capped score;
      // fetch their real JDs in the background, rescore, then notify/generate for
      // any that turn out to be genuine matches.
      void backfillMissingJds(db, userId, { llm })
        .then(async (b) => {
          if (b.rescored > 0) {
            await notifyHighScoreJobs(db, userId, { scoredSince: reportedAt });
            await enqueueEligibleResumes(db, userId, { llm });
          }
        })
        .catch((err) => console.warn("[jd-backfill] failed:", (err as Error).message));
      res.json({
        ok: true,
        runId,
        notified: push.notified,
        slackSent: push.sent,
        resumesEnqueued: resumes.enqueued,
      });
    })
  );

  // Fetch missing JDs and rescore now (also runs automatically after scans).
  r.post(
    "/jobs/backfill-jds",
    wrap(async (req, res) => {
      const limit = req.body?.limit ? Number(req.body.limit) : undefined;
      const userId = uid(req);
      const backfillStarted = Date.now();
      const result = await backfillMissingJds(db, userId, { llm, limit });
      let notified = 0;
      if (result.rescored > 0) {
        await enqueueEligibleResumes(db, userId, { llm });
        notified = (await notifyHighScoreJobs(db, userId, { scoredSince: backfillStarted })).notified;
      }
      res.json({ ok: true, ...result, notified });
    })
  );

  r.get(
    "/scan/last-run",
    wrap(async (req, res) => {
      res.json({ lastRun: (await lastScanRun(db, uid(req))) ?? null });
    })
  );

  // Explicit catch-up publish: batch-Slacks EVERY unnotified job at/above the notify
  // threshold for this account — no freshness or scored-at window — then stamps them
  // notified so neither this endpoint nor the auto-push ever re-sends them.
  r.post(
    "/notify/publish",
    wrap(async (req, res) => {
      const result = await notifyHighScoreJobs(db, uid(req));
      res.json({ ok: true, threshold: config.notify.threshold, ...result });
    })
  );

  // Manual score endpoint (handy for testing / re-scoring).
  r.post(
    "/jobs/rescore-fresh",
    wrap(async (req, res) => {
      const limit = req.body?.limit ? Number(req.body.limit) : undefined;
      const hours = req.body?.hours ? Number(req.body.hours) : undefined;
      const rescoreStarted = Date.now();
      const result = await rescoreFreshJobs(db, uid(req), { llm, limit, hours });
      const push = await notifyHighScoreJobs(db, uid(req), { scoredSince: rescoreStarted });
      res.json({ ...result, notified: push.notified });
    })
  );

  r.post(
    "/jobs/:id/score",
    wrap(async (req, res) => {
      const userId = uid(req);
      const job = await getJob(db, userId, req.params.id!);
      if (!job) throw new NotFoundError(`job ${req.params.id!}`);
      const prefs = (await getProfile(db, userId)).preferences;
      const { score, reason, method } = await scoreJob(
        llm,
        {
          title: job.title,
          company: job.company,
          location: job.location,
          description: job.description,
        },
        prefs,
        { candidateSkills: computeMatchFacts(loadMasterProfile(userId), prefs).skills }
      );
      await setRelevance(db, userId, job.id, score, reason, { method });
      res.json({ ...job, relevance_score: score, relevance_reason: reason, scored_by: method });
    })
  );

  return r;
}

