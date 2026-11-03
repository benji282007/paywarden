import { describe, expect, it } from "vitest";
import { evaluate } from "../src/policy/evaluate.js";
import type { CaptureRecord, EvalContext, ExecutedCall, Policy } from "../src/policy/types.js";

const NOW = new Date("2026-11-05T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const captures: CaptureRecord[] = [
  { captureId: "CAP-ALICE-1", customerId: "alice", amount: 50, refunded: 0, currency: "USD", capturedAt: daysAgo(3) },
  { captureId: "CAP-ALICE-OLD", customerId: "alice", amount: 40, refunded: 0, currency: "USD", capturedAt: daysAgo(90) },
  { captureId: "CAP-ALICE-PART", customerId: "alice", amount: 50, refunded: 45, currency: "USD", capturedAt: daysAgo(2) },
  { captureId: "CAP-BOB-1", customerId: "bob", amount: 200, refunded: 0, currency: "USD", capturedAt: daysAgo(1) },
];

// The demo merchant's policy, as the compiler would emit it.
const policy: Policy = {
  version: 1,
  rules: [
    { id: "r1", kind: "max_amount", tool: "create_refund", max: 50, action: "hold", source: "Refunds over $50 need my approval." },
    { id: "r2", kind: "daily_count", tool: "create_refund", max: 2, per: "customer", action: "block", source: "At most 2 refunds per customer per day." },
    { id: "r3", kind: "owner_match", action: "block", source: "Only refund the customer's own orders." },
    { id: "r4", kind: "no_over_refund", action: "block", source: "Never refund more than was paid." },
    { id: "r5", kind: "max_order_age_days", days: 60, action: "hold", source: "Orders older than 60 days need approval." },
    { id: "r6", kind: "no_duplicate", windowSeconds: 600, action: "block", source: "No repeat refunds on the same order." },
    { id: "r7", kind: "untrusted_influence", action: "hold", source: "Hold anything triggered by text the customer wrote into order data." },
    { id: "r8", kind: "deny_tool", tool: "send_invoice", action: "block", source: "The support bot never sends invoices." },
  ],
};

function ctx(over: Partial<EvalContext> = {}): EvalContext {
  return {
    now: NOW,
    customerId: "alice",
    agentId: "acme-support",
    getCapture: (id) => captures.find((c) => c.captureId === id),
    history: [],
    ...over,
  };
}

const refund = (capture_id: string, value?: string) => ({
  tool: "create_refund",
  args: value ? { capture_id, amount: { currency_code: "USD", value } } : { capture_id },
});

describe("evaluate", () => {
  it("passes read-only tools untouched", () => {
    expect(evaluate(policy, { tool: "get_order", args: { id: "X" } }, ctx()).decision).toBe("allow");
  });

  it("allows a small legitimate refund on the customer's own order", () => {
    const r = evaluate(policy, refund("CAP-ALICE-1", "18.00"), ctx());
    expect(r).toMatchObject({ decision: "allow", hits: [], effectiveAmount: 18 });
  });

  it("prices a refund without amount as the full remaining capture", () => {
    const r = evaluate(policy, refund("CAP-ALICE-PART"), ctx());
    expect(r.effectiveAmount).toBe(5);
    expect(r.decision).toBe("allow");
  });

  it("holds refunds above the amount cap", () => {
    const r = evaluate(policy, refund("CAP-BOB-1", "140.00"), ctx({ customerId: "bob" }));
    expect(r.decision).toBe("hold");
    expect(r.hits.map((h) => h.ruleId)).toEqual(["r1"]);
  });

  it("blocks refunding another customer's capture even when the amount is fine", () => {
    const r = evaluate(policy, refund("CAP-BOB-1", "10.00"), ctx());
    expect(r.decision).toBe("block");
    expect(r.hits.map((h) => h.ruleId)).toContain("r3");
  });

  it("blocks unknown captures with a built-in rule", () => {
    const r = evaluate(policy, refund("CAP-NOPE", "1.00"), ctx());
    expect(r.decision).toBe("block");
    expect(r.hits[0].ruleId).toBe("builtin.unknown_capture");
  });

  it("blocks over-refunding a partially refunded capture", () => {
    const r = evaluate(policy, refund("CAP-ALICE-PART", "10.00"), ctx());
    expect(r.decision).toBe("block");
    expect(r.hits.map((h) => h.ruleId)).toEqual(["r4"]);
  });

  it("holds refunds on old orders", () => {
    expect(evaluate(policy, refund("CAP-ALICE-OLD", "5.00"), ctx()).decision).toBe("hold");
  });

  it("blocks an agent retry that would double-refund", () => {
    const history: ExecutedCall[] = [
      { tool: "create_refund", customerId: "alice", captureId: "CAP-ALICE-1", amount: 18, at: new Date(NOW.getTime() - 30_000) },
    ];
    const r = evaluate(policy, refund("CAP-ALICE-1", "18.00"), ctx({ history }));
    expect(r.decision).toBe("block");
    expect(r.hits.map((h) => h.ruleId)).toContain("r6");
  });

  it("enforces per-customer daily count but ignores other customers' refunds", () => {
    const at = daysAgo(0.1);
    const mine: ExecutedCall[] = [
      { tool: "create_refund", customerId: "alice", captureId: "A", amount: 1, at },
      { tool: "create_refund", customerId: "alice", captureId: "B", amount: 1, at },
    ];
    const others: ExecutedCall[] = mine.map((h) => ({ ...h, customerId: "bob" }));
    expect(evaluate(policy, refund("CAP-ALICE-1", "1.00"), ctx({ history: mine })).decision).toBe("block");
    expect(evaluate(policy, refund("CAP-ALICE-1", "1.00"), ctx({ history: others })).decision).toBe("allow");
  });

  it("holds calls the provenance analyzer flagged", () => {
    const r = evaluate(
      policy,
      refund("CAP-ALICE-1", "5.00"),
      ctx({ untrustedInfluence: [{ reason: "instruction in order note" }] }),
    );
    expect(r.decision).toBe("hold");
    expect(r.hits[0].reason).toContain("instruction in order note");
  });

  it("denies tools the merchant forbade", () => {
    expect(evaluate(policy, { tool: "send_invoice", args: {} }, ctx()).decision).toBe("block");
  });

  it("block wins over hold when several rules fire", () => {
    const r = evaluate(policy, refund("CAP-BOB-1", "150.00"), ctx());
    expect(r.hits.map((h) => h.action).sort()).toEqual(["block", "hold"]);
    expect(r.decision).toBe("block");
  });
});

describe("rolling windows", () => {
  const hourly: Policy = {
    version: 1,
    rules: [{ id: "h", kind: "daily_count", tool: "create_refund", max: 2, per: "agent", windowHours: 1, action: "block", source: "2 refunds an hour" }],
  };
  const at = (minutesAgo: number): ExecutedCall => ({ tool: "create_refund", customerId: "bob", captureId: "X", amount: 1, at: new Date(NOW.getTime() - minutesAgo * 60_000) });

  it("counts only calls inside the window", () => {
    expect(evaluate(hourly, refund("CAP-ALICE-1", "1.00"), ctx({ history: [at(10), at(20)] })).decision).toBe("block");
    expect(evaluate(hourly, refund("CAP-ALICE-1", "1.00"), ctx({ history: [at(10), at(90)] })).decision).toBe("allow");
  });

  it("names the window in the reason", () => {
    expect(evaluate(hourly, refund("CAP-ALICE-1", "1.00"), ctx({ history: [at(1), at(2)] })).hits[0].reason).toContain("1 hour");
  });
});
