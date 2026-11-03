import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { ACME_POLICY, seedAcme } from "./demo/acme.js";
import { seedSampleHistory } from "./demo/history.js";
import { Workspaces, type Workspace } from "./demo/workspaces.js";
import { Guard } from "./guard/guard.js";
import { LlmJudge } from "./guard/judge.js";
import { llmsFromEnv } from "./llm/index.js";
import { RestBackend, SimBackend } from "./mcp/backend.js";
import { SessionRegistry } from "./mcp/sessions.js";
import { MemoryPayPalClient } from "./paypal/memory.js";
import { RestPayPalClient } from "./paypal/rest.js";
import type { PayPalClient } from "./paypal/types.js";
import { MemoryStore } from "./store/memory.js";

// Works from src/ (tsx) and dist/ (compiled) alike: paths are relative to the server package.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Local secrets live in server/.env (git-ignored); hosted deploys set real env vars.
const envFile = path.join(serverRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID, MERCHANT_API_TOKEN, PORT = "8787" } = process.env;
const webDist = process.env.WEB_DIST ?? path.resolve(serverRoot, "../web/dist");

const rest = PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET ? new RestPayPalClient({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET, webhookId: PAYPAL_WEBHOOK_ID }) : undefined;
if (!rest) console.warn("⚠ PAYPAL_CLIENT_ID not set: running against an OFFLINE SIMULATION, not PayPal sandbox.");

const llms = llmsFromEnv();
console.log(`AI: rules/judge ${llms.reasoning?.model ?? "off"}, chat ${llms.chat?.model ?? "off"}`);
const judge = llms.reasoning ? new LlmJudge(llms.reasoning) : undefined;

/** A visitor's private Acme Coffee. Real sandbox payments when keys exist, else simulated. */
function makeWorkspace(id: string): Workspace {
  const store = new MemoryStore(ACME_POLICY);
  const wire = (paypal: PayPalClient & { simulated?: boolean }) => ({
    paypal,
    guard: new Guard(store, paypal, judge),
    backend: paypal instanceof RestPayPalClient ? new RestBackend(paypal) : new SimBackend(store),
  });
  const ws: Workspace = { id, store, sessions: new SessionRegistry(), lastSeen: Date.now(), seeding: true, sampleHistory: true, ready: Promise.resolve(), ...wire(rest ?? new MemoryPayPalClient()) };
  ws.ready = seedAcme(store, ws.paypal)
    .catch(async (err: Error) => {
      // A PayPal problem shouldn't take the demo down: fall back to simulation and say so.
      console.error(`Seeding workspace ${id} against PayPal failed: ${err.message}`);
      ws.seedError = `PayPal sandbox seeding failed (${err.message.slice(0, 160)}); this shop runs on the offline simulation.`;
      Object.assign(ws, wire(new MemoryPayPalClient()));
      await seedAcme(store, ws.paypal);
    })
    .then(() => seedSampleHistory(store))
    .finally(() => {
      ws.seeding = false;
    });
  return ws;
}

if (rest) rest.warm().catch((err: Error) => console.error(`PayPal token warm-up failed: ${err.message}`));

const workspaces = new Workspaces(makeWorkspace);
createApp({ workspaces, llms, merchantToken: MERCHANT_API_TOKEN, webDist: existsSync(webDist) ? webDist : undefined, devRoutes: process.env.PAYWARDEN_DEV === "1" }).listen(Number(PORT), () => {
  console.log(`Paywarden listening on http://localhost:${PORT}`);
});
