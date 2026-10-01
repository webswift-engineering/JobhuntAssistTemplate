import { describe, it, expect } from "vitest";
import { buildApplyFields } from "../src/profile/applyFields.js";
import type { MasterProfile } from "../src/profile/masterProfile.js";

const profile = {
  contact: {
    name: "Jane Roe",
    email: "x@y.com",
    phone: "+1-555-000-1111",
    location: "Toronto, ON, Canada",
    links: ["https://janeroe.example", "https://www.linkedin.com/in/janeroe/"],
  },
  experience: [],
} as unknown as MasterProfile;

describe("buildApplyFields", () => {
  it("splits name on last space and classifies links by host", () => {
    const f = buildApplyFields(profile, {});
    expect(f.firstName).toBe("Jane");
    expect(f.lastName).toBe("Roe");
    expect(f.linkedinUrl).toContain("linkedin.com");
    expect(f.websiteUrl).toBe("https://janeroe.example");
  });

  it("normalizes screening-answer keys for label matching", () => {
    const f = buildApplyFields(profile, {
      "Are you legally authorized to work in Canada?": "Yes",
      "Salary  Expectations": "Market rate for the role",
    });
    expect(f.answers["are you legally authorized to work in canada"]).toBe("Yes");
    expect(f.answers["salary expectations"]).toBe("Market rate for the role");
  });

  it("degrades to empty fields with no profile", () => {
    const f = buildApplyFields(null, {});
    expect(f.firstName).toBe("");
    expect(f.answers).toEqual({});
  });
});
