import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb } from "./helpers.js";
import { ingestJob, setProfile } from "../src/store.js";
import { resumeSlug, resumeDir, writeArtifact, listArtifacts, readArtifact } from "../src/render/resumeStore.js";
import type { JobRow } from "../src/types.js";

describe("resumeStore", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jc-resume-"));
    process.env.RESUME_DIR = tmpDir;
    db = createTestDb();
    await setProfile(db, 1, {
      masterResume: "SUMMARY\nEngineer\n\nSKILLS\n- Java",
    });
    await ingestJob(db, 1, {
      source: "linkedin",
      sourceKind: "extension",
      company: "Acme Corp",
      title: "Backend Engineer",
      url: "https://example.com/j/1",
      externalId: "999",
      description: "Java role",
    });
  });

  afterEach(() => {
    delete process.env.RESUME_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("slug is deterministic per job", async () => {
    const job = (await db.prepare("SELECT * FROM jobs LIMIT 1").get()) as {
      id: string;
      user_id: number;
      company: string;
      title: string;
    };
    expect(resumeSlug(job)).toMatch(/^acme-corp-backend-engineer-[a-f0-9]{8}$/);
    expect(resumeDir(job)).toContain(resumeSlug(job));
  });

  it("writeArtifact upserts and readArtifact round-trips", async () => {
    const job = (await db.prepare("SELECT * FROM jobs LIMIT 1").get()) as JobRow;
    const a1 = await writeArtifact(db, job, "txt", "hello resume");
    const a2 = await writeArtifact(db, job, "txt", "updated resume");
    expect(a1.path).toBe(a2.path);
    expect((await readArtifact(db, job.id, "txt"))?.toString()).toBe("updated resume");
    expect((await listArtifacts(db, job.id)).length).toBe(1);
  });
});
