import "dotenv/config";
import { getDb } from "./src/db/client.js";
import { listUsers } from "./src/users.js";

const db = getDb();
for (const u of await listUsers(db)) {
  console.log(
    `id ${u.id}  name=${u.name}  token=${u.token_hash ? "set (hash only)" : "none"}  slack=${u.slack_webhook_url ? "set" : "none"}  created=${new Date(u.created_at).toISOString()}`
  );
}
