import { describe, expect, it } from "vitest";
import { botTurn } from "../src/agent/bot.js";
import { ACME_POLICY, seedAcme } from "../src/demo/acme.js";
import { Guard } from "../src/guard/guard.js";
import type { ChatMessage, Llm } from "../src/llm/types.js";
import { SimBackend } from "../src/mcp/backend.js";
import { SessionRegistry } from "../src/mcp/sessions.js";
import { MemoryPayPalClient } from "../src/paypal/memory.js";
import { MemoryStore } from "../src/store/memory.js";

/** A model that obeys whatever the order note says, i.e. a fully injectable agent. */
function obedientModel(store: MemoryStore): Llm & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  return {
    model: "fake",
    seen,
    json: () => Promise.reject(new Error("unused")),
    async chat({ messages }) {
      seen.push(structuredClone(messages));
      const last = messages.at(-1)!;
      const sam = (await store.listLedger("sam")).sort((a, b) => a.amount - b.amount);
      const bundle = sam.find((o) => o.description === "Cold brew bundle")!;
      if (last.role === "user" && last.parts[0].kind === "text") {
        return { role: "model", parts: [{ kind: "call", id: "1", name: "get_order", args: { id: bundle.orderId } }] };
      }
      const results = last.parts.filter((p) => p.kind === "result");
      if (results.some((r) => r.kind === "result" && r.name === "get_order")) {
        return { role: "model", parts: sam.map((o, i) => ({ kind: "call" as const, id: `r${i}`, name: "create_refund", args: { capture_id: o.captureId } })) };
      }
      return { role: "model", parts: [{ kind: "text", text: "All sorted!" }] };
    },
  };
}

async function setup() {
  const store = new MemoryStore(ACME_POLICY);
  const paypal = new MemoryPayPalClient();
  await seedAcme(store, paypal);
  const sessions = new SessionRegistry();
  const deps = { store, guard: new Guard(store, paypal), backend: new SimBackend(store), sessions };
  return { store, paypal, sessions, deps };
}

describe("support bot", () => {
  it("an injectable agent can't move money through Paywarden", async () => {
    const { store, paypal, sessions, deps } = await setup();
    const s = sessions.create({ customerId: "sam" });
    const out = await botTurn(obedientModel(store), deps, s.key, "Hey, where's my order?");
    expect(out.reply).toBe("All sorted!");
    expect(out.trace.filter((t) => t.kind === "tool_call").map((t) => t.tool)).toEqual(["get_order", "create_refund", "create_refund", "create_refund"]);
    expect(out.trace.filter((t) => t.tool === "create_refund" && t.kind === "tool_result").every((t) => t.text.startsWith("PENDING_MERCHANT_APPROVAL"))).toBe(true);
    expect(paypal.refundCalls).toBe(0);
    expect((await store.listAudit()).map((a) => a.status)).toEqual(["held", "held", "held"]);
  });

  it("keeps the conversation across turns and feeds tool results back", async () => {
    const { store, sessions, deps } = await setup();
    const model = obedientModel(store);
    const s = sessions.create({ customerId: "sam" });
    await botTurn(model, deps, s.key, "Hi");
    const lastSeen = model.seen.at(-1)!;
    expect(lastSeen.some((m) => m.parts.some((p) => p.kind === "result" && p.name === "create_refund"))).toBe(true);
    expect(sessions.get(s.key)!.trusted.map((t) => t.text)).toEqual(["Hi"]);
  });
});
