/**
 * Live probe all ATS companies — hiring board health (may take several minutes).
 * Run: node scripts/validate-companies.mjs
 */
const B = "http://127.0.0.1:8787";
console.log("Probing all ATS boards (this may take a few minutes)…");
const res = await fetch(`${B}/admin/validate-companies`, { method: "POST" });
const body = await res.json();
if (!res.ok) throw new Error(JSON.stringify(body));

console.log("\nSummary:", body.summary);
console.log("\nEmpty boards (0 jobs — may be freeze or paused):");
for (const r of body.results.filter((x) => x.status === "empty" && x.enabled)) {
  console.log(`  - ${r.name} (${r.ats}): ${r.hiringNote}`);
}
console.log("\nErrors:");
for (const r of body.results.filter((x) => x.status === "error" && x.enabled)) {
  console.log(`  - ${r.name}: ${r.error ?? r.hiringNote}`);
}
console.log("\nActive sample (top 10 by count):");
const active = body.results
  .filter((x) => x.status === "active")
  .sort((a, b) => b.jobCount - a.jobCount)
  .slice(0, 10);
for (const r of active) {
  console.log(`  - ${r.name}: ${r.jobCount} jobs`);
}
