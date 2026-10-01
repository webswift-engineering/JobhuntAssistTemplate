/**
 * Two-account isolation (owner = user 1 + a second "data" account).
 * Each user has a fully separate pool: jobs, captures, profile, triage cache.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./helpers.js";
import type { DB } from "../src/db/client.js";
import {
  ingestJob,
  getJob,
  listJobs,
  setJobState,
  getProfile,
  setProfile,
  tabBadgeCounts,
} from "../src/store.js";
import { recordPageCapture, listCaptures, activityStats } from "../src/captures.js";
import { getCachedTriage, putCachedTriage } from "../src/triageStore.js";
import { ensureOwnerUser, createUser, findUserByToken, userWebhook, listUsers } from "../src/users.js";
import type { RawJob } from "../src/types.js";

const posting: RawJob = {
  source: "linkedin-scan",
  sourceKind: "discovery",
  company: "Acme",
  title: "Data Analyst",
  location: "Toronto, ON",
  url: "https://example.com/jobs/123",
  externalId: "123",
  description: "SQL, Python, dashboards",
};

describe("two-account isolation", () => {
  let db: DB;

  beforeEach(async () => {
    db = createTestDb();
    await ensureOwnerUser(db);
  });

  it("same posting captured by both users creates two rows with distinct ids", async () => {
    const a = await ingestJob(db, 1, posting);
    const b = await ingestJob(db, 2, posting);
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(true);
    expect(a.dedupKey).toBe(b.dedupKey); // same content → same dedup key…
    expect(a.id).not.toBe(b.id); // …but ids are salted per user (no collision)
    // Re-ingesting for the same user dedupes as before.
    const again = await ingestJob(db, 2, posting);
    expect(again.isNew).toBe(false);
    expect(again.id).toBe(b.id);
  });

  it("users only see their own jobs in list/get/badge counts", async () => {
    await ingestJob(db, 1, posting);
    await ingestJob(db, 1, { ...posting, title: "Platform Engineer", url: "https://example.com/jobs/321", externalId: "321" });
    const theirs = await ingestJob(db, 2, { ...posting, title: "BI Developer", url: "https://example.com/jobs/456", externalId: "456" });

    const mine = await listJobs(db, 1, { limit: 100 });
    expect(mine.length).toBe(2);
    expect(mine.every((j) => j.user_id === 1)).toBe(true);
    expect(mine.some((j) => j.id === theirs.id)).toBe(false);
    expect((await listJobs(db, 2, { limit: 100 })).length).toBe(1);

    // Cross-user getJob is a miss even with a valid id.
    expect(await getJob(db, 1, theirs.id)).toBeUndefined();
    expect(await getJob(db, 2, theirs.id)).toBeDefined();

    expect((await tabBadgeCounts(db, 1)).queue).toBe(2);
    expect((await tabBadgeCounts(db, 2)).queue).toBe(1);
  });

  it("cross-user state changes are rejected (job not found)", async () => {
    const a = await ingestJob(db, 1, posting);
    await expect(setJobState(db, 2, a.id, "relevant")).rejects.toThrow(/not found|job/i);
    expect((await getJob(db, 1, a.id))!.state).toBe("discovered");
  });

  it("profiles are per user", async () => {
    await setProfile(db, 1, { masterResume: "owner resume", preferences: { keywords: ["java"] } });
    await setProfile(db, 2, { masterResume: "data resume", preferences: { keywords: ["sql"] } });
    expect((await getProfile(db, 1)).masterResume).toBe("owner resume");
    expect((await getProfile(db, 2)).masterResume).toBe("data resume");
    expect((await getProfile(db, 2)).preferences.keywords).toEqual(["sql"]);
  });

  it("captures and activity stats are per user", async () => {
    await recordPageCapture(db, 2, {
      url: "https://example.com/jobs/789",
      source: "extension",
      rawText: "x".repeat(300),
      title: "Analytics Engineer",
      company: "Beta",
    });
    expect((await listCaptures(db, 1, 50)).length).toBe(0);
    expect((await listCaptures(db, 2, 50)).length).toBe(1);

    const s1 = await activityStats(db, 1);
    const s2 = await activityStats(db, 2);
    expect(s2).not.toEqual(s1);
  });

  it("triage cache verdicts are per user (same dedup key, different prefs)", async () => {
    const result = { verdict: "strong", score: 0.9, reason: "fits", knockouts: [] } as never;
    await putCachedTriage(db, 2, "k1", "h1", result);
    expect(await getCachedTriage(db, 1, "k1")).toBeNull();
    const hit = await getCachedTriage(db, 2, "k1");
    expect(hit?.jdHash).toBe("h1");
  });
});

describe("accounts and tokens", () => {
  let db: DB;

  beforeEach(async () => {
    db = createTestDb();
    await ensureOwnerUser(db);
  });

  it("owner is seeded as user 1", async () => {
    const users = await listUsers(db);
    expect(users[0]?.id).toBe(1);
    expect(users[0]?.name).toBe("owner");
  });

  it("createUser returns a raw token that resolves back to that user (and only that user)", async () => {
    const { user, token } = await createUser(db, "alice", { slackWebhookUrl: "https://hooks.slack.com/services/T/DATA" });
    expect(user.id).toBe(2);
    expect(user.token_hash).not.toBe(token); // stored hashed, never raw

    const resolved = await findUserByToken(db, token);
    expect(resolved?.id).toBe(2);
    expect(await findUserByToken(db, "wrong-token")).toBeUndefined();
    expect(await findUserByToken(db, "")).toBeUndefined();
  });

  it("per-user Slack webhook: the second user's channel from the user row, owner falls back to env", async () => {
    const { user } = await createUser(db, "alice", { slackWebhookUrl: "https://hooks.slack.com/services/T/DATA" });
    expect(await userWebhook(db, user.id)).toBe("https://hooks.slack.com/services/T/DATA");
    // A non-owner without a webhook gets none (never leaks into the owner channel).
    const { user: third } = await createUser(db, "third");
    expect(await userWebhook(db, third.id)).toBe("");
  });
});
