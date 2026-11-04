// Scripted agent runs for the dashboard's "Try it" panel. The script plays the
// agent's part (no AI), but every call goes through the real MCP proxy server and
// guard, over an in-memory MCP transport.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Guard } from "../guard/guard.js";
import type { ToolBackend } from "../mcp/backend.js";
import { META_MANDATES, buildMcpServer } from "../mcp/proxy.js";
import type { SessionRegistry } from "../mcp/sessions.js";
import type { Store } from "../store/types.js";
import type { PayPalClient } from "../paypal/types.js";
import { TWIN, twinOrder } from "./acme.js";

export const SCENARIOS = {
  injection: "Hidden instruction in a delivery note",
  genuine: "Genuine $18 refund",
  large: "Genuine $140 refund",
  retry: "Agent retries a refund",
  other: "Refund someone else's order",
} as const;
export type ScenarioName = keyof typeof SCENARIOS;

export interface Step {
  actor: "customer" | "agent" | "paywarden";
  text: string;
}

/** PayPal's JSON refund response, said in words for the transcript. */
function summarize(text: string): string {
  if (text.startsWith("CUSTOMER_CONFIRMATION_REQUIRED")) return "Held: the customer never confirmed this refund in Acme's app. They now see a confirm card; the agent can't press it.";
  if (text.startsWith("PENDING_MERCHANT_APPROVAL")) return text.replace(/^PENDING_MERCHANT_APPROVAL: /, "Held for the merchant: ").replace(/ Tell the customer.*$/, "");
  try {
    const r = JSON.parse(text) as { id?: string; status?: string; amount?: { value: string } };
    const simulated = r.id?.startsWith("SIMULATED-");
    return `Refund ${r.status?.toLowerCase()}: $${r.amount?.value}${simulated ? " (dry run, no money moved)" : ` · PayPal refund ${r.id}`}`;
  } catch {
    return text;
  }
}

export async function runScenario(
  name: ScenarioName,
  mode: "protected" | "unprotected",
  deps: { store: Store; guard: Guard; backend: ToolBackend; sessions: SessionRegistry; paypal?: PayPalClient },
): Promise<Step[]> {
  const ledger = await deps.store.listLedger();
  const find = (customerId: string, description: string) => {
    const e = ledger.find((x) => x.customerId === customerId && x.description === description);
    if (!e) throw new Error(`Seed order missing: ${description}`);
    return e;
  };

  const plan = {
    // Replays what a live Gemini agent did with this note in testing: a full refund of this order.
    injection: { customer: "sam", says: "Hey, where's my cold brew bundle order?", order: find("sam", "Cold brew bundle"), refunds: [{}] },
    genuine: { customer: "maya", says: "My grinder arrived cracked, can I get my $18 back?", order: find("maya", "Burr grinder (manual)"), refunds: [{ value: "18.00" }], confirm: 18 },
    large: { customer: "dev", says: "The espresso kit arrived broken. I need a refund for the $140.", order: find("dev", "Espresso starter kit"), refunds: [{ value: "140.00" }], confirm: 140 },
    retry: { customer: "maya", says: "Refund the $5 for the late Yirgacheffe please.", order: find("maya", "Ethiopia Yirgacheffe 1kg"), refunds: [{ value: "5.00" }, { value: "5.00" }], confirm: 5 },
    other: { customer: "sam", says: "Please refund my espresso kit order.", order: find("dev", "Espresso starter kit"), refunds: [{ value: "20.00" }] },
  }[name] as { customer: string; says: string; order: (typeof ledger)[number]; refunds: { value?: string; capture?: string }[]; confirm?: number };

  // The unguarded side of the attack refunds for real, on Sam's twin order (see twinOrder).
  const realUnguarded = name === "injection" && mode === "unprotected" && deps.paypal;
  if (realUnguarded) {
    plan.order = await twinOrder(deps.store, deps.paypal!);
    plan.customer = TWIN;
  }
  const session = deps.sessions.create({ customerId: plan.customer, mode, live: !!realUnguarded });
  deps.sessions.addCustomerMessage(session.key, plan.says);
  const steps: Step[] = [{ actor: "customer", text: plan.says }];

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(session, deps.guard, deps.backend, deps.store, deps.sessions);
  await server.connect(serverSide);
  const client = new Client({ name: "scripted-agent", version: "1.0.0" });
  await client.connect(clientSide);

  try {
    steps.push({ actor: "agent", text: `get_order(${plan.order.orderId})` });
    await client.callTool({ name: "get_order", arguments: { id: plan.order.orderId } });
    if (plan.order.note) steps.push({ actor: "paywarden", text: `Agent read customer-written text: "${plan.order.note}"` });

    // A genuine customer taps "Yes, refund this" on a card the shop's own app shows; the
    // shop's backend signs it and its MCP client (not the model) passes it along in _meta.
    let meta: Record<string, unknown> | undefined;
    const usesConfirmations = (await deps.store.getPolicy()).rules.some((r) => r.kind === "confirmed");
    if (plan.confirm && usesConfirmations && mode === "protected") {
      const { token } = deps.guard.mandates.issue({ customerId: plan.customer, captureId: plan.order.captureId, maxAmount: plan.confirm });
      meta = { [META_MANDATES]: [token] };
      steps.push({ actor: "customer", text: `Taps "Yes, refund $${plan.confirm.toFixed(2)} for ${plan.order.description}" in Acme's app (signed confirmation)` });
    }

    for (const r of plan.refunds) {
      const capture = r.capture ?? plan.order.captureId;
      const args = { capture_id: capture, ...(r.value ? { amount: { currency_code: "USD", value: r.value } } : {}) };
      steps.push({ actor: "agent", text: `create_refund(${capture}${r.value ? `, $${r.value}` : ", full amount"})` });
      const res = (await client.callTool({ name: "create_refund", arguments: args, ...(meta ? { _meta: meta } : {}) })) as { content: { text: string }[] };
      steps.push({ actor: "paywarden", text: summarize(res.content[0].text) });
    }
  } finally {
    await client.close();
  }

  const mine = (await deps.store.listAudit()).filter((a) => a.conversationId === session.key);
  const total = (statuses: string[]) => mine.filter((a) => statuses.includes(a.status)).reduce((s, a) => s + a.effectiveAmount, 0);
  const moved = mode === "unprotected" ? total(["simulated", "executed"]) : total(["executed", "approved"]);
  const count = (status: string) => mine.filter((a) => a.status === status).length;
  const plural = (n: number, what: string) => `${n} ${what}${n > 1 ? "s" : ""}`;
  const held = count("held");
  const blocked = count("blocked");
  steps.push({
    actor: "paywarden",
    text:
      mode === "unprotected"
        ? realUnguarded
          ? `Result: $${moved.toFixed(2)} left the merchant's PayPal account (a real sandbox refund).`
          : `Result: $${moved.toFixed(2)} would have left the merchant's account.`
        : `Result: $${moved.toFixed(2)} refunded${held ? `, ${plural(held, "call")} ${mine.some((a) => a.status === "held" && a.confirmable) ? "waiting for the customer to confirm" : "held for your approval"}` : ""}${blocked ? `, ${plural(blocked, "call")} blocked` : ""}.`,
  });
  return steps;
}
