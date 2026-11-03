// "Ask your audit log": the dashboard sends AG Grid's own structured schema
// (gridApi.getStructuredSchema(), AG Grid AI Toolkit) and a plain-English question; the
// model answers with a grid state the browser applies with gridApi.setState().

import { LlmError } from "../llm/gemini.js";
import type { JsonSchema, Llm } from "../llm/types.js";

const SYSTEM = `You control an AG Grid showing a merchant's audit log of refunds an AI support agent attempted.
Turn the merchant's request into a grid state object that matches the provided JSON Schema exactly.
Use only column ids and values that appear in the schema. Prefer filters and sorting; group rows and aggregate amounts when the request asks for totals or "by" something.
Outcome values: refunded (executed), approved, held, blocked, rejected, failed, dry run (simulated).
Return only the state object. Also include "explanation": one short sentence for the merchant describing what the grid now shows.`;

// Only these parts of grid state may be changed by the model.
const ALLOWED = new Set(["filter", "sort", "rowGroup", "aggregation", "columnVisibility", "explanation"]);

export async function askGrid(llm: Llm, schema: JsonSchema, question: string): Promise<{ state: Record<string, unknown>; explanation: string }> {
  const q = question.trim().slice(0, 300);
  if (!q) throw new Error("Ask a question about the audit log.");
  const withExplanation: JsonSchema = {
    ...schema,
    properties: { ...((schema.properties as Record<string, unknown>) ?? {}), explanation: { type: "string" } },
  };
  let raw: Record<string, unknown>;
  try {
    raw = await llm.json<Record<string, unknown>>({ system: SYSTEM, prompt: q, schema: withExplanation, timeoutMs: 60_000 });
  } catch (err) {
    // Some providers reject parts of AG Grid's schema; fall back to describing it in the prompt.
    if (!(err instanceof LlmError) || err.status !== 400) throw err;
    raw = await llm.json<Record<string, unknown>>({
      system: `${SYSTEM}\nJSON Schema of the grid state:\n${JSON.stringify(schema).slice(0, 40_000)}`,
      prompt: q,
      schema: { type: "object", properties: { explanation: { type: "string" } } },
      timeoutMs: 60_000,
    });
  }
  const state = Object.fromEntries(Object.entries(raw).filter(([k]) => ALLOWED.has(k) && k !== "explanation"));
  cleanFilters(state);
  return { state, explanation: typeof raw.explanation === "string" ? raw.explanation : "Updated the grid." };
}

/**
 * Small models tend to emit a filter for every column, often a set filter with no
 * values, which in AG Grid means "match nothing" and empties the grid. Drop those.
 */
export function cleanFilters(state: Record<string, unknown>) {
  const filter = state.filter as { filterModel?: Record<string, { filterType?: string; values?: unknown[]; conditions?: unknown[]; filter?: unknown; type?: string }> } | undefined;
  const model = filter?.filterModel;
  if (!model) return;
  for (const [col, f] of Object.entries(model)) {
    const emptySet = f?.filterType === "set" && (!Array.isArray(f.values) || f.values.length === 0);
    const emptyText = f?.filterType === "text" && !f.filter && !f.conditions?.length && f.type !== "blank" && f.type !== "notBlank";
    if (!f || emptySet || emptyText) delete model[col];
  }
  if (Object.keys(model).length === 0) delete state.filter;
}
