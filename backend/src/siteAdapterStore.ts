import type { DB } from "./db/client.js";
import { SiteAdapterSchema, type SiteAdapter } from "./llm/siteAdapter.js";

export async function getSiteAdapter(db: DB, host: string): Promise<SiteAdapter | null> {
  const row = (await db
    .prepare("SELECT adapter_json FROM site_adapters WHERE host = ?")
    .get(host)) as { adapter_json: string } | undefined;
  if (!row) return null;
  try {
    return SiteAdapterSchema.parse(JSON.parse(row.adapter_json));
  } catch {
    return null;
  }
}

export async function putSiteAdapter(db: DB, host: string, adapter: SiteAdapter): Promise<void> {
  await db.prepare(
    `INSERT INTO site_adapters (host, adapter_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(host) DO UPDATE SET
       adapter_json = excluded.adapter_json,
       updated_at = excluded.updated_at`
  ).run(host, JSON.stringify(adapter), Date.now());
}
