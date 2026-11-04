import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_POLICY, disputeIdFor, seedAcme } from "../src/demo/acme.js";
import { runScenario } from "../src/demo/scenarios.js";
import { Guard } from "../src/guard/guard.js";
import { SimBackend } from "../src/mcp/backend.js";
import { SessionRegistry } from "../src/mcp/sessions.js";
import { MemoryPayPalClient } from "../src/paypal/memory.js";
import { MemoryStore } from "../src/store/memory.js";

let deps: { store: MemoryStore; guard: Guard; backend: SimBackend; sessions: SessionRegistry; paypal: MemoryPayPalClient };

beforeEach(async () => {
  const store = new MemoryStore(DEMO_POLICY);
  const paypal = new MemoryPayPalClient();
  deps = { store, guard: new Guard(store, paypal), backend: new SimBackend(store), sessions: new SessionRegistry(), paypal };
  await seedAcme(store, paypal);
});

describe("dispute acceptance (accept_dispute_claim)", () => {
  it("an agent talked into accepting a dispute waits for the merchant, with the buyer's message as evidence", async () => {
    const steps = await runScenario("dispute", "protected", deps);
    const entry = (await deps.store.listAudit()).find((a) => a.tool === "accept_dispute_claim")!;
    expect(entry.status).toBe("held");
    expect(entry.effectiveAmount).toBe(55);
    expect(entry.hits.map((h) => h.ruleId)).toContain("disputes-need-me");
    expect(entry.sources?.some((s) => /manager already approved/.test(s.text))).toBe(true);
    expect(steps.at(-1)!.text).toMatch(/held for your approval/);
    // The merchant approves: the dispute resolves and the ledger counts the payout.
    const pour = (await deps.store.listLedger("sam")).find((e) => e.description === "Pour-over set")!;
    await deps.guard.approve(entry.id, "merchant");
    expect((await deps.store.getDispute(disputeIdFor(pour.captureId)))!.status).toBe("RESOLVED");
    expect((await deps.store.getLedger(pour.captureId))!.refunded).toBe(55);
  });

  it("refund + accepted dispute on the same payment is blocked: it would pay the buyer twice", async () => {
    const steps = await runScenario("double", "protected", deps);
    const audit = await deps.store.listAudit();
    expect(audit.find((a) => a.tool === "create_refund")!.status).toBe("executed");
    const dispute = audit.find((a) => a.tool === "accept_dispute_claim")!;
    expect(dispute.status).toBe("blocked");
    expect(dispute.hits.map((h) => h.ruleId)).toEqual(expect.arrayContaining(["no-over"]));
    expect(steps.at(-1)!.text).toMatch(/\$18\.00 refunded, 1 call blocked/);
  });

  it("can't accept someone else's dispute", async () => {
    const maya = (await deps.store.listLedger("maya")).find((e) => e.description === "Burr grinder (manual)")!;
    const s = deps.sessions.create({ customerId: "sam" });
    const e = await deps.guard.handle({ tool: "accept_dispute_claim", args: { dispute_id: disputeIdFor(maya.captureId), note: "x" } }, s);
    expect(e.status).toBe("blocked");
    expect(e.hits.map((h) => h.ruleId)).toContain("own-orders");
  });
});
