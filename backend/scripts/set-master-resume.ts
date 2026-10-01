/**
 * Set a user's pasted master resume from a plain-text file, then verify it
 * passes the tailor-source adequacy check.
 *
 *   npx tsx scripts/set-master-resume.ts <userId> <path-to-text-file>
 */
import "dotenv/config";
import fs from "node:fs";
import { getDb } from "../src/db/client.js";
import { setProfile } from "../src/store.js";
import { getTailorSource } from "../src/profile/tailorSource.js";

async function main(): Promise<void> {
  const userId = Number(process.argv[2]);
  const file = process.argv[3];
  if (!Number.isInteger(userId) || userId <= 0 || !file) {
    console.error("Usage: npx tsx scripts/set-master-resume.ts <userId> <path-to-text-file>");
    process.exit(1);
  }

  const text = fs.readFileSync(file, "utf8");
  const db = getDb();
  await setProfile(db, userId, { masterResume: text });

  const src = await getTailorSource(db, userId);
  console.log(`userId: ${userId}`);
  console.log(`masterResumePresent: ${src.masterResumePresent}`);
  console.log(`masterResumeAdequate: ${src.masterResumeAdequate}`);
  console.log(`masterText.length: ${src.masterText.length}`);
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
