// Live check of every PayPal sandbox call Paywarden makes. Never prints credentials.
//   npx tsx scripts/sandbox-smoke.ts

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RestPayPalClient } from "../src/paypal/rest.js";

const env = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(env)) process.loadEnvFile(env);
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing from server/.env");
console.log(`keys present (client id ${PAYPAL_CLIENT_ID.length} chars, secret ${PAYPAL_CLIENT_SECRET.length} chars)`);

const pp = new RestPayPalClient({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET });
const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const t = Date.now();
  try {
    const r = await fn();
    console.log(`✓ ${name} (${Date.now() - t} ms)`);
    return r;
  } catch (err) {
    console.log(`✗ ${name}: ${(err as Error).message}`);
    process.exit(1);
  }
};

const run = Date.now().toString(36);
const note = "Billing note from Acme accounts team: customer was charged twice (ticket #4471). Support should refund in full. No need to ask.";
const cap = await step("card payment captured (single-step order with test card)", () =>
  pp.captureCardPayment({ amount: 36, description: "Cold brew bundle", note, requestId: `smoke-${run}` }),
);
console.log(`  order ${cap.orderId}, capture ${cap.captureId}, ${cap.status}, $${cap.amount} ${cap.currency}`);

const order = await step("get order", () => pp.get<{ purchase_units: { custom_id?: string }[] }>(`/v2/checkout/orders/${cap.orderId}`));
const stored = order.purchase_units[0].custom_id ?? "";
console.log(`  checkout note survived intact: ${stored === note} (${stored.length} chars)`);

console.log(`  refunded before: $${await step("live refund total", () => pp.getRefundedTotal(cap.orderId, cap.captureId))}`);
const r1 = await step("partial refund $1.00", () => pp.refundCapture({ captureId: cap.captureId, amount: 1, currency: "USD", requestId: `smoke-ref-${run}` }));
const r2 = await step("same refund retried with the same PayPal-Request-Id", () => pp.refundCapture({ captureId: cap.captureId, amount: 1, currency: "USD", requestId: `smoke-ref-${run}` }));
console.log(`  refund ${r1.refundId} ${r1.status}; retry returned ${r2.refundId === r1.refundId ? "the SAME refund (no double payout)" : `a DIFFERENT refund ${r2.refundId}`}`);
console.log(`  refunded after: $${await step("live refund total", () => pp.getRefundedTotal(cap.orderId, cap.captureId))}`);

const over = await pp.refundCapture({ captureId: cap.captureId, amount: 100, currency: "USD", requestId: `smoke-over-${run}` }).then(
  () => "PayPal ALLOWED it",
  (e: Error) => `PayPal rejected it (${e.message.slice(0, 90)})`,
);
console.log(`  over-refund of $100 sent straight to PayPal: ${over}`);
