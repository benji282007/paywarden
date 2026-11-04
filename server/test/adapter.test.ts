import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Paywarden, signRefundMandate } from "../src/adapter/paywarden.js";
import { MandateBook, jwks } from "../src/mandate/mandate.js";
import { createApp } from "../src/app.js";
import { DEMO_POLICY, seedAcme } from "../src/demo/acme.js";
import { Guard } from "../src/guard/guard.js";
import { SimBackend } from "../src/mcp/backend.js";
import { SessionRegistry } from "../src/mcp/sessions.js";
import { MemoryPayPalClient } from "../src/paypal/memory.js";
import { MemoryStore } from "../src/store/memory.js";

let http: HttpServer;
let base: string;
let store: MemoryStore;
let paypal: MemoryPayPalClient;
let guard: Guard;
const merchantKey = generateKeyPairSync("ed25519");

beforeEach(async () => {
  store = new MemoryStore(DEMO_POLICY);
  paypal = new MemoryPayPalClient();
  const app = createApp({ store, paypal, guard: (guard = new Guard(store, paypal)), sessions: new SessionRegistry(), backend: new SimBackend(store), merchantToken: "mt" });
  await seedAcme(store, paypal);
  http = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((resolve) => http.close(() => resolve())));

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe("merchant adapter (three lines in the agent's code)", () => {
  it("the agent's refund waits until the customer confirms in the merchant's UI, then goes through", async () => {
    const grinder = (await store.listLedger("maya")).find((e) => e.description === "Burr grinder (manual)")!;
    const pw = new Paywarden({ baseUrl: base, merchantToken: "mt" });
    const s = await pw.openSession("maya");
    const client = new Client({ name: "any-agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(s.mcpUrl));
    s.guard(client);
    await s.customerSaid("My grinder arrived cracked, can I get my $18 back?");

    const refund = { name: "create_refund", arguments: { capture_id: grinder.captureId, amount: { currency_code: "USD", value: "18.00" } } };
    expect(text(await client.callTool(refund))).toMatch(/^CUSTOMER_CONFIRMATION_REQUIRED/);
    expect(paypal.refundCalls).toBe(0);

    await s.customerConfirmed(grinder.captureId, 18);
    expect(JSON.parse(text(await client.callTool(refund))).status).toBe("COMPLETED");
    expect(paypal.refundCalls).toBe(1);
    await client.close();
  });

  it("a forged or model-supplied confirmation does nothing", async () => {
    const bundle = (await store.listLedger("sam")).find((e) => e.description === "Cold brew bundle")!;
    const pw = new Paywarden({ baseUrl: base, merchantToken: "mt" });
    const s = await pw.openSession("sam");
    const client = new Client({ name: "any-agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(s.mcpUrl));
    const fake = `${Buffer.from(JSON.stringify({ v: 1, id: "md_x", customerId: "sam", captureId: bundle.captureId, maxAmount: 36, currency: "USD", exp: 9e9, via: "customer_tap" })).toString("base64url")}.AAAA`;
    const r = await client.callTool({ name: "create_refund", arguments: { capture_id: bundle.captureId, mandate: fake }, _meta: { "paywarden/mandates": [fake] } });
    expect(text(r)).toMatch(/^(CUSTOMER_CONFIRMATION_REQUIRED|PENDING)/);
    expect(paypal.refundCalls).toBe(0);
    await client.close();
  });

  it("verify-only Paywarden: the merchant signs with its own key, Paywarden can't", async () => {
    guard.mandates = new MandateBook({ publicKeys: [merchantKey.publicKey] });
    const grinder = (await store.listLedger("maya")).find((e) => e.description === "Burr grinder (manual)")!;
    const pw = new Paywarden({ baseUrl: base, merchantToken: "mt", signingKey: merchantKey.privateKey });
    const s = await pw.openSession("maya");
    const client = new Client({ name: "any-agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(s.mcpUrl));
    s.guard(client);
    const token = await s.customerConfirmed(grinder.captureId, 18);
    const r = await client.callTool({ name: "create_refund", arguments: { capture_id: grinder.captureId, amount: { currency_code: "USD", value: "18.00" } } });
    expect(JSON.parse(text(r)).status).toBe("COMPLETED");
    // Paywarden holds no private key, so it refuses to mint mandates itself.
    const minted = await fetch(`${base}/api/mandates`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer mt" }, body: JSON.stringify({ customerId: "maya", captureId: grinder.captureId, maxAmount: 18 }) });
    expect(minted.status).toBe(501);
    // An auditor verifies the mandate from the published JWKS with plain Node, no Paywarden code.
    const dir = mkdtempSync(join(tmpdir(), "pw-"));
    writeFileSync(join(dir, "jwks.json"), JSON.stringify(jwks([merchantKey.publicKey])));
    const out = execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/verify-mandate.mjs", import.meta.url)), join(dir, "jwks.json"), token]).toString();
    expect(out).toMatch(/^VALID signature/);
    expect(out).toMatch(/consented to refund capture .* up to 18.00 USD/);
    expect(signRefundMandate(merchantKey.privateKey, { customerId: "maya", captureId: "X", maxAmount: 1 }).split(".")).toHaveLength(3);
    await client.close();
  });

  it("refuses the merchant API without the token", async () => {
    await expect(new Paywarden({ baseUrl: base }).openSession("maya")).rejects.toThrow(/Merchant token required/);
  });
});
