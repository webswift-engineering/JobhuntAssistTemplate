import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const B = "http://127.0.0.1:8787";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const masterResume = fs.readFileSync(path.join(__dirname, "..", "data", "master-resume.txt"), "utf8");

const cur = await fetch(B + "/profile").then((r) => r.json());
const res = await fetch(B + "/profile", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    masterResume,
    preferences: cur.preferences,
    screeningAnswers: cur.screeningAnswers,
  }),
});
if (!res.ok) {
  console.error("Failed:", await res.text());
  process.exit(1);
}
console.log("Saved master resume to profile (" + masterResume.length + " chars)");
console.log("master-profile.json is at backend/data/master-profile.json");
