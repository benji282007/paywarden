import type { PayPalClient, WebhookHeaders } from "../paypal/types.js";
import type { Store } from "../store/types.js";

interface RefundResource {
  id: string;
  status?: string;
  amount?: { value: string };
  links?: { rel: string; href: string }[];
}

export type WebhookOutcome =
  | { ok: false; reason: "unverified" | "malformed" }
  | { ok: true; duplicate: boolean; matched?: string; external?: boolean };

export function headersFrom(get: (name: string) => string | undefined): WebhookHeaders {
  return {
    transmissionId: get("paypal-transmission-id") ?? "",
    transmissionTime: get("paypal-transmission-time") ?? "",
    certUrl: get("paypal-cert-url") ?? "",
    authAlgo: get("paypal-auth-algo") ?? "",
    transmissionSig: get("paypal-transmission-sig") ?? "",
  };
}

/**
 * PayPal webhook intake. Unverified events are recorded but never change state.
 * PAYMENT.CAPTURE.REFUNDED either confirms a refund Paywarden executed, or, if the
 * merchant refunded from the PayPal dashboard, updates the ledger so rules see it.
 */
export async function handleWebhook(
  store: Store,
  paypal: PayPalClient,
  headers: WebhookHeaders,
  rawBody: string,
): Promise<WebhookOutcome> {
  let event: { id?: string; event_type?: string; resource?: RefundResource };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!event.id || !event.event_type || !event.resource?.id) return { ok: false, reason: "malformed" };

  let verified = false;
  try {
    verified = await paypal.verifyWebhook(headers, rawBody);
  } catch {
    verified = false;
  }

  const fresh = await store.addWebhook({
    id: event.id,
    type: event.event_type,
    resourceId: event.resource.id,
    verified,
    receivedAt: new Date(),
    raw: event,
  });
  if (!verified) return { ok: false, reason: "unverified" };
  // PayPal retries delivery; process each event once.
  if (!fresh) return { ok: true, duplicate: true };

  if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
    const refund = event.resource;
    const audit = await store.findAuditByRefundId(refund.id);
    if (audit) {
      await store.updateAudit(audit.id, { webhookConfirmed: true, paypal: { ...audit.paypal, status: refund.status ?? audit.paypal?.status } });
      return { ok: true, duplicate: false, matched: audit.id };
    }
    // Refund issued outside Paywarden: find its capture via the "up" link and record it.
    const up = refund.links?.find((l) => l.rel === "up")?.href;
    const captureId = up?.split("/captures/")[1]?.split(/[/?]/)[0];
    if (captureId && refund.amount) await store.addRefunded(captureId, Number(refund.amount.value));
    return { ok: true, duplicate: false, external: true };
  }
  return { ok: true, duplicate: false };
}
