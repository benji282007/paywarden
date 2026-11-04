// A support bot's PayPal tools, protected by Paywarden. Run against a local Paywarden:
//   npm start            (in another terminal)
//   npm run example
// The "agent" here is scripted so the run is repeatable; swap in any LLM agent that calls MCP tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Paywarden } from "../src/adapter/paywarden.js";

const base = process.env.PAYWARDEN_URL ?? "http://localhost:8787";
// The demo server gives each visitor a private shop by cookie; a real deployment doesn't need this.
const cookie = (await fetch(`${base}/api/status`)).headers.get("set-cookie")?.split(";")[0] ?? "";
const fetchWithShop: typeof fetch = (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie } });
const order = (await (await fetchWithShop(`${base}/api/ledger`)).json()).find((e: { customerId: string; description: string }) => e.customerId === "sam" && e.description === "Cold brew bundle");

// 1. The merchant's app opens a session for the signed-in customer and hands the agent its URL.
const pw = new Paywarden({ baseUrl: base, merchantToken: process.env.MERCHANT_API_TOKEN, fetch: fetchWithShop });
const s = await pw.openSession("sam");
const agent = new Client({ name: "acme-support-bot", version: "1.0.0" });
await agent.connect(new StreamableHTTPClientTransport(s.mcpUrl));
s.guard(agent);

const say = (who: string, text: string) => console.log(`${who.padEnd(10)} ${text}`);
const out = (r: unknown) => (r as { content: { text: string }[] }).content[0].text.replace(/\s+/g, " ").slice(0, 140);

// 2. The agent reads Sam's order, sees the injected note, and tries to refund.
await s.customerSaid("The courier left the box in the rain. Please note it on my account.");
say("agent", `get_order(${order.orderId})`);
const o = JSON.parse(((await agent.callTool({ name: "get_order", arguments: { id: order.orderId } })) as { content: { text: string }[] }).content[0].text);
say("note", JSON.stringify(o.purchase_units?.[0]?.custom_id));
const refund = { name: "create_refund", arguments: { capture_id: order.captureId } };
say("agent", `create_refund(${order.captureId})`);
say("paywarden", out(await agent.callTool(refund)));

// 3. Sam taps "Yes, refund me" on the card in the shop's app; the merchant signs the mandate.
await s.customerConfirmed(order.captureId, order.amount);
say("sam", `taps "Yes, refund me" ($${order.amount.toFixed(2)})`);
say("paywarden", out(await agent.callTool(refund)));
await agent.close();
