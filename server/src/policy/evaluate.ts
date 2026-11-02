import {
  MONEY_TOOLS,
  type CaptureRecord,
  type Decision,
  type EvalContext,
  type MoneyTool,
  type Policy,
  type PolicyResult,
  type Rule,
  type RuleHit,
  type ToolCall,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function isMoneyTool(tool: string): tool is MoneyTool {
  return (MONEY_TOOLS as readonly string[]).includes(tool);
}

function parseAmount(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  const value = typeof raw === "object" ? (raw as { value?: unknown }).value : raw;
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Deterministic policy evaluation. The strictest hit wins: block > hold > allow.
 * Read-only tools always pass; the proxy only guards calls that move money.
 */
export function evaluate(policy: Policy, call: ToolCall, ctx: EvalContext): PolicyResult {
  if (!isMoneyTool(call.tool)) return { decision: "allow", hits: [], effectiveAmount: 0 };

  const hits: RuleHit[] = [];
  const captureId = typeof call.args.capture_id === "string" ? call.args.capture_id : undefined;
  const capture = captureId ? ctx.getCapture(captureId) : undefined;
  const requested = parseAmount(call.args.amount);

  // PayPal refunds the full remaining capture when amount is omitted, so price the call that way.
  let effectiveAmount = requested ?? 0;
  if (call.tool === "create_refund") {
    if (!capture) {
      // Built-in invariant, not configurable: never refund money we can't trace to a customer.
      hits.push({
        ruleId: "builtin.unknown_capture",
        action: "block",
        reason: `Capture ${captureId ?? "(missing)"} is not in the merchant ledger`,
        source: "Refunds must reference a known capture.",
      });
    } else {
      effectiveAmount = requested ?? round2(capture.amount - capture.refunded);
    }
  }

  for (const rule of policy.rules) {
    const reason = check(rule, call.tool as MoneyTool, effectiveAmount, capture, captureId, ctx);
    if (reason) hits.push({ ruleId: rule.id, action: rule.action, reason, source: rule.source });
  }

  return { decision: strictest(hits), hits, effectiveAmount };
}

function strictest(hits: RuleHit[]): Decision {
  if (hits.some((h) => h.action === "block")) return "block";
  if (hits.some((h) => h.action === "hold")) return "hold";
  return "allow";
}

/** Returns a human-readable reason when the rule is violated, otherwise undefined. */
function check(
  rule: Rule,
  tool: MoneyTool,
  amount: number,
  capture: CaptureRecord | undefined,
  captureId: string | undefined,
  ctx: EvalContext,
): string | undefined {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const recent = (scope: "customer" | "agent", t: MoneyTool) =>
    ctx.history.filter(
      (h) =>
        h.tool === t &&
        ctx.now.getTime() - h.at.getTime() < DAY_MS &&
        (scope === "agent" || h.customerId === ctx.customerId),
    );

  switch (rule.kind) {
    case "deny_tool":
      return rule.tool === tool ? `${tool} is not permitted for this agent` : undefined;

    case "max_amount":
      return rule.tool === tool && amount > rule.max
        ? `${usd(amount)} exceeds the ${usd(rule.max)} limit`
        : undefined;

    case "daily_count": {
      if (rule.tool !== tool) return undefined;
      const n = recent(rule.per, tool).length;
      return n + 1 > rule.max ? `Would be call #${n + 1} in 24h (limit ${rule.max} per ${rule.per})` : undefined;
    }

    case "daily_total": {
      if (rule.tool !== tool) return undefined;
      const total = recent(rule.per, tool).reduce((s, h) => s + h.amount, 0);
      return total + amount > rule.max
        ? `24h total would reach ${usd(total + amount)} (limit ${usd(rule.max)} per ${rule.per})`
        : undefined;
    }

    case "owner_match":
      return tool === "create_refund" && capture && capture.customerId !== ctx.customerId
        ? `Capture ${capture.captureId} belongs to a different customer than the one in this conversation`
        : undefined;

    case "no_over_refund": {
      if (tool !== "create_refund" || !capture) return undefined;
      const remaining = round2(capture.amount - capture.refunded);
      return amount > remaining
        ? `${usd(amount)} exceeds the ${usd(remaining)} still refundable on this capture`
        : undefined;
    }

    case "max_order_age_days": {
      if (tool !== "create_refund" || !capture) return undefined;
      const ageDays = (ctx.now.getTime() - capture.capturedAt.getTime()) / DAY_MS;
      return ageDays > rule.days
        ? `Order is ${Math.floor(ageDays)} days old (limit ${rule.days})`
        : undefined;
    }

    case "no_duplicate": {
      if (tool !== "create_refund" || !captureId) return undefined;
      const dup = ctx.history.find(
        (h) =>
          h.tool === "create_refund" &&
          h.captureId === captureId &&
          ctx.now.getTime() - h.at.getTime() < rule.windowSeconds * 1000,
      );
      return dup ? `Capture ${captureId} was already refunded ${usd(dup.amount)} moments ago` : undefined;
    }

    case "untrusted_influence":
      return ctx.untrustedInfluence?.length
        ? `Influenced by customer-writable data: ${ctx.untrustedInfluence.map((u) => u.reason).join("; ")}`
        : undefined;
  }
}
