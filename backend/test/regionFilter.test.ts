import { describe, it, expect } from "vitest";
import { checkJobRegion, regionPolicyFromPrefs } from "../src/regionFilter.js";

const US_CA = regionPolicyFromPrefs({ allowedRegions: ["US", "CA"] });

describe("regionFilter (US + Canada only)", () => {
  it("allows Toronto and US locations", () => {
    expect(checkJobRegion("Toronto, CAN-Remote", null, US_CA).allowed).toBe(true);
    expect(checkJobRegion("San Francisco, CA", null, US_CA).allowed).toBe(true);
    expect(checkJobRegion("US", null, US_CA).allowed).toBe(true);
    expect(checkJobRegion("Chicago, US-Remote, Toronto", null, US_CA).allowed).toBe(true);
  });

  it("allows bare Remote", () => {
    expect(checkJobRegion("Remote", null, US_CA).allowed).toBe(true);
    expect(checkJobRegion("Hybrid Remote", null, US_CA).allowed).toBe(true);
  });

  it("blocks clear non-US/CA locations", () => {
    expect(checkJobRegion("Dublin, Ireland", null, US_CA).allowed).toBe(false);
    expect(checkJobRegion("London, UK", null, US_CA).allowed).toBe(false);
    expect(checkJobRegion("Singapore", null, US_CA).allowed).toBe(false);
    expect(checkJobRegion("Bangalore, India", null, US_CA).allowed).toBe(false);
    expect(checkJobRegion("Berlin, Germany", null, US_CA).allowed).toBe(false);
  });

  it("blocks Remote when description is clearly international", () => {
    expect(
      checkJobRegion("Remote", "Must be based in Dublin, Ireland office.", US_CA).allowed
    ).toBe(false);
  });

  it("defaults to US+CA when allowedRegions unset", () => {
    expect(regionPolicyFromPrefs({}).allowedRegions).toEqual(["US", "CA"]);
  });
});
