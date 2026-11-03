// Policy backtest: replay past refund decisions under a draft policy before it goes live.
// Each past call is re-evaluated with its own original context (who it was for, how much,
// which rule fired then), so the merchant sees exactly which decisions would change.

import type { AuditEntry } from "../store/types.js";
import { evaluate } from "./evaluate.js";
import type { CaptureRecord, Decision, ExecutedCall, Policy } from "./types.js";

export interface BacktestRow {
  id: string;
  at: Date;
  customerId: string;
  amount: number;
  before: Decision;
  after: Decision;
  reason: string;
}

export interface BacktestReport {
  replayed: number;
  changed: BacktestRow[];
  /** Refunds that went out before and would now wait or be refused, and the reverse. */
  newlyStopped: { count: number; amount: number };
  newlyAllowed: { count: number; amount: number };
}

const decisionOf = (e: AuditEntry): Decision =>
  e.status === "executed" ? "allow" : e.status === "blocked" ? "block" : e.status === "held" || e.status === "approved" || e.status === "rejected" ? "hold" : e.decision;

/**
 * Re-decide each past protected refund under `draft`. Signals that depend on the live
 * conversation (who asked, untrusted text) are carried over from the original decision,
 * since the chat itself isn't replayed; ledger and velocity checks are recomputed from the
 * history as it stood at that moment.
 */
export function backtest(draft: Policy, audit: AuditEntry[]): BacktestReport {
  const past = audit
    .filter((e) => e.mode === "protected" && e.tool === "create_refund" && e.status !== "failed")
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const changed: BacktestRow[] = [];
  const newlyStopped = { count: 0, amount: 0 };
  const newlyAllowed = { count: 0, amount: 0 };
  const executedSoFar: ExecutedCall[] = [];
  const refundedByCapture = new Map<string, number>();

  for (const e of past) {
    const firedBefore = new Set(e.hits.map((h) => h.ruleId));
    const captureId = e.captureId ?? "unknown";
    // A synthetic capture that belongs to this customer with enough headroom, unless the
    // original decision said otherwise (other customer, over-refund): those carry over.
    const capture: CaptureRecord = {
      captureId,
      customerId: firedBefore.has("own-orders") ? `${e.customerId}-other` : e.customerId,
      amount: firedBefore.has("no-over") ? e.effectiveAmount / 2 : Math.max(e.effectiveAmount, 1) * 10,
      refunded: refundedByCapture.get(captureId) ?? 0,
      currency: "USD",
      capturedAt: firedBefore.has("age-60") ? new Date(e.at.getTime() - 90 * 86_400_000) : new Date(e.at.getTime() - 3 * 86_400_000),
    };
    const result = evaluate(
      draft,
      { tool: "create_refund", args: { capture_id: captureId, amount: { currency_code: "USD", value: e.effectiveAmount.toFixed(2) } } },
      {
        now: e.at,
        customerId: e.customerId,
        agentId: e.agentId,
        getCapture: (id) => (id === captureId ? capture : undefined),
        // A past duplicate block implies an earlier refund on that capture moments before.
        history: firedBefore.has("no-dup")
          ? [...executedSoFar, { tool: "create_refund", customerId: e.customerId, captureId, amount: e.effectiveAmount, at: new Date(e.at.getTime() - 60_000) }]
          : [...executedSoFar],
        untrustedInfluence: firedBefore.has("untrusted") ? [{ reason: "same customer-written text as the original call" }] : undefined,
        customerAsked: firedBefore.has("asked") ? false : true,
      },
    );
    const before = decisionOf(e);
    const after = result.decision;
    if (after === "allow") {
      executedSoFar.push({ tool: "create_refund", customerId: e.customerId, captureId, amount: e.effectiveAmount, at: e.at });
      refundedByCapture.set(captureId, (refundedByCapture.get(captureId) ?? 0) + e.effectiveAmount);
    }
    if (before !== after) {
      changed.push({ id: e.id, at: e.at, customerId: e.customerId, amount: e.effectiveAmount, before, after, reason: result.hits.find((h) => h.action === after)?.reason ?? "Within the new rules" });
      if (before === "allow") {
        newlyStopped.count++;
        newlyStopped.amount += e.effectiveAmount;
      } else if (after === "allow") {
        newlyAllowed.count++;
        newlyAllowed.amount += e.effectiveAmount;
      }
    }
  }
  return { replayed: past.length, changed, newlyStopped, newlyAllowed };
}
