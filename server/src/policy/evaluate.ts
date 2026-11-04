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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function isMoneyTool(tool: string): tool is MoneyTool {
  return (MONEY_TOOLS as readonly string[]).includes(tool);
}

/**
 * The one place a tool call's amount is read. The guard prices the call and the
 * executor sends it from this same result, so they can never disagree about how
 * much money moves. Accepted: omitted (= full remaining refund), or PayPal's
 * {currency_code, value} with a positive value and at most two decimals.
 */
export function parseAmount(raw: unknown): { ok: true; value?: number; currency?: string } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "amount must be an object like {currency_code, value}" };
  const { value, currency_code } = raw as { value?: unknown; currency_code?: unknown };
  if (typeof value !== "string" || !/^\d{1,10}(\.\d{1,2})?$/.test(value)) return { ok: false, reason: `amount.value ${JSON.stringify(value)} is not a plain decimal like "18.00"` };
  const n = Number(value);
  if (!(n > 0)) return { ok: false, reason: "amount must be greater than zero" };
  if (typeof currency_code !== "string" || !/^[A-Z]{3}$/.test(currency_code)) return { ok: false, reason: "amount.currency_code must be a 3-letter code" };
  return { ok: true, value: n, currency: currency_code };
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
  const parsed = parseAmount(call.args.amount);
  const requested = parsed.ok ? parsed.value : undefined;
  if (!parsed.ok) {
    // Built-in: an amount the guard can't read exactly is never sent to PayPal.
    hits.push({ ruleId: "builtin.invalid_amount", action: "block", reason: parsed.reason, source: "Amounts must be exact and positive." });
  }

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
      if (parsed.ok && parsed.currency && parsed.currency !== capture.currency) {
        hits.push({
          ruleId: "builtin.currency_mismatch",
          action: "block",
          reason: `Refund in ${parsed.currency} but the payment was in ${capture.currency}`,
          source: "Refunds must be in the payment's currency.",
        });
      }
    }
  }

  // A signed confirmation for this capture and amount replaces the text-based "who asked" checks.
  const settledBySignature = new Set(ctx.mandate ? ["customer_asked", "request_match", "untrusted_influence"] : []);
  for (const rule of policy.rules) {
    if (settledBySignature.has(rule.kind)) continue;
    const reason = check(rule, call.tool as MoneyTool, effectiveAmount, capture, captureId, ctx);
    if (reason) hits.push({ ruleId: rule.id, action: rule.action, reason, source: rule.source });
  }

  return { decision: strictest(hits), hits, effectiveAmount };
}

const window = (hours: number) => (hours === 24 ? "24h" : hours === 1 ? "1 hour" : `${hours} hours`);

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
  const recent = (scope: "customer" | "agent", t: MoneyTool, hours = 24) =>
    ctx.history.filter(
      (h) =>
        h.tool === t &&
        ctx.now.getTime() - h.at.getTime() < hours * HOUR_MS &&
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
      const hours = rule.windowHours ?? 24;
      const n = recent(rule.per, tool, hours).length;
      return n + 1 > rule.max ? `Would be call #${n + 1} in ${window(hours)} (limit ${rule.max} per ${rule.per})` : undefined;
    }

    case "daily_total": {
      if (rule.tool !== tool) return undefined;
      const hours = rule.windowHours ?? 24;
      const total = recent(rule.per, tool, hours).reduce((s, h) => s + h.amount, 0);
      return total + amount > rule.max
        ? `Total in ${window(hours)} would reach ${usd(total + amount)} (limit ${usd(rule.max)} per ${rule.per})`
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

    case "request_match": {
      const req = ctx.requested;
      if (tool !== "create_refund" || !req || !capture) return undefined;
      if (req.captureIds.length && !req.captureIds.includes(capture.captureId)) {
        return `The customer asked about a different order; this refund is for capture ${capture.captureId}`;
      }
      if (req.maxAmount !== undefined && amount > req.maxAmount + 0.01) {
        return `The customer asked for ${usd(req.maxAmount)}; this refund is ${usd(amount)}`;
      }
      return undefined;
    }

    case "confirmed":
      return ctx.mandate
        ? undefined
        : tool === "create_refund"
          ? "The customer hasn't confirmed this refund in the shop's app (no signed confirmation for this order and amount)"
          : `The customer hasn't confirmed ${tool.replaceAll("_", " ")} in the shop's app`;

    case "customer_asked":
      return ctx.customerAsked === false
        ? tool === "create_refund"
          ? "The customer never asked for a refund in their own words; the request came from somewhere else"
          : `The customer never asked for ${tool.replaceAll("_", " ")} in their own words`
        : undefined;

    case "untrusted_influence":
      return ctx.untrustedInfluence?.length
        ? `Influenced by customer-writable data: ${ctx.untrustedInfluence.map((u) => u.reason).join("; ")}`
        : undefined;
  }
}
