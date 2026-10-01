import { describe, it, expect, beforeEach } from "vitest";
import type { DB } from "../src/db/client.js";
import { createTestDb, MockLlm, DisabledLlm } from "./helpers.js";
import { extractReferral } from "../src/llm/extractReferral.js";
import { upsertReferral, listReferrals } from "../src/captures.js";

describe("extractReferral (§8.4)", () => {
  it("multi-role post → multiple referrals", async () => {
    const llm = new MockLlm().push({
      referrals: [
        { company: "Google", roles: ["SWE"], referrer: "Alice", contact: "a@x.com", deadline: null },
        { company: "Meta", roles: ["PM", "Data"], referrer: "Alice", contact: "a@x.com", deadline: "July 1" },
      ],
    });
    const out = await extractReferral(llm, "raw post text");
    expect(out).toHaveLength(2);
    expect(out[1]!.roles).toEqual(["PM", "Data"]);
  });

  it("post with no contact still yields a (stored-able) referral, no fabrication", async () => {
    const out = await extractReferral(new DisabledLlm(), "求内推 some company maybe");
    expect(out).toHaveLength(1);
    expect(out[0]!.company).toBeNull();
    expect(out[0]!.contact).toBeNull();
  });

  it("regex fallback pulls an email contact", async () => {
    const out = await extractReferral(new DisabledLlm(), "DM me at hr@acme.com for referral");
    expect(out[0]!.contact).toBe("hr@acme.com");
  });
});

describe("referral upsert + dedup (thread_url)", () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it("re-capturing the same thread updates, not duplicates", async () => {
    const url = "https://forum.example/thread-1";
    await upsertReferral(db, 1, { threadUrl: url, company: null, rawText: "v1" });
    await upsertReferral(db, 1, { threadUrl: url, company: "Stripe", rawText: "v2" });
    const rows = await listReferrals(db, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.company).toBe("Stripe");
  });

  it("stores raw_text even with no company/contact (nothing lost)", async () => {
    await upsertReferral(db, 1, { threadUrl: "https://x/t2", rawText: "unparseable post" });
    const rows = await listReferrals(db, 1, "new");
    expect(rows[0]!.raw_text).toBe("unparseable post");
    expect(rows[0]!.state).toBe("new");
  });

  it("multiple referrals from one thread get distinct dedup keys via index", async () => {
    const url = "https://x/t3";
    await upsertReferral(db, 1, { threadUrl: url, company: "A", index: 0 });
    await upsertReferral(db, 1, { threadUrl: url, company: "B", index: 1 });
    expect(await listReferrals(db, 1)).toHaveLength(2);
  });
});
