import { MONEY_TOOLS, type Policy, type Rule } from "./types.js";

const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isTool = (v: unknown) => (MONEY_TOOLS as readonly unknown[]).includes(v);

/** Structural check of one rule; whatever produced it (a person or the compiler) must pass this. */
export function validRule(r: unknown): r is Rule {
  const x = r as Record<string, unknown> | null;
  if (!x || typeof x.id !== "string" || typeof x.source !== "string" || (x.action !== "hold" && x.action !== "block")) return false;
  switch (x.kind) {
    case "max_amount":
      return isTool(x.tool) && isNum(x.max);
    case "daily_count":
    case "daily_total":
      return isTool(x.tool) && isNum(x.max) && (x.per === "customer" || x.per === "agent") && (x.windowHours === undefined || (isNum(x.windowHours) && (x.windowHours as number) > 0));
    case "max_order_age_days":
      return isNum(x.days);
    case "no_duplicate":
      return isNum(x.windowSeconds);
    case "deny_tool":
      return isTool(x.tool);
    case "owner_match":
    case "no_over_refund":
    case "untrusted_influence":
    case "customer_asked":
      return true;
    default:
      return false;
  }
}

export function validPolicy(p: unknown): p is Policy {
  const rules = (p as Policy | undefined)?.rules;
  return Array.isArray(rules) && rules.every(validRule) && new Set(rules.map((r) => r.id)).size === rules.length;
}
