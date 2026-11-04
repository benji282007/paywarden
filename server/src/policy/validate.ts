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
    case "refund_rate":
      return isNum(x.maxRatio) && (x.maxRatio as number) > 0 && (x.maxRatio as number) <= 1 && isNum(x.minRefunds) && isNum(x.windowDays) && (x.windowDays as number) > 0;
    case "owner_match":
    case "no_over_refund":
    case "untrusted_influence":
    case "customer_asked":
    case "request_match":
    case "confirmed":
      return true;
    default:
      return false;
  }
}

export function validPolicy(p: unknown): p is Policy {
  const rules = (p as Policy | undefined)?.rules;
  return Array.isArray(rules) && rules.every(validRule) && new Set(rules.map((r) => r.id)).size === rules.length;
}

const usd = (n: number) => `$${n}`;
const per = (r: { per: string }) => (r.per === "agent" ? "across the whole agent" : "per customer");
const win = (r: { windowHours?: number }) => (!r.windowHours || r.windowHours === 24 ? "a day" : r.windowHours === 1 ? "an hour" : `${r.windowHours} hours`);
const what = (tool: string) => (tool === "create_refund" ? "refunds" : tool === "accept_dispute_claim" ? "accepted disputes" : "invoices");
const act = (a: string) => (a === "hold" ? "need my approval" : "are blocked");

/** What a rule actually does, in plain English, generated from the rule itself. */
export function describeRule(r: Rule): string {
  switch (r.kind) {
    case "max_amount":
      return `${what(r.tool)[0].toUpperCase()}${what(r.tool).slice(1)} over ${usd(r.max)} ${act(r.action)}.`;
    case "daily_count":
      return `More than ${r.max} ${what(r.tool)} in ${win(r)} ${per(r)} ${act(r.action)}.`;
    case "daily_total":
      return `${what(r.tool)[0].toUpperCase()}${what(r.tool).slice(1)} totalling more than ${usd(r.max)} in ${win(r)} ${per(r)} ${act(r.action)}.`;
    case "max_order_age_days":
      return `Refunds on orders older than ${r.days} days ${act(r.action)}.`;
    case "no_duplicate":
      return `A second refund on the same payment within ${Math.round(r.windowSeconds / 60)} minutes is ${r.action === "hold" ? "held for approval" : "blocked"}.`;
    case "deny_tool":
      return `The agent may never use ${r.tool.replaceAll("_", " ")}.`;
    case "owner_match":
      return `Refunds on someone else's order ${act(r.action)}.`;
    case "no_over_refund":
      return `Refunding more than was paid ${r.action === "hold" ? "needs my approval" : "is blocked"}.`;
    case "untrusted_influence":
      return `Refunds steered by text customers typed into order data ${act(r.action)}.`;
    case "customer_asked":
      return `Refunds the customer never asked for in the chat ${act(r.action)}.`;
    case "request_match":
      return `Refunds for a different order, or more money, than the customer named in the chat ${act(r.action)}.`;
    case "refund_rate":
      return `Refunds for customers who've had ${r.minRefunds}+ refunds and more than ${Math.round(r.maxRatio * 100)}% of their spend back in ${r.windowDays} days ${act(r.action)}.`;
    case "confirmed":
      return `Refunds the customer hasn't confirmed in the shop's own app ${act(r.action)}.`;
  }
}
