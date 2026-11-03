// Generated sample history for the demo dashboard: ~30 days of refund activity so the
// audit grid, chart and plain-English queries have something to work with. Every row is
// marked `sample`, kept out of the KPI totals, and dated more than 24 hours ago so it
// can't trip velocity rules in the live demo. It references no real ledger capture.

import type { AuditEntry, AuditStatus, Store } from "../store/types.js";

export const SAMPLE_CUSTOMERS = [
  { id: "s-ava", name: "Ava Patel" },
  { id: "s-ben", name: "Ben Okafor" },
  { id: "s-chloe", name: "Chloé Martin" },
  { id: "s-diego", name: "Diego Ruiz" },
  { id: "s-emi", name: "Emi Tanaka" },
  { id: "s-farah", name: "Farah Haddad" },
  { id: "s-gus", name: "Gus Lindqvist" },
  { id: "s-hana", name: "Hana Kim" },
];

// Deterministic pseudo-random, so every visitor sees the same history.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const AMOUNTS = [6, 9.5, 12, 14, 18, 18, 22, 24, 29, 32, 36, 42, 48, 55, 64, 85, 120, 140];

type Kind = { status: AuditStatus; decidedBy: AuditEntry["decidedBy"]; ruleId?: string; action?: "hold" | "block"; reason?: string; source?: string };
const KINDS: [number, (amount: number) => Kind][] = [
  [62, () => ({ status: "executed", decidedBy: "none" })],
  [10, (a) => ({ status: "approved", decidedBy: "policy", ruleId: "cap-50", action: "hold", reason: `$${a.toFixed(2)} exceeds the $50.00 limit`, source: "Refunds over $50 need my approval." })],
  [7, () => ({ status: "blocked", decidedBy: "policy", ruleId: "no-dup", action: "block", reason: "Already refunded moments ago (agent retry)", source: "Never refund the same order twice in 10 minutes." })],
  [6, () => ({ status: "rejected", decidedBy: "provenance", ruleId: "asked", action: "hold", reason: "The customer never asked for a refund in their own words; the request came from somewhere else", source: "Only refund when the customer actually asked for it in the chat." })],
  [5, () => ({ status: "blocked", decidedBy: "policy", ruleId: "own-orders", action: "block", reason: "Capture belongs to a different customer than the one in this conversation", source: "Only refund the customer's own orders." })],
  [4, () => ({ status: "rejected", decidedBy: "provenance", ruleId: "untrusted", action: "hold", reason: "Influenced by customer-writable data: checkout note claims to come from the merchant's own staff", source: "Hold any refund steered by text the customer typed into order data." })],
  [3, () => ({ status: "blocked", decidedBy: "policy", ruleId: "no-over", action: "block", reason: "Amount exceeds what is still refundable on this capture", source: "Never refund more than was paid." })],
  [3, () => ({ status: "approved", decidedBy: "policy", ruleId: "age-60", action: "hold", reason: "Order is 74 days old (limit 60)", source: "Orders older than 60 days need my approval." })],
];

export async function seedSampleHistory(store: Store, days = 30, perDay = 4): Promise<void> {
  const rand = rng(20261103);
  const total = KINDS.reduce((t, [w]) => t + w, 0);
  const now = Date.now();
  for (let d = days; d >= 2; d--) {
    const n = perDay + Math.floor(rand() * 3) - 1;
    for (let k = 0; k < n; k++) {
      let pick = rand() * total;
      const make = KINDS.find(([w]) => (pick -= w) < 0)![1];
      const amount = AMOUNTS[Math.floor(rand() * AMOUNTS.length)];
      const kind = make(amount);
      // Amounts consistent with the demo rules: automatic refunds stay within the $50
      // cap, over-limit approvals are over it (so a backtest of today's rules changes nothing).
      const amt = kind.ruleId === "cap-50" ? Math.max(amount, 55) : kind.status === "executed" ? Math.min(amount, 48) : amount;
      const at = new Date(now - d * 86_400_000 + Math.floor(rand() * 86_400_000 * 0.9));
      const customer = SAMPLE_CUSTOMERS[Math.floor(rand() * SAMPLE_CUSTOMERS.length)];
      const paid = kind.status === "executed" || kind.status === "approved";
      const id = `sample-${d}-${k}`;
      await store.addAudit({
        id,
        at,
        sample: true,
        mode: "protected",
        agentId: "acme-support",
        customerId: customer.id,
        tool: "create_refund",
        args: {},
        captureId: `SAMPLE-CAP-${d}${k}`,
        effectiveAmount: amt,
        decision: kind.status === "executed" ? "allow" : (kind.action ?? "block"),
        decidedBy: kind.decidedBy,
        hits: kind.ruleId ? [{ ruleId: kind.ruleId, action: kind.action!, reason: kind.reason!, source: kind.source! }] : [],
        spans: [],
        status: kind.status,
        requestId: `pw-sample-${d}-${k}`,
        paypal: paid ? { refundId: `SAMPLE-REF-${d}${k}`, status: "COMPLETED" } : undefined,
        webhookConfirmed: paid,
        latencyMs: 2 + Math.floor(rand() * 9),
        approval: kind.status === "approved" || kind.status === "rejected" ? { by: "merchant", at: new Date(at.getTime() + 9 * 60_000) } : undefined,
      });
    }
  }
}
