import type { JobState } from "./types.js";

/**
 * State machine (§5), server-enforced. Invalid transition → caller returns 409.
 *
 *   discovered → relevant → notified → applied
 *        │           │          │
 *        └───────────┴──────────┴──► skipped   (skip from any non-applied)
 *   skipped → relevant   (un-skip)
 *   applied  = terminal
 */
const TRANSITIONS: Record<JobState, JobState[]> = {
  discovered: ["relevant", "notified", "applied", "skipped"],
  relevant: ["notified", "applied", "skipped"],
  notified: ["relevant", "applied", "skipped"],
  applied: [], // terminal
  skipped: ["relevant"],
};

export class InvalidTransitionError extends Error {
  constructor(from: JobState, to: JobState) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: JobState, to: JobState): boolean {
  if (from === to) return true; // idempotent (notified→notified never double-acts)
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}
