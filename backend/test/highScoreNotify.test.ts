import { describe, it, expect, beforeEach } from "vitest";
import type { DB } from "../src/db/client.js";
import { createTestDb } from "./helpers.js";
import { setProfile, ingestJob, setRelevance, getJob, setJobState } from "../src/store.js";
import { notifyHighScoreJobs } from "../src/highScoreNotify.js";
import type { RawJob } from "../src/types.js";

const H = 3600 * 1000;

function job(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: "linkedin",
    sourceKind: "discovery",
    company: "Acme",
    title: "Backend Engineer",
    url: "https://www.linkedin.com/jobs/view/123",
    externalId: "123",
    description: "java kotlin backend services",
    ...overrides,
  };
}

/** Fake Slack send — records messages, never touches the network. */
function fakeSlack(ok = true) {
  const sent: { text: string; webhook: string }[] = [];
  const sendFn = async (text: string, webhook: string) => {
    sent.push({ text, webhook });
    return ok;
  };
  return { sent, sendFn };
}

describe("notifyHighScoreJobs (the one high-match Slack push)", () => {
  let db: DB;
  beforeEach(async () => {
    db = createTestDb();
    await setProfile(db, 1, { preferences: { titles: ["Backend Engineer"], keywords: ["java"] } });
  });

  it("batches all unnotified jobs >= threshold into one message and stamps notified_at", async () => {
    const a = await ingestJob(db, 1, job({ externalId: "a", url: "https://x/a", title: "Job A" }));
    const b = await ingestJob(db, 1, job({ externalId: "b", url: "https://x/b", title: "Job B" }));
    await setRelevance(db, 1, a.id, 0.85, "strong", { method: "triage" });
    await setRelevance(db, 1, b.id, 0.8, "strong", { method: "triage" });

    const slack = fakeSlack();
    const res = await notifyHighScoreJobs(db, 1, { dashboardUrl: "http://d", sendFn: slack.sendFn });

    expect(res).toEqual({ matched: 2, notified: 2, sent: true });
    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]!.text).toContain("2 high-match FTE job(s)");
    expect(slack.sent[0]!.text).toContain("Job A");
    expect(slack.sent[0]!.text).toContain("http://d/?job=" + a.id);
    expect((await getJob(db, 1, a.id))!.notified_at).not.toBeNull();
    expect((await getJob(db, 1, a.id))!.state).toBe("notified");

    // Never re-sent: publish and auto-push both see notified_at as the source of truth.
    const again = await notifyHighScoreJobs(db, 1, { sendFn: slack.sendFn });
    expect(again.matched).toBe(0);
    expect(slack.sent).toHaveLength(1);
  });

  it("ignores jobs below the raised default threshold (0.78)", async () => {
    const { id } = await ingestJob(db, 1, job());
    await setRelevance(db, 1, id, 0.72, "would have pinged at the old 0.7 bar", { method: "triage" });

    const slack = fakeSlack();
    const res = await notifyHighScoreJobs(db, 1, { sendFn: slack.sendFn });
    expect(res.matched).toBe(0);
    expect(slack.sent).toHaveLength(0);
  });

  it("FTE gate: contract / part-time / intern rows never ping, even at 0.99", async () => {
    const contract = await ingestJob(
      db,
      1,
      job({ externalId: "c", url: "https://x/c", title: "Java Contractor (6 Month Contract)" })
    );
    const partTime = await ingestJob(
      db,
      1,
      job({ externalId: "p", url: "https://x/p", title: "Part-Time Backend Developer" })
    );
    await setRelevance(db, 1, contract.id, 0.99, "great match, wrong shape", { method: "triage" });
    await setRelevance(db, 1, partTime.id, 0.9, "strong", { method: "triage" });

    const slack = fakeSlack();
    const res = await notifyHighScoreJobs(db, 1, { sendFn: slack.sendFn });
    expect(res.matched).toBe(0);
    expect(slack.sent).toHaveLength(0);
    // Still visible on the dashboard (state untouched, no notified_at).
    expect((await getJob(db, 1, contract.id))!.state).toBe("discovered");
    expect((await getJob(db, 1, contract.id))!.notified_at).toBeNull();
  });

  it("unknown employment type pings but carries the `type?` flag", async () => {
    // job() description has no employment signal → classified 'unknown' at ingest.
    const { id } = await ingestJob(db, 1, job());
    expect((await getJob(db, 1, id))!.employment_type).toBe("unknown");
    await setRelevance(db, 1, id, 0.9, "strong", { method: "triage" });

    const slack = fakeSlack();
    const res = await notifyHighScoreJobs(db, 1, { sendFn: slack.sendFn });
    expect(res.notified).toBe(1);
    expect(slack.sent[0]!.text).toContain("type?");
  });

  it("explicit full-time rows ping without the `type?` flag", async () => {
    const { id } = await ingestJob(
      db,
      1,
      job({ description: "java backend services. This is a full-time position." })
    );
    expect((await getJob(db, 1, id))!.employment_type).toBe("full_time");
    await setRelevance(db, 1, id, 0.9, "strong", { method: "triage" });

    const slack = fakeSlack();
    await notifyHighScoreJobs(db, 1, { sendFn: slack.sendFn });
    expect(slack.sent[0]!.text).not.toContain("type?");
  });

  it("target-company boost: qualifies at the lower bar and is flagged", async () => {
    await setProfile(db, 1, {
      preferences: {
        titles: ["Backend Engineer"],
        keywords: ["java"],
        targetCompanies: ["Stripe"],
      },
    });
    const target = await ingestJob(
      db,
      1,
      job({ externalId: "t", url: "https://x/t", company: "Stripe", title: "Stripe Job" })
    );
    const other = await ingestJob(
      db,
      1,
      job({ externalId: "o", url: "https://x/o", company: "OtherCo", title: "Other Job" })
    );
    // Both below the 0.78 main bar but above the 0.65 target bar.
    await setRelevance(db, 1, target.id, 0.7, "decent", { method: "triage" });
    await setRelevance(db, 1, other.id, 0.7, "decent", { method: "triage" });

    const slack = fakeSlack();
    const res = await notifyHighScoreJobs(db, 1, { sendFn: slack.sendFn });
    expect(res.notified).toBe(1);
    expect(slack.sent[0]!.text).toContain("Stripe Job");
    expect(slack.sent[0]!.text).not.toContain("Other Job");
    expect(slack.sent[0]!.text).toContain("target");
  });

  it("scoredSince restricts the auto-push to jobs scored in the triggering run", async () => {
    const old = await ingestJob(db, 1, job({ externalId: "old", url: "https://x/old" }));
    await setRelevance(db, 1, old.id, 0.9, "backlog", { method: "triage" });
    // Backlog: scored an hour before this run started.
    await db.prepare("UPDATE jobs SET scored_at = ? WHERE id = ?").run(Date.now() - 1 * H, old.id);

    const runStart = Date.now() - 1000;
    const fresh = await ingestJob(db, 1, job({ externalId: "new", url: "https://x/new", title: "Fresh" }));
    await setRelevance(db, 1, fresh.id, 0.8, "just scored", { method: "triage" });

    const slack = fakeSlack();
    const res = await notifyHighScoreJobs(db, 1, { scoredSince: runStart, sendFn: slack.sendFn });
    expect(res.notified).toBe(1);
    expect(slack.sent[0]!.text).toContain("Fresh");
    expect((await getJob(db, 1, old.id))!.notified_at).toBeNull();

    // The explicit publish (no scoredSince) then catches the backlog.
    const publish = await notifyHighScoreJobs(db, 1, { sendFn: slack.sendFn });
    expect(publish.notified).toBe(1);
    expect((await getJob(db, 1, old.id))!.notified_at).not.toBeNull();
  });

  it("auto-push also requires freshness; publish ignores it", async () => {
    const { id } = await ingestJob(db, 1, job());
    await setRelevance(db, 1, id, 0.9, "strong", { method: "triage" });
    const old = Date.now() - 30 * 24 * H;
    // Stale posting, but scored just now.
    await db.prepare("UPDATE jobs SET first_seen_at = ?, posted_at = ? WHERE id = ?").run(old, old, id);

    const slack = fakeSlack();
    const auto = await notifyHighScoreJobs(db, 1, {
      scoredSince: Date.now() - 1000,
      sendFn: slack.sendFn,
    });
    expect(auto.matched).toBe(0);

    const publish = await notifyHighScoreJobs(db, 1, { sendFn: slack.sendFn });
    expect(publish.notified).toBe(1);
  });

  it("skips out-of-region jobs", async () => {
    const { id } = await ingestJob(db, 1, job({ location: "London, UK" }));
    await setRelevance(db, 1, id, 0.9, "strong", { method: "triage", regionStatus: "out" });

    const slack = fakeSlack();
    const res = await notifyHighScoreJobs(db, 1, { sendFn: slack.sendFn });
    expect(res.matched).toBe(0);
  });

  it("skips applied/skipped/already-notified jobs", async () => {
    const a = await ingestJob(db, 1, job({ externalId: "a", url: "https://x/a" }));
    const b = await ingestJob(db, 1, job({ externalId: "b", url: "https://x/b" }));
    await setRelevance(db, 1, a.id, 0.9, "strong", { method: "triage" });
    await setRelevance(db, 1, b.id, 0.9, "strong", { method: "triage" });
    await setJobState(db, 1, a.id, "applied");
    await setJobState(db, 1, b.id, "skipped");

    const slack = fakeSlack();
    const res = await notifyHighScoreJobs(db, 1, { sendFn: slack.sendFn });
    expect(res.matched).toBe(0);
  });

  it("caps the list at 20 lines and folds the rest into '+N more'", async () => {
    for (let i = 0; i < 25; i++) {
      const { id } = await ingestJob(db, 1, job({ externalId: `j${i}`, url: `https://x/${i}`, title: `Job ${i}` }));
      await setRelevance(db, 1, id, 0.8 + i / 1000, "strong", { method: "triage" });
    }

    const slack = fakeSlack();
    const res = await notifyHighScoreJobs(db, 1, { sendFn: slack.sendFn });
    expect(res.notified).toBe(25);
    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]!.text).toContain("25 high-match FTE job(s)");
    expect(slack.sent[0]!.text).toContain("+5 more");
    // 20 deep links, not 25.
    expect(slack.sent[0]!.text.match(/\?job=/g)).toHaveLength(20);
    // But ALL 25 are stamped so the next publish is empty.
    expect((await notifyHighScoreJobs(db, 1, { sendFn: slack.sendFn })).matched).toBe(0);
  });

  it("leaves notified_at NULL when the Slack send fails, so a later publish retries", async () => {
    const { id } = await ingestJob(db, 1, job());
    await setRelevance(db, 1, id, 0.9, "strong", { method: "triage" });

    const failing = fakeSlack(false);
    const res = await notifyHighScoreJobs(db, 1, { sendFn: failing.sendFn });
    expect(res).toEqual({ matched: 1, notified: 0, sent: false });
    expect((await getJob(db, 1, id))!.notified_at).toBeNull();

    const working = fakeSlack(true);
    expect((await notifyHighScoreJobs(db, 1, { sendFn: working.sendFn })).notified).toBe(1);
  });

  it("respects a custom threshold", async () => {
    const { id } = await ingestJob(db, 1, job());
    await setRelevance(db, 1, id, 0.5, "meh", { method: "triage" });

    const slack = fakeSlack();
    expect((await notifyHighScoreJobs(db, 1, { threshold: 0.4, sendFn: slack.sendFn })).notified).toBe(1);
  });

  it("does not re-send jobs another path already stamped notified", async () => {
    const { id } = await ingestJob(db, 1, job());
    await setRelevance(db, 1, id, 0.9, "strong", { method: "triage" });
    await setJobState(db, 1, id, "notified"); // e.g. manual PATCH — stamps notified_at

    const slack = fakeSlack();
    expect((await notifyHighScoreJobs(db, 1, { sendFn: slack.sendFn })).matched).toBe(0);
  });

  it("is per-user: user 2's jobs never leak into user 1's publish", async () => {
    await setProfile(db, 2, { preferences: { titles: ["Backend Engineer"], keywords: ["java"] } });
    const mine = await ingestJob(db, 1, job({ externalId: "a", url: "https://x/a" }));
    const hers = await ingestJob(db, 2, job({ externalId: "b", url: "https://x/b" }));
    await setRelevance(db, 1, mine.id, 0.9, "strong", { method: "triage" });
    await setRelevance(db, 2, hers.id, 0.9, "strong", { method: "triage" });

    const slack = fakeSlack();
    expect((await notifyHighScoreJobs(db, 1, { sendFn: slack.sendFn })).notified).toBe(1);
    expect((await getJob(db, 2, hers.id))!.notified_at).toBeNull();
    expect((await notifyHighScoreJobs(db, 2, { sendFn: slack.sendFn })).notified).toBe(1);
  });
});
