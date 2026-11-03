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
 * PayPal webhook intake. Unverified events change nothing and aren't stored (the
 * endpoint is public). Verified PAYMENT.CAPTURE.REFUNDED events either confirm a refund
 * Paywarden executed, or, if the merchant refunded from the PayPal dashboard, update
 * the ledger so rules see it. `resolve` finds whose ledger the refund belongs to.
 */
export async function handleWebhook(
  resolve: (refundId: string, captureId?: string) => Promise<Store | undefined>,
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
  if (!verified) return { ok: false, reason: "unverified" };

  const refund = event.resource;
  // Refund resources link "up" to their capture.
  const up = refund.links?.find((l) => l.rel === "up")?.href;
  const captureId = up?.split("/captures/")[1]?.split(/[/?]/)[0];
  const store = await resolve(refund.id, captureId);
  if (!store) return { ok: true, duplicate: false };

  // PayPal retries delivery; process each verified event once.
  const fresh = await store.addWebhook({ id: event.id, type: event.event_type, resourceId: refund.id, verified, receivedAt: new Date(), raw: event });
  if (!fresh) return { ok: true, duplicate: true };

  if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
    const audit = await store.findAuditByRefundId(refund.id);
    if (audit) {
      await store.updateAudit(audit.id, { webhookConfirmed: true, paypal: { ...audit.paypal, status: refund.status ?? audit.paypal?.status } });
      return { ok: true, duplicate: false, matched: audit.id };
    }
    if (captureId && refund.amount) await store.addRefunded(captureId, Number(refund.amount.value));
    return { ok: true, duplicate: false, external: true };
  }
  return { ok: true, duplicate: false };
}
