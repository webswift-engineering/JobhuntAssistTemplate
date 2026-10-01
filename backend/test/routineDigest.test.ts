import { describe, it, expect } from "vitest";
import { resolveSearchLinks } from "../src/routineDigest.js";

describe("resolveSearchLinks", () => {
  it("uses profile searchLinks when set", () => {
    const links = resolveSearchLinks({
      searchLinks: {
        linkedin: "https://linkedin.com/my-search",
        indeed: "https://indeed.com/my-search",
      },
    });
    expect(links.linkedin).toBe("https://linkedin.com/my-search");
    expect(links.indeed).toBe("https://indeed.com/my-search");
  });

  it("falls back to built defaults", () => {
    const links = resolveSearchLinks({ titles: ["Backend Engineer"], locations: ["Toronto"] });
    expect(links.linkedin).toContain("Backend");
    expect(links.linkedin).toContain("f_TPR=r86400");
  });
});

// sendRoutineDigest returns {sent,text} — with no webhook configured sent=false but
// the text is still built, so its queue lines are testable against a real test DB.
import { createTestDb } from "./helpers.js";
import { sendRoutineDigest } from "./../src/routineDigest.js";
import { setProfile, ingestJob, setRelevance } from "../src/store.js";
import { config } from "../src/config.js";

describe("routine digest queue lines", () => {
  it("counts ready-to-apply jobs (resume ✓, FTE-probable, ≥ notify bar)", async () => {
    const db = createTestDb();
    await setProfile(db, 1, { preferences: { titles: ["Backend Engineer"], keywords: ["java"] } });
    const ready = await ingestJob(db, 1, {
      source: "greenhouse", sourceKind: "ats", company: "Acme",
      title: "Backend Engineer", url: "https://x/ready", externalId: "r",
      description: "java. This is a full-time position.",
    });
    await setRelevance(db, 1, ready.id, config.notify.threshold + 0.05, "strong", { method: "triage" });
    await db.prepare(
      "INSERT INTO resume_artifacts (job_id, format, path, bytes, generated_at) VALUES (?, 'pdf', 'x.pdf', 1, ?)"
    ).run(ready.id, Date.now());
    // High match but NO resume yet -> not counted.
    const noResume = await ingestJob(db, 1, {
      source: "greenhouse", sourceKind: "ats", company: "Acme",
      title: "Backend Engineer 2", url: "https://x/nores", externalId: "n",
      description: "java. Full-time role.",
    });
    await setRelevance(db, 1, noResume.id, 0.9, "strong", { method: "triage" });

    const { text } = await sendRoutineDigest(db, 1, "morning");
    expect(text).toContain("1 ready to apply");
    expect(text).toContain("/apply next");
  });

  it("omits the ready-to-apply line when nothing is ready", async () => {
    const db = createTestDb();
    await setProfile(db, 1, { preferences: { titles: ["Backend Engineer"], keywords: ["java"] } });
    const { text } = await sendRoutineDigest(db, 1, "evening");
    expect(text).not.toContain("ready to apply");
  });
});
