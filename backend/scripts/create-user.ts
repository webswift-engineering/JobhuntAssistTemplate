/**
 * Create an account and print its token (shown once — the DB stores only a hash).
 *
 *   npx tsx scripts/create-user.ts <name> [slack-webhook-url]
 *
 * Example:
 *   npx tsx scripts/create-user.ts alice https://hooks.slack.com/services/T000/B000/xxxx
 *
 * The new user signs in at the dashboard /login page with this token, and sets
 * the same token in the browser-extension options for their machine.
 */
import "dotenv/config";
import { getDb, ensurePgSchema } from "../src/db/client.js";
import { createUser, ensureOwnerUser, listUsers } from "../src/users.js";

async function main(): Promise<void> {
  const name = process.argv[2]?.trim();
  const webhook = process.argv[3]?.trim() || null;
  if (!name) {
    console.error("Usage: npx tsx scripts/create-user.ts <name> [slack-webhook-url]");
    process.exit(1);
  }

  const db = getDb();
  await ensurePgSchema(db);
  await ensureOwnerUser(db);

  const existing = (await listUsers(db)).find((u) => u.name === name);
  if (existing) {
    console.error(`User "${name}" already exists (id ${existing.id}).`);
    process.exit(1);
  }

  const { user, token } = await createUser(db, name, { slackWebhookUrl: webhook });
  console.log(`Created user "${user.name}" (id ${user.id})`);
  console.log(`Slack webhook: ${user.slack_webhook_url ?? "(none — no notifications)"}`);
  console.log("");
  console.log("Access token (save it now, it is not shown again):");
  console.log(`  ${token}`);
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
