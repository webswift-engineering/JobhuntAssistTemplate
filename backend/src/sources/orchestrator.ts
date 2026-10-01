import type { CompanyRow, RawJob } from "../types.js";
import type { AtsAdapter } from "./AtsAdapter.js";
import { sleep } from "./AtsAdapter.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { ashbyAdapter } from "./ashby.js";
import { workdayAdapter } from "./workday.js";
import { oracleAdapter } from "./oracle.js";

export const ADAPTERS: Record<string, AtsAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  workday: workdayAdapter,
  oracle: oracleAdapter,
};

export interface OrchestratorResult {
  jobs: RawJob[];
  companiesPolled: number;
  errors: Record<string, string>; // "company (ats)" → message
}

/**
 * Run all enabled companies' adapters. Fail soft: an adapter error logs into
 * `errors` and contributes [] — one bad company never sinks the run (§6.1).
 */
export async function pollAll(
  companies: CompanyRow[],
  opts: { perHostDelayMs?: number } = {}
): Promise<OrchestratorResult> {
  const delay = opts.perHostDelayMs ?? 800;
  const jobs: RawJob[] = [];
  const errors: Record<string, string> = {};
  let polled = 0;

  for (const c of companies) {
    const adapter = ADAPTERS[c.ats];
    const label = `${c.name} (${c.ats})`;
    if (!adapter) {
      errors[label] = `No adapter for ats '${c.ats}'`;
      continue;
    }
    try {
      const fetched = await adapter.fetchJobs({ name: c.name, boardToken: c.board_token });
      jobs.push(...fetched);
      polled++;
    } catch (err) {
      errors[label] = err instanceof Error ? err.message : String(err);
    }
    await sleep(delay);
  }

  return { jobs, companiesPolled: polled, errors };
}
