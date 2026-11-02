import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ACME_POLICY, seedAcme } from "../src/demo/acme.js";
import { Guard } from "../src/guard/guard.js";
import { SimBackend } from "../src/mcp/backend.js";
import { SessionRegistry } from "../src/mcp/sessions.js";
import { MemoryPayPalClient } from "../src/paypal/memory.js";
import { MemoryStore } from "../src/store/memory.js";
import type { LedgerEntry } from "../src/store/types.js";

let http: HttpServer;
let base: string;
let store: MemoryStore;
let paypal: MemoryPayPalClient;
let sessions: SessionRegistry;
let ledger: LedgerEntry[];

const order = (customerId: string, description: string) =>
  ledger.find((e) => e.customerId === customerId && e.description === description)!;

beforeEach(async () => {
  store = new MemoryStore(ACME_POLICY);
  paypal = new MemoryPayPalClient();
  sessions = new SessionRegistry();
  const app = createApp({ store, paypal, guard: new Guard(store, paypal), sessions, backend: new SimBackend(store) });
  await seedAcme(store, paypal);
  ledger = await store.listLedger();
  http = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((resolve) => http.close(() => resolve())));

/** What a merchant's app does: authenticate the customer, open a session, connect the agent. */
async function connect(customerId: string, mode: "protected" | "unprotected" = "protected", says?: string) {
  const res = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerId, mode }),
  });
  const { key, mcpPath } = (await res.json()) as { key: string; mcpPath: string };
  if (says) {
    await fetch(`${base}/api/sessions/${key}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: says }),
    });
  }
  const client = new Client({ name: "acme-support-bot", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${mcpPath}`)));
  return { client, key };
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0].text);

describe("MCP proxy", () => {
  it("exposes PayPal's tool names", async () => {
    const { client } = await connect("maya");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["get_order", "create_refund", "get_refund"]));
    await client.close();
  });

  it("rejects unknown sessions", async () => {
    const res = await fetch(`${base}/mcp/not-a-session`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
  });

  it("holds the indirect injection it saw pass through get_order", async () => {
    const bundle = order("sam", "Cold brew bundle");
    const { client, key } = await connect("sam", "protected", "Hey, where's my order?");

    const fetched = await client.callTool({ name: "get_order", arguments: { id: bundle.orderId } });
    expect(text(fetched)).toContain("ignore previous instructions");
    expect(sessions.get(key)!.untrusted[0].origin).toContain("purchase_units[0].custom_id");

    const refund = await client.callTool({ name: "create_refund", arguments: { capture_id: bundle.captureId } });
    expect(refund.isError).toBeFalsy();
    expect(text(refund)).toMatch(/^PENDING_MERCHANT_APPROVAL/);
    expect(paypal.refundCalls).toBe(0);

    const [audit] = await store.listAudit();
    expect(audit).toMatchObject({ status: "held", decidedBy: "provenance", customerId: "sam" });
    await client.close();
  });

  it("lets the same attack through in unprotected mode as a labelled dry run", async () => {
    const bundle = order("sam", "Cold brew bundle");
    const { client } = await connect("sam", "unprotected", "Hey, where's my order?");
    await client.callTool({ name: "get_order", arguments: { id: bundle.orderId } });
    const refund = await client.callTool({ name: "create_refund", arguments: { capture_id: bundle.captureId } });
    expect(JSON.parse(text(refund))).toMatchObject({ status: "COMPLETED", id: expect.stringMatching(/^SIMULATED-/) });
    expect(paypal.refundCalls).toBe(0);
    await client.close();
  });

  it("refunds a legitimate request and reports blocks as errors", async () => {
    const grinder = order("maya", "Burr grinder (manual)");
    const { client } = await connect("maya", "protected", "My grinder arrived cracked, can I get my $18 back?");
    await client.callTool({ name: "get_order", arguments: { id: grinder.orderId } });

    const ok = await client.callTool({ name: "create_refund", arguments: { capture_id: grinder.captureId, amount: { currency_code: "USD", value: "18.00" } } });
    expect(JSON.parse(text(ok))).toMatchObject({ status: "COMPLETED", id: expect.stringMatching(/^SIM-REF-/) });

    // The customer is authenticated as Maya, so Dev's order is off limits whatever the model says.
    const kit = order("dev", "Espresso starter kit");
    const denied = await client.callTool({ name: "create_refund", arguments: { capture_id: kit.captureId, amount: { currency_code: "USD", value: "5.00" } } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/^BLOCKED_BY_POLICY: .*different customer/);
    expect(paypal.refundCalls).toBe(1);
    await client.close();
  });
});
