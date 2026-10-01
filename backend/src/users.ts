/**
 * Accounts. The owner is always user 1 (all pre-multi-user data was backfilled
 * to user_id = 1). Tokens are stored as sha256 hashes; the raw token lives only
 * in the login cookie / extension config on the user's own devices.
 */
import crypto from "node:crypto";
import type { DB } from "./db/client.js";
import { config } from "./config.js";

export const OWNER_USER_ID = 1;

export interface UserRow {
  id: number;
  name: string;
  token_hash: string | null;
  slack_webhook_url: string | null;
  created_at: number;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Seed / refresh the owner row at boot. The env ACCESS_TOKEN stays authoritative
 * for the owner's login so the existing single-user setup keeps working
 * unchanged; other users' tokens live only in the users table.
 */
export async function ensureOwnerUser(db: DB): Promise<void> {
  const tokenHash = config.accessToken ? hashToken(config.accessToken) : null;
  const existing = (await db.prepare("SELECT id, token_hash FROM users WHERE id = 1").get()) as
    | { id: number; token_hash: string | null }
    | undefined;
  if (!existing) {
    await db.prepare(
      "INSERT INTO users (id, name, token_hash, slack_webhook_url, created_at) VALUES (1, 'owner', ?, NULL, ?)"
    ).run(tokenHash, Date.now());
  } else if (tokenHash && existing.token_hash !== tokenHash) {
    await db.prepare("UPDATE users SET token_hash = ? WHERE id = 1").run(tokenHash);
  }
}

export async function getUser(db: DB, id: number): Promise<UserRow | undefined> {
  return (await db.prepare("SELECT * FROM users WHERE id = ?").get(id)) as UserRow | undefined;
}

export async function listUsers(db: DB): Promise<UserRow[]> {
  return (await db.prepare("SELECT * FROM users ORDER BY id").all()) as UserRow[];
}

export async function findUserByToken(db: DB, token: string): Promise<UserRow | undefined> {
  if (!token) return undefined;
  return (await db
    .prepare("SELECT * FROM users WHERE token_hash = ?")
    .get(hashToken(token))) as UserRow | undefined;
}

/** Create an account and return its one-time-visible raw token. */
export async function createUser(
  db: DB,
  name: string,
  opts: { slackWebhookUrl?: string | null } = {}
): Promise<{ user: UserRow; token: string }> {
  const token = crypto.randomBytes(24).toString("base64url");
  const next =
    Number(((await db.prepare("SELECT max(id) AS m FROM users").get()) as { m: number | null }).m ?? 0) + 1;
  await db.prepare(
    "INSERT INTO users (id, name, token_hash, slack_webhook_url, created_at) VALUES (?,?,?,?,?)"
  ).run(next, name, hashToken(token), opts.slackWebhookUrl ?? null, Date.now());
  return { user: (await getUser(db, next))!, token };
}

export async function updateUser(
  db: DB,
  id: number,
  patch: { slackWebhookUrl?: string | null }
): Promise<void> {
  if (patch.slackWebhookUrl !== undefined) {
    await db.prepare("UPDATE users SET slack_webhook_url = ? WHERE id = ?").run(patch.slackWebhookUrl, id);
  }
}

/** The Slack webhook for a user's notifications; owner falls back to the env var. */
export async function userWebhook(db: DB, userId: number): Promise<string> {
  const u = await getUser(db, userId);
  if (u?.slack_webhook_url) return u.slack_webhook_url;
  return userId === OWNER_USER_ID ? config.notify.slackWebhookUrl : "";
}
