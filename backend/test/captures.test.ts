import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers.js";
import { recordPageCapture, listCaptures } from "../src/captures.js";
import { setProfile } from "../src/store.js";

describe("page captures", () => {
  it("stores full JD, salary, and lists for dashboard", async () => {
    const db = createTestDb();
    await setProfile(db, 1, { masterResume: "SUMMARY\nEngineer" });
    const jd = "About the job\n".repeat(500);
    const { jobId } = await recordPageCapture(db, 1, {
      url: "https://www.linkedin.com/jobs/view/123/",
      source: "linkedin",
      title: "AI Developer",
      company: "Accenture",
      location: "Toronto, ON",
      externalId: "123",
      rawText: jd,
      salaryText: "$90,850 to $140,850",
      captureKind: "right_click",
    });
    expect(jobId).toBeTruthy();
    const rows = await listCaptures(db, 1);
    expect(rows.length).toBe(1);
    expect(rows[0].salary_text).toBe("$90,850 to $140,850");
    expect(rows[0].raw_text.length).toBeGreaterThan(1000);
    expect(rows[0].company).toBe("Accenture");
  });

  it("re-capture same job updates row instead of duplicating list", async () => {
    const db = createTestDb();
    await recordPageCapture(db, 1, {
      url: "https://linkedin.com/jobs/view/1/",
      source: "linkedin",
      title: "Dev",
      company: "Acme",
      rawText: "first capture",
      externalId: "1",
    });
    await recordPageCapture(db, 1, {
      url: "https://linkedin.com/jobs/view/1/",
      source: "linkedin",
      title: "Dev",
      company: "Acme",
      rawText: "second capture longer text here",
      externalId: "1",
    });
    const rows = await listCaptures(db, 1);
    expect(rows.length).toBe(1);
    expect(rows[0].raw_text).toContain("second capture");
  });
});
