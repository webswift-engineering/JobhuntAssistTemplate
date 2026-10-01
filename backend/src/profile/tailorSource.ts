import fs from "node:fs";
import { masterProfilePathFor } from "../config.js";
import { getProfile } from "../store.js";
import type { DB } from "../db/client.js";
import { MasterProfileSchema, profileToMasterText, type MasterProfile } from "./masterProfile.js";

export function loadMasterProfile(userId: number): MasterProfile | null {
  const p = masterProfilePathFor(userId);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return MasterProfileSchema.parse(raw);
  } catch (err) {
    console.warn("[profile] invalid master-profile.json:", (err as Error).message);
    return null;
  }
}

/** Minimum content required to produce a real résumé (not just a skills stub). */
const MIN_MASTER_CHARS = 600;

export function isAdequateMasterText(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_MASTER_CHARS) return false;
  return /\b(experience|developed|designed|implemented|engineer|software)\b/i.test(t);
}

export interface TailorSource {
  kind: "profile" | "string";
  profile: MasterProfile | null;
  masterText: string;
  masterResumePresent: boolean;
  masterResumeAdequate: boolean;
}

/** Prefer compiled master-profile.json when adequate; else pasted master resume. */
export async function getTailorSource(db: DB, userId: number): Promise<TailorSource> {
  const pasted = (await getProfile(db, userId)).masterResume ?? "";
  const profileDoc = loadMasterProfile(userId);

  if (profileDoc) {
    const text = profileToMasterText(profileDoc);
    if (isAdequateMasterText(text)) {
      return {
        kind: "profile",
        profile: profileDoc,
        masterText: text,
        masterResumePresent: true,
        masterResumeAdequate: true,
      };
    }
  }

  if (isAdequateMasterText(pasted)) {
    return {
      kind: "string",
      profile: null,
      masterText: pasted,
      masterResumePresent: true,
      masterResumeAdequate: true,
    };
  }

  const fallback = profileDoc ? profileToMasterText(profileDoc) : pasted;
  return {
    kind: "string",
    profile: null,
    masterText: fallback,
    masterResumePresent: fallback.trim().length > 0,
    masterResumeAdequate: false,
  };
}
