import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { ACME_POLICY, seedAcme } from "./demo/acme.js";
import { Guard } from "./guard/guard.js";
import { RestBackend, SimBackend } from "./mcp/backend.js";
import { SessionRegistry } from "./mcp/sessions.js";
import { MemoryPayPalClient } from "./paypal/memory.js";
import { RestPayPalClient } from "./paypal/rest.js";
import { MemoryStore } from "./store/memory.js";

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID, PORT = "8787" } = process.env;

const paypal =
  PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET
    ? new RestPayPalClient({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET, webhookId: PAYPAL_WEBHOOK_ID })
    : new MemoryPayPalClient();

if (paypal instanceof MemoryPayPalClient) {
  console.warn("⚠ PAYPAL_CLIENT_ID not set: running against an OFFLINE SIMULATION, not PayPal sandbox.");
}

const store = new MemoryStore(ACME_POLICY);
const guard = new Guard(store, paypal);
const sessions = new SessionRegistry();
const backend = paypal instanceof RestPayPalClient ? new RestBackend(paypal) : new SimBackend(store);

const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));

await seedAcme(store, paypal);
createApp({ store, paypal, guard, sessions, backend, webDist: existsSync(webDist) ? webDist : undefined }).listen(Number(PORT), () => {
  console.log(`Paywarden listening on http://localhost:${PORT}`);
});
