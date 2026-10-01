/**
 * In-memory monotonic counter exposed via GET /health. Bumped whenever
 * user-visible data changes server-side (new jobs, state changes, captures,
 * résumé artifacts) so the dashboard's status poller can detect that its view
 * is stale and re-render — regardless of which path (poll, extension capture,
 * triage persist, scan report, discovery) produced the change.
 */
let version = 1;

export function bumpDataVersion(): void {
  version++;
}

export function getDataVersion(): number {
  return version;
}
