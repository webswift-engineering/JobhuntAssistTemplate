/**
 * Upsert a starter set of ATS companies (edit COMPANIES to match your own targets).
 * Run: node scripts/seed-companies.mjs
 * Requires backend on http://127.0.0.1:8787
 */
const B = "http://127.0.0.1:8787";
const j = (o) => JSON.stringify(o);
const get = (p) => fetch(B + p).then((r) => r.json());
const post = (p, o) =>
  fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: j(o) }).then((r) =>
    r.json()
  );
const patch = (p, o) =>
  fetch(B + p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: j(o) }).then((r) =>
    r.json()
  );

/** Starter list — a few well-known public boards per ATS. Replace with your own. */
const COMPANIES = [
  { name: "Cloudflare", ats: "greenhouse", boardToken: "cloudflare" },
  { name: "Datadog", ats: "greenhouse", boardToken: "datadog" },
  { name: "Okta", ats: "greenhouse", boardToken: "okta" },
  { name: "Grafana Labs", ats: "greenhouse", boardToken: "grafanalabs" },
  { name: "PagerDuty", ats: "greenhouse", boardToken: "pagerduty" },
  { name: "1Password", ats: "ashby", boardToken: "1password" },
  { name: "Semgrep", ats: "ashby", boardToken: "semgrep" },
  { name: "Shopify", ats: "greenhouse", boardToken: "shopify", enabled: false },
];

const existing = await get("/companies");
let added = 0;
let updated = 0;

for (const c of COMPANIES) {
  const row = existing.find((x) => x.name === c.name);
  const enabled = c.enabled !== false;
  if (row) {
    await patch(`/companies/${row.id}`, {
      ats: c.ats,
      boardToken: c.boardToken,
      enabled,
    });
    updated++;
    console.log(`~ ${c.name} (${c.ats}/${c.boardToken})${enabled ? "" : " [disabled]"}`);
  } else {
    await post("/companies", { name: c.name, ats: c.ats, boardToken: c.boardToken, enabled });
    added++;
    console.log(`+ ${c.name} (${c.ats}/${c.boardToken})`);
  }
}

const final = await get("/companies");
const enabledN = final.filter((x) => x.enabled).length;
console.log(`\nDone: ${added} added, ${updated} updated, ${enabledN} enabled companies.`);
