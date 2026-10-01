/**
 * Seed FAANG + manual career page watches.
 * Run: node scripts/seed-career-watches.mjs
 */
const B = "http://127.0.0.1:8787";
const res = await fetch(`${B}/admin/seed-career-watches`, { method: "POST" });
const body = await res.json();
if (!res.ok) throw new Error(JSON.stringify(body));
console.log(`Seeded ${body.count} career watches.`);
