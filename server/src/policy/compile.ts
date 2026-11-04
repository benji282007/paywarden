// English -> rule. The model only picks one of the fixed rule kinds and fills in its
// numbers; the deterministic engine enforces it. If the sentence doesn't fit a kind,
// the compiler says so rather than approximating.

import type { Llm } from "../llm/types.js";
import type { Rule } from "./types.js";
import { validRule } from "./validate.js";

const SYSTEM = `You translate a merchant's plain-English refund rule for an AI support agent into ONE structured rule.
Only these rule kinds exist. Pick the single best fit, or set understood=false if none expresses the sentence faithfully.

- max_amount: a single call over {max} dollars is held or blocked. Needs tool, max.
- daily_count: more than {max} calls within a rolling window of {windowHours} hours (default 24), counted per customer or across the whole agent. Needs tool, max, per; set windowHours whenever the merchant names a period ("an hour" = 1, "a week" = 168).
- daily_total: more than {max} dollars within a rolling window of {windowHours} hours (default 24), per customer or across the whole agent. Needs tool, max, per; windowHours as above.
- max_order_age_days: refunds on orders older than {days} days. Needs days.
- owner_match: only refund orders that belong to the customer in the conversation.
- no_over_refund: never refund more than is still refundable on the payment.
- no_duplicate: no second refund on the same payment within {windowSeconds} seconds. Needs windowSeconds.
- untrusted_influence: stop calls steered by text customers can write into order data (notes, dispute messages).
- customer_asked: only move money when the customer asked for it in their own chat messages.
- request_match: if the customer names an order or an amount in chat, refunds must be for that order and not more than that amount.
- confirmed: only move money the customer confirmed themselves in the shop's own app (a signed confirmation), not just in chat text.
- deny_tool: the agent may never use {tool} at all. Needs tool.

tool is one of: create_refund (refunds, money back), accept_dispute_claim (accepting disputes/chargebacks), send_invoice (invoices).
action: "hold" when the merchant wants to approve/review/be asked first; "block" when it must never happen.
Convert time windows to the unit asked for (e.g. "an hour" = 3600 seconds, "a week" for orders = 7 days).
Do not invent numbers the merchant didn't give. If a needed number is missing, set understood=false and explain what's missing.
explanation: one short sentence, addressed to the merchant, saying what the rule will do (or why it can't be expressed).`;

const SCHEMA = {
  type: "object",
  properties: {
    understood: { type: "boolean" },
    kind: {
      type: "string",
      enum: ["max_amount", "daily_count", "daily_total", "max_order_age_days", "owner_match", "no_over_refund", "no_duplicate", "untrusted_influence", "customer_asked", "request_match", "confirmed", "deny_tool"],
    },
    action: { type: "string", enum: ["hold", "block"] },
    tool: { type: "string", enum: ["create_refund", "accept_dispute_claim", "send_invoice"] },
    max: { type: "number" },
    per: { type: "string", enum: ["customer", "agent"] },
    days: { type: "number" },
    windowSeconds: { type: "number" },
    windowHours: { type: "number" },
    explanation: { type: "string" },
  },
  required: ["understood", "explanation"],
};

type Compiled = {
  understood: boolean;
  explanation: string;
  kind?: string;
  action?: string;
  tool?: string;
  max?: number;
  per?: string;
  days?: number;
  windowSeconds?: number;
  windowHours?: number;
};

export type CompileResult = { ok: true; rule: Rule; explanation: string } | { ok: false; explanation: string };

const PARAMS: Record<string, string[]> = {
  max_amount: ["tool", "max"],
  daily_count: ["tool", "max", "per", "windowHours"],
  daily_total: ["tool", "max", "per", "windowHours"],
  max_order_age_days: ["days"],
  no_duplicate: ["windowSeconds"],
  deny_tool: ["tool"],
};

export async function compileRule(llm: Llm, english: string, existingIds: string[]): Promise<CompileResult> {
  const text = english.trim().slice(0, 500);
  if (!text) return { ok: false, explanation: "Type a rule first." };
  const out = await llm.json<Compiled>({ system: SYSTEM, prompt: text, schema: SCHEMA });
  if (!out.understood || !out.kind) return { ok: false, explanation: out.explanation || "That doesn't map to a rule Paywarden can enforce." };

  // Keep only the fields this kind uses, so a stray number can't change behavior.
  const rule: Record<string, unknown> = { id: "", kind: out.kind, action: out.action ?? "hold", source: text };
  for (const k of PARAMS[out.kind] ?? []) if (out[k as keyof Compiled] !== undefined) rule[k] = out[k as keyof Compiled];
  let n = 1;
  while (existingIds.includes(`custom-${n}`)) n++;
  rule.id = `custom-${n}`;

  if (!validRule(rule)) return { ok: false, explanation: `Couldn't build a complete rule from that (${out.explanation}). Try including the exact number.` };
  return { ok: true, rule, explanation: out.explanation };
}
