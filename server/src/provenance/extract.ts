// Because every PayPal read passes through the proxy, Paywarden sees exactly which
// customer-writable text the agent was shown, without the agent's cooperation.

import type { UntrustedSource } from "./analyze.js";

/**
 * Fields in PayPal API responses whose contents a buyer (or anyone outside the
 * merchant) can author: checkout notes passed through custom_id, payer notes,
 * dispute messages, invoice memos. Keys are matched at any depth.
 */
const UNTRUSTED_KEYS = new Set([
  "custom_id",
  "note",
  "note_to_payer",
  "note_to_payee",
  "payer_note",
  "buyer_note",
  "memo",
  "content", // dispute messages[].content
  "dispute_life_cycle_message",
  "reason_details",
  "buyer_requested_amount_note",
  // Names and addresses are typed by the buyer at checkout.
  "full_name",
  "given_name",
  "surname",
  "address_line_1",
  "address_line_2",
]);

// Plain words for the merchant; the raw field path stays in parentheses for engineers.
const FIELD_LABEL: Record<string, string> = {
  custom_id: "checkout note",
  note: "note",
  note_to_payer: "note to payer",
  note_to_payee: "note to seller",
  payer_note: "buyer note",
  buyer_note: "buyer note",
  memo: "memo",
  content: "buyer message",
  dispute_life_cycle_message: "dispute message",
  reason_details: "dispute reason",
  buyer_requested_amount_note: "buyer's amount note",
  full_name: "name",
  given_name: "first name",
  surname: "last name",
  address_line_1: "address",
  address_line_2: "address line 2",
};
const TOOL_LABEL: Record<string, string> = {
  get_order: "order",
  get_dispute: "dispute",
  list_disputes: "disputes",
  get_invoice: "invoice",
  list_invoices: "invoices",
};

export function extractUntrusted(tool: string, result: unknown, idHint?: string): UntrustedSource[] {
  const out: UntrustedSource[] = [];
  const thing = TOOL_LABEL[tool] ?? tool;
  const label = idHint ? `${thing} ${idHint}` : thing;

  const walk = (value: unknown, path: string[]) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...path.slice(0, -1), `${path.at(-1) ?? ""}[${i}]`]));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === "string" && UNTRUSTED_KEYS.has(k) && v.trim()) {
          out.push({ origin: `${label} · ${FIELD_LABEL[k] ?? k} (${[...path, k].filter(Boolean).join(".")})`, text: v });
        } else {
          walk(v, [...path, k]);
        }
      }
    }
  };

  // Tool results usually arrive as JSON text; fall back to scanning raw text as-is.
  if (typeof result === "string") {
    try {
      walk(JSON.parse(result), []);
    } catch {
      // Not JSON, so we can't tell which part a customer wrote: treat all of it as untrusted.
      if (result.trim()) out.push({ origin: `${label} · raw response`, text: result.slice(0, 4000) });
    }
  } else {
    walk(result, []);
  }
  return out;
}
