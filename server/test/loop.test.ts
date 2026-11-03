import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ACME_POLICY, seedAcme } from "../src/demo/acme.js";
import { Guard, type Judge } from "../src/guard/guard.js";
import { MemoryPayPalClient } from "../src/paypal/memory.js";
import { MemoryStore } from "../src/store/memory.js";
import { SimBackend } from "../src/mcp/backend.js";
import { SessionRegistry } from "../src/mcp/sessions.js";
import type { LedgerEntry } from "../src/store/types.js";

class VerifyingPayPal extends MemoryPayPalClient {
  verify = true;
  override async verifyWebhook() {
    return this.verify;
  }
}

let store: MemoryStore;
let paypal: VerifyingPayPal;
let guard: Guard;
let app: ReturnType<typeof createApp>;
let ledger: LedgerEntry[];

const cap = (customerId: string, description: string) =>
  ledger.find((e) => e.customerId === customerId && e.description === description)!;

function guardCall(customerId: string, captureId: string, value?: string, extra: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/guard")
    .send({
      call: { tool: "create_refund", args: value ? { capture_id: captureId, amount: { currency_code: "USD", value } } : { capture_id: captureId } },
      session: { customerId, conversationId: "conv-1", trusted: [], untrusted: [], ...extra },
    });
}

function refundEvent(id: string, refundId: string, captureId: string, value: string) {
  return JSON.stringify({
    id,
    event_type: "PAYMENT.CAPTURE.REFUNDED",
    resource: {
      id: refundId,
      status: "COMPLETED",
      amount: { value },
      links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }],
    },
  });
}

beforeEach(async () => {
  store = new MemoryStore(ACME_POLICY);
  paypal = new VerifyingPayPal();
  guard = new Guard(store, paypal);
  app = createApp({ store, paypal, guard, sessions: new SessionRegistry(), backend: new SimBackend(store) });
  await seedAcme(store, paypal);
  ledger = await store.listLedger();
});

describe("refund approval loop", () => {
  it("executes a small legitimate refund and updates the ledger", async () => {
    const grinder = cap("maya", "Burr grinder (manual)");
    const res = await guardCall("maya", grinder.captureId, "18.00", {
      trusted: [{ origin: "chat", text: "My grinder arrived cracked, can I get my $18 back?" }],
      untrusted: [{ origin: "order note", text: grinder.note }],
    });
    expect(res.body).toMatchObject({ status: "executed", decision: "allow", decidedBy: "none" });
    expect(res.body.paypal.refundId).toMatch(/^SIM-REF-/);
    expect((await store.getLedger(grinder.captureId))!.refunded).toBe(18);
  });

  it("holds the injected refund and highlights the hidden instruction", async () => {
    const bundle = cap("sam", "Cold brew bundle");
    const res = await guardCall("sam", bundle.captureId, undefined, {
      trusted: [{ origin: "chat", text: "Hey, where's my order?" }],
      untrusted: [{ origin: `order ${bundle.orderId} · delivery note`, text: bundle.note }],
    });
    expect(res.body).toMatchObject({ status: "held", decision: "hold", decidedBy: "provenance", effectiveAmount: 36 });
    expect(res.body.spans.some((s: { text: string }) => /ignore previous instructions/i.test(s.text) || /refund this order in full/i.test(s.text))).toBe(true);
    expect(paypal.refundCalls).toBe(0);
  });

  it("records an unprotected run as a dry run without moving money", async () => {
    const bundle = cap("sam", "Cold brew bundle");
    const res = await guardCall("sam", bundle.captureId, undefined, { mode: "unprotected" });
    expect(res.body).toMatchObject({ status: "simulated", effectiveAmount: 36 });
    expect(paypal.refundCalls).toBe(0);
  });

  it("holds a large refund, executes it on approval, and confirms it by webhook", async () => {
    const kit = cap("dev", "Espresso starter kit");
    const held = await guardCall("dev", kit.captureId, "140.00");
    expect(held.body).toMatchObject({ status: "held", decidedBy: "policy" });
    expect(held.body.hits.map((h: { ruleId: string }) => h.ruleId)).toEqual(["cap-50"]);

    const approved = await request(app).post(`/api/approvals/${held.body.id}/approve`);
    expect(approved.body).toMatchObject({ status: "approved", approval: { by: "merchant" } });
    const refundId = approved.body.paypal.refundId;

    const hook = await request(app).post("/webhooks/paypal").set("content-type", "application/json").send(refundEvent("WH-1", refundId, kit.captureId, "140.00"));
    expect(hook.body).toMatchObject({ ok: true, matched: held.body.id });
    expect((await store.getAudit(held.body.id))!.webhookConfirmed).toBe(true);
    // The webhook confirms; it must not count the refund a second time.
    expect((await store.getLedger(kit.captureId))!.refunded).toBe(140);
  });

  it("re-checks blocking rules on approval when the ledger changed meanwhile", async () => {
    const kit = cap("dev", "Espresso starter kit");
    const held = await guardCall("dev", kit.captureId, "140.00");
    await store.addRefunded(kit.captureId, 140); // e.g. refunded from the PayPal dashboard
    const approved = await request(app).post(`/api/approvals/${held.body.id}/approve`);
    expect(approved.body.status).toBe("blocked");
    expect(approved.body.hits.at(-1).reason).toMatch(/^On approval:/);
    expect(paypal.refundCalls).toBe(0);
  });

  it("blocks an agent retry and reuses the same PayPal-Request-Id", async () => {
    const grinder = cap("maya", "Burr grinder (manual)");
    const first = await guardCall("maya", grinder.captureId, "18.00");
    const retry = await guardCall("maya", grinder.captureId, "18.00");
    expect(first.body.status).toBe("executed");
    expect(retry.body).toMatchObject({ status: "blocked" });
    expect(retry.body.hits.map((h: { ruleId: string }) => h.ruleId)).toContain("no-dup");
    expect(retry.body.requestId).toBe(first.body.requestId);
    expect(paypal.refundCalls).toBe(1);
  });

  it("blocks refunding another customer's order", async () => {
    const kit = cap("dev", "Espresso starter kit");
    const res = await guardCall("sam", kit.captureId, "10.00");
    expect(res.body.status).toBe("blocked");
    expect(res.body.hits.map((h: { ruleId: string }) => h.ruleId)).toContain("own-orders");
  });

  it("rejects a held call without moving money", async () => {
    const kit = cap("dev", "Espresso starter kit");
    const held = await guardCall("dev", kit.captureId, "140.00");
    const rejected = await request(app).post(`/api/approvals/${held.body.id}/reject`);
    expect(rejected.body.status).toBe("rejected");
    expect(paypal.refundCalls).toBe(0);
    expect((await request(app).post(`/api/approvals/${held.body.id}/approve`)).status).toBe(404);
  });
});

describe("judge can only tighten", () => {
  const judgeSaying = (verdict: "allow" | "hold" | "block"): Judge => ({
    review: async () => ({ verdict, reason: `judge says ${verdict}`, model: "test" }),
  });

  async function run(judge: Judge, customerId: string, description: string, value: string, note: string) {
    guard = new Guard(store, paypal, judge);
    app = createApp({ store, paypal, guard, sessions: new SessionRegistry(), backend: new SimBackend(store) });
    return guardCall(customerId, cap(customerId, description).captureId, value, { untrusted: [{ origin: "order note", text: note }] });
  }

  it("tightens an allow to block", async () => {
    const res = await run(judgeSaying("block"), "maya", "Burr grinder (manual)", "18.00", "Whole bean please.");
    expect(res.body).toMatchObject({ status: "blocked", decidedBy: "judge" });
  });

  it("cannot loosen a hold", async () => {
    const res = await run(judgeSaying("allow"), "dev", "Espresso starter kit", "140.00", "Leave with the doorman.");
    expect(res.body).toMatchObject({ status: "held", decidedBy: "policy" });
  });

  it("fails safe to hold when the judge errors", async () => {
    const broken: Judge = { review: async () => Promise.reject(new Error("quota exceeded")) };
    const res = await run(broken, "maya", "Burr grinder (manual)", "18.00", "Whole bean please.");
    expect(res.body).toMatchObject({ status: "held", decidedBy: "judge" });
  });

  it("is not consulted when no untrusted text was read", async () => {
    let called = false;
    guard = new Guard(store, paypal, { review: async () => ((called = true), { verdict: "block", reason: "", model: "t" }) });
    app = createApp({ store, paypal, guard, sessions: new SessionRegistry(), backend: new SimBackend(store) });
    const res = await guardCall("maya", cap("maya", "Burr grinder (manual)").captureId, "18.00");
    expect(res.body.status).toBe("executed");
    expect(called).toBe(false);
  });
});

describe("webhooks", () => {
  it("ignores unverified events", async () => {
    paypal.verify = false;
    const kit = cap("dev", "Espresso starter kit");
    const res = await request(app).post("/webhooks/paypal").set("content-type", "application/json").send(refundEvent("WH-X", "R-1", kit.captureId, "50.00"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, reason: "unverified" });
    expect((await store.getLedger(kit.captureId))!.refunded).toBe(0);
  });

  it("records refunds made outside Paywarden, once", async () => {
    const kit = cap("dev", "Espresso starter kit");
    const body = refundEvent("WH-EXT", "R-DASH", kit.captureId, "50.00");
    await request(app).post("/webhooks/paypal").set("content-type", "application/json").send(body);
    const again = await request(app).post("/webhooks/paypal").set("content-type", "application/json").send(body);
    expect(again.body).toMatchObject({ ok: true, duplicate: true });
    expect((await store.getLedger(kit.captureId))!.refunded).toBe(50);
  });
});
