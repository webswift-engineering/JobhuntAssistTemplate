import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stageToOutbox } from "../src/render/resumeStore.js";
import type { JobRow } from "../src/types.js";

const job = (over: Partial<JobRow> = {}): JobRow =>
  ({ id: "abc123def456", company: "Acme Corp", title: "Backend Engineer", ...over }) as JobRow;

describe("stageToOutbox (Copilot fixed-folder résumé staging)", () => {
  it("writes the PDF as the ONLY file, replacing any previous staging", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jh-outbox-"));
    try {
      const f1 = stageToOutbox(job(), Buffer.from("pdf-one"), dir);
      expect(f1).toBe("acme-corp-backend-engineer.pdf");
      expect(fs.readdirSync(dir)).toEqual([f1]);

      // Stage a DIFFERENT job: old file must be gone — one file, always.
      const f2 = stageToOutbox(
        job({ id: "ffff0000aaaa", company: "Globex", title: "Platform Engineer" }),
        Buffer.from("pdf-two"),
        dir
      );
      expect(fs.readdirSync(dir)).toEqual([f2]);
      expect(fs.readFileSync(path.join(dir, f2), "utf8")).toBe("pdf-two");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the outbox dir when it does not exist yet", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "jh-outbox-"));
    const dir = path.join(base, "nested", "outbox");
    try {
      const f = stageToOutbox(job(), Buffer.from("x"), dir);
      expect(fs.existsSync(path.join(dir, f))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
