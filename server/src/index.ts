import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { ACME_POLICY, seedAcme } from "./demo/acme.js";
import { Guard } from "./guard/guard.js";
import { LlmJudge } from "./guard/judge.js";
import { llmsFromEnv } from "./llm/index.js";
import { RestBackend, SimBackend } from "./mcp/backend.js";
import { SessionRegistry } from "./mcp/sessions.js";
import { MemoryPayPalClient } from "./paypal/memory.js";
import { RestPayPalClient } from "./paypal/rest.js";
import { MemoryStore } from "./store/memory.js";

// Local secrets live in server/.env (git-ignored); hosted deploys set real env vars.
const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID, PORT = "8787" } = process.env;

const paypal =
  PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET
    ? new RestPayPalClient({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET, webhookId: PAYPAL_WEBHOOK_ID })
    : new MemoryPayPalClient();

if (paypal instanceof MemoryPayPalClient) {
  console.warn("⚠ PAYPAL_CLIENT_ID not set: running against an OFFLINE SIMULATION, not PayPal sandbox.");
}

const store = new MemoryStore(ACME_POLICY);
const llms = llmsFromEnv();
console.log(`AI: rules/judge ${llms.reasoning?.model ?? "off"}, chat ${llms.chat?.model ?? "off"}`);
const guard = new Guard(store, paypal, llms.reasoning ? new LlmJudge(llms.reasoning) : undefined);
const sessions = new SessionRegistry();
const backend = paypal instanceof RestPayPalClient ? new RestBackend(paypal) : new SimBackend(store);

const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));

await seedAcme(store, paypal);
createApp({ store, paypal, guard, sessions, backend, llms, webDist: existsSync(webDist) ? webDist : undefined }).listen(Number(PORT), () => {
  console.log(`Paywarden listening on http://localhost:${PORT}`);
});
