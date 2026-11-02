// Provenance taint: text that a customer can write into PayPal data (order notes,
// item descriptions, dispute messages, invoice memos) is data, never instructions.
// We flag money-moving calls that such text may have steered, and point at the span.

import type { ToolCall } from "../policy/types.js";

/** A piece of customer-writable text the agent saw this turn, e.g. an order note returned by get_order. */
export interface UntrustedSource {
  /** Where it came from, shown to the merchant: "order 5O190127 · shipping note". */
  origin: string;
  text: string;
}

/** Text that legitimately expresses intent: the authenticated customer's chat messages. */
export interface TrustedSource {
  origin: string;
  text: string;
}

export interface TaintedSpan {
  origin: string;
  start: number;
  end: number;
  text: string;
  kind: "instruction" | "argument";
  reason: string;
}

export interface ProvenanceResult {
  tainted: boolean;
  spans: TaintedSpan[];
  reasons: string[];
}

// Phrases that address the agent rather than describe an order. Kept deliberately
// narrow: a false positive here only holds a call for approval, it never blocks.
const INSTRUCTION_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(instructions?|rules?|polic(y|ies)|limits?|prompt)\b/gi, why: "tries to override the agent's rules" },
  { re: /\b(system|assistant|developer)\s*(prompt|message|note)?\s*:/gi, why: "impersonates a system or assistant message" },
  { re: /\byou are now\b|\bnew instructions?\b|\bdeveloper mode\b|\bjailbreak\b/gi, why: "tries to reprogram the agent" },
  { re: /\b(i am|i'm|this is)\s+(the\s+)?(store\s+)?(owner|admin|manager|merchant)\b/gi, why: "claims merchant authority" },
  { re: /\b(issue|process|send|give|make)\b[^.\n]{0,30}\brefunds?\b/gi, why: "instructs a refund from inside order data" },
  { re: /\brefund\b[^.\n]{0,30}\b(all|every|each|full|entire|everything)\b/gi, why: "instructs a bulk or full refund" },
  { re: /\baccept\b[^.\n]{0,20}\b(claim|dispute)\b/gi, why: "instructs accepting a dispute" },
  { re: /\b(do not|don't|never)\s+(tell|mention|ask|notify|escalate|confirm)\b/gi, why: "asks the agent to hide its actions" },
  { re: /\[\s*\/?\s*(inst|system)\s*\]|<\s*\/?\s*(system|instructions?)\s*>|<!--/gi, why: "contains prompt-format markup" },
];

/** Every string or number leaf in the args, so nested shapes like amount.value are covered. */
function argLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number") out.push(String(value));
  else if (value && typeof value === "object") for (const v of Object.values(value)) argLeaves(v, out);
  return out;
}

/** Spellings of an argument value that might appear in prose: "140.00" also matches "$140" and "140". */
function variants(leaf: string): string[] {
  const n = Number(leaf);
  if (leaf.trim() !== "" && Number.isFinite(n)) {
    return [...new Set([leaf, n.toFixed(2), String(n)])];
  }
  return [leaf];
}

function findAll(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + 1)) {
    // Require token boundaries so "5" doesn't match inside "2025".
    const before = h[i - 1];
    const after = h[i + n.length];
    if ((!before || !/[a-z0-9]/.test(before)) && (!after || !/[a-z0-9]/.test(after))) hits.push(i);
  }
  return hits;
}

export function findInstructionSpans(source: UntrustedSource): TaintedSpan[] {
  const spans: TaintedSpan[] = [];
  for (const { re, why } of INSTRUCTION_PATTERNS) {
    for (const m of source.text.matchAll(re)) {
      spans.push({ origin: source.origin, start: m.index!, end: m.index! + m[0].length, text: m[0], kind: "instruction", reason: why });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Decide whether a money-moving call was plausibly steered by customer-writable data.
 *
 * Two independent signals:
 *  1. Instruction text: an untrusted source the agent read this turn addresses the agent.
 *  2. Argument derivation: a call argument (capture id, amount) appears in untrusted text
 *     but nowhere in what the customer actually said in chat.
 */
export function analyzeProvenance(
  call: ToolCall,
  untrusted: UntrustedSource[],
  trusted: TrustedSource[],
): ProvenanceResult {
  const spans: TaintedSpan[] = [];
  const reasons: string[] = [];

  for (const src of untrusted) {
    const found = findInstructionSpans(src);
    if (found.length) {
      spans.push(...found);
      reasons.push(`${src.origin} ${found[0].reason}: "${found[0].text}"`);
    }
  }

  const trustedText = trusted.map((t) => t.text).join("\n");
  for (const leaf of argLeaves(call.args)) {
    // Very short values (currency codes, "1") are too common to attribute.
    if (leaf.length < 2 || /^[A-Z]{3}$/.test(leaf)) continue;
    const forms = variants(leaf);
    if (forms.some((f) => findAll(trustedText, f).length)) continue;
    for (const src of untrusted) {
      for (const f of forms) {
        for (const start of findAll(src.text, f)) {
          spans.push({ origin: src.origin, start, end: start + f.length, text: src.text.slice(start, start + f.length), kind: "argument", reason: `argument "${leaf}" came from this text, not from the customer` });
        }
      }
    }
    if (spans.some((s) => s.kind === "argument" && s.reason.includes(`"${leaf}"`))) {
      reasons.push(`argument "${leaf}" only appears in customer-writable data`);
    }
  }

  return { tainted: reasons.length > 0, spans, reasons };
}
