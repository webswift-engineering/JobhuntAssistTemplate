import { describe, it, expect } from "vitest";
import { canTransition, assertTransition, InvalidTransitionError } from "../src/state.js";

describe("state machine (§5)", () => {
  it("allows discovered → relevant → notified → applied", () => {
    expect(canTransition("discovered", "relevant")).toBe(true);
    expect(canTransition("relevant", "notified")).toBe(true);
    expect(canTransition("notified", "applied")).toBe(true);
  });

  it("allows skip from any non-applied state", () => {
    expect(canTransition("discovered", "skipped")).toBe(true);
    expect(canTransition("relevant", "skipped")).toBe(true);
    expect(canTransition("notified", "skipped")).toBe(true);
  });

  it("allows un-skip (skipped → relevant)", () => {
    expect(canTransition("skipped", "relevant")).toBe(true);
  });

  it("applied is terminal", () => {
    expect(canTransition("applied", "relevant")).toBe(false);
    expect(canTransition("applied", "skipped")).toBe(false);
    expect(() => assertTransition("applied", "relevant")).toThrow(InvalidTransitionError);
  });

  it("notified is idempotent (no double-act)", () => {
    expect(canTransition("notified", "notified")).toBe(true);
  });

  it("rejects skipped → applied directly", () => {
    expect(canTransition("skipped", "applied")).toBe(false);
  });
});
