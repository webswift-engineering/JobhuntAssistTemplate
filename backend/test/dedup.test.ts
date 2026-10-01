import { describe, it, expect } from "vitest";
import { dedupKey } from "../src/dedup.js";

describe("dedup (§12)", () => {
  it("uses source:externalId when externalId present", () => {
    expect(
      dedupKey({ source: "greenhouse", externalId: "123", company: "Acme", title: "Eng", location: "NY" })
    ).toBe("greenhouse:123");
  });

  it("falls back to fuzzy key when no externalId", () => {
    const k = dedupKey({ source: "indeed", company: "Acme Inc.", title: "Software Engineer", location: "New York, NY" });
    expect(k.startsWith("fuzzy:")).toBe(true);
  });

  it("fuzzy key is stable across punctuation/case/whitespace", () => {
    const a = dedupKey({ source: "indeed", company: "Acme, Inc.", title: "Software  Engineer", location: "New York" });
    const b = dedupKey({ source: "linkedin", company: "acme inc", title: "software engineer", location: "new-york" });
    expect(a).toBe(b); // cross-source fuzzy collapse
  });

  it("different titles produce different fuzzy keys", () => {
    const a = dedupKey({ source: "indeed", company: "Acme", title: "Frontend", location: "NY" });
    const b = dedupKey({ source: "indeed", company: "Acme", title: "Backend", location: "NY" });
    expect(a).not.toBe(b);
  });
});
