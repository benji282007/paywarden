import type {
  CaptureDetails,
  CaptureResult,
  PayPalClient,
  RefundResult,
  WebhookHeaders,
} from "./types.js";

const SANDBOX = "https://api-m.sandbox.paypal.com";

// PayPal's published sandbox Visa test number. Only valid against the sandbox.
const TEST_CARD = { number: "4111111111111111", expiry: "2030-12", security_code: "123", name: "Sandbox Buyer" };

export interface RestConfig {
  clientId: string;
  clientSecret: string;
  webhookId?: string;
  baseUrl?: string;
}

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly debugId?: string,
  ) {
    super(`PayPal API ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
}

const fmt = (n: number) => n.toFixed(2);

export class RestPayPalClient implements PayPalClient {
  private token?: { value: string; expiresAt: number };
  private readonly base: string;

  constructor(private readonly cfg: RestConfig) {
    this.base = cfg.baseUrl ?? SANDBOX;
  }

  /** Client-credentials token, refreshed a minute before expiry (the toolkit never refreshes). */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) throw new PayPalApiError(res.status, body);
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** `body` may be a pre-serialized string (webhook verification must embed the event byte-for-byte). */
  private async call<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      // A revoked or expired token: fetch a fresh one once.
      if (res.status === 401 && attempt === 0) {
        this.token = undefined;
        continue;
      }
      // Retrying with the same PayPal-Request-Id is safe: PayPal replays the original result.
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      const text = await res.text();
      let json: unknown = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text.slice(0, 300) };
      }
      if (!res.ok) throw new PayPalApiError(res.status, json, res.headers.get("paypal-debug-id") ?? undefined);
      return json as T;
    }
  }

  /** Fetch the OAuth token ahead of the first visitor, so their first refund isn't slower. */
  async warm(): Promise<void> {
    await this.accessToken();
  }

  /** Raw read for the MCP proxy's forwarded tools (get_order, get_refund). */
  get<T = unknown>(path: string): Promise<T> {
    return this.call<T>("GET", path);
  }

  async captureCardPayment(input: { amount: number; description: string; note: string; requestId: string }): Promise<CaptureResult> {
    type Order = {
      id: string;
      status: string;
      purchase_units: { payments?: { captures?: { id: string; status: string; amount: { value: string; currency_code: string }; create_time: string }[] } }[];
    };
    // Single-step card orders require PayPal-Request-Id and come back captured.
    let order = await this.call<Order>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: "USD", value: fmt(input.amount) },
            description: input.description.slice(0, 127),
            // soft_descriptor is too short; custom_id carries the customer's note (max 127 chars).
            custom_id: input.note.slice(0, 127),
          },
        ],
        payment_source: { card: TEST_CARD },
      },
      input.requestId,
    );
    if (!order.purchase_units[0].payments?.captures?.length) {
      // Some accounts return APPROVED and need an explicit capture.
      order = await this.call<Order>("POST", `/v2/checkout/orders/${order.id}/capture`, {}, `${input.requestId}-cap`);
    }
    const cap = order.purchase_units[0].payments!.captures![0];
    // A declined or pending capture isn't refundable money; don't put it in the ledger.
    if (cap.status !== "COMPLETED") throw new Error(`Seed payment ${cap.id} is ${cap.status}, not COMPLETED`);
    return {
      orderId: order.id,
      captureId: cap.id,
      amount: Number(cap.amount.value),
      currency: cap.amount.currency_code,
      status: cap.status,
      createTime: new Date(cap.create_time),
    };
  }

  /**
   * A checkout paid from a PayPal account (not a card): returns the page where the buyer
   * approves. Used by the demo so one order has a real payer id on PayPal's record.
   */
  async createWalletOrder(input: { amount: number; description: string; note: string; returnUrl: string; cancelUrl: string; requestId: string }): Promise<{ orderId: string; approveUrl: string }> {
    const order = await this.call<{ id: string; links: { rel: string; href: string }[] }>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: fmt(input.amount) }, description: input.description.slice(0, 127), custom_id: input.note.slice(0, 127) }],
        payment_source: {
          paypal: { experience_context: { return_url: input.returnUrl, cancel_url: input.cancelUrl, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", brand_name: "Acme Coffee (demo)" } },
        },
      },
      input.requestId,
    );
    const approveUrl = order.links.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    if (!approveUrl) throw new Error("PayPal returned no approval link");
    return { orderId: order.id, approveUrl };
  }

  /** Capture an approved wallet order. The payer id is PayPal's record of which account paid. */
  async captureWalletOrder(orderId: string, requestId: string): Promise<CaptureResult & { payerId: string }> {
    const order = await this.call<{
      id: string;
      payer?: { payer_id?: string };
      purchase_units: { payments?: { captures?: { id: string; status: string; amount: { value: string; currency_code: string }; create_time: string }[] } }[];
    }>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, requestId);
    const cap = order.purchase_units[0]?.payments?.captures?.[0];
    if (!cap || cap.status !== "COMPLETED") throw new Error(`Wallet payment ${cap?.id ?? orderId} is ${cap?.status ?? "not captured"}`);
    if (!order.payer?.payer_id) throw new Error("PayPal returned no payer id for this payment");
    return {
      orderId: order.id,
      captureId: cap.id,
      amount: Number(cap.amount.value),
      currency: cap.amount.currency_code,
      status: cap.status,
      createTime: new Date(cap.create_time),
      payerId: order.payer.payer_id,
    };
  }

  async getCapture(captureId: string): Promise<CaptureDetails> {
    const cap = await this.call<{
      id: string;
      status: string;
      amount: { value: string; currency_code: string };
      create_time: string;
    }>("GET", `/v2/payments/captures/${captureId}`);
    // Capture details don't carry a refunded total; Paywarden's ledger tracks it from
    // refund results and webhooks. PARTIALLY_REFUNDED / REFUNDED statuses are a cross-check.
    return {
      captureId: cap.id,
      amount: Number(cap.amount.value),
      currency: cap.amount.currency_code,
      status: cap.status,
      refunded: cap.status === "REFUNDED" ? Number(cap.amount.value) : 0,
      createTime: new Date(cap.create_time),
    };
  }

  async refundCapture(input: { captureId: string; amount?: number; currency?: string; noteToPayer?: string; customId?: string; requestId: string }): Promise<RefundResult> {
    const refund = await this.call<{ id: string; status: string; amount?: { value: string } }>(
      "POST",
      `/v2/payments/captures/${input.captureId}/refund`,
      {
        ...(input.amount != null ? { amount: { currency_code: input.currency ?? "USD", value: fmt(input.amount) } } : {}),
        ...(input.noteToPayer ? { note_to_payer: input.noteToPayer.slice(0, 255) } : {}),
        ...(input.customId ? { custom_id: input.customId.slice(0, 127) } : {}),
      },
      input.requestId,
    );
    return { refundId: refund.id, status: refund.status, amount: Number(refund.amount?.value ?? input.amount ?? 0) };
  }

  async acceptDisputeClaim(disputeId: string, note: string, requestId: string): Promise<void> {
    await this.call("POST", `/v1/customer/disputes/${encodeURIComponent(disputeId)}/accept-claim`, { note: note.slice(0, 2000) }, requestId);
  }

  /** Sum of the capture's refunds that are completed or still pending, read from the order. */
  async getRefundedTotal(orderId: string, captureId: string): Promise<number> {
    const order = await this.call<{ purchase_units: { payments?: { refunds?: { status: string; amount: { value: string }; links?: { rel: string; href: string }[] }[] } }[] }>(
      "GET",
      `/v2/checkout/orders/${orderId}`,
    );
    let total = 0;
    for (const pu of order.purchase_units) {
      for (const r of pu.payments?.refunds ?? []) {
        const up = r.links?.find((l) => l.rel === "up")?.href ?? "";
        if ((r.status === "COMPLETED" || r.status === "PENDING") && (!up || up.includes(captureId))) total += Number(r.amount.value);
      }
    }
    return Math.round(total * 100) / 100;
  }

  async verifyWebhook(h: WebhookHeaders, rawBody: string): Promise<boolean> {
    if (!this.cfg.webhookId) return false;
    // Embed the event exactly as received: re-serializing can change bytes and fail verification.
    const fields = JSON.stringify({
      auth_algo: h.authAlgo,
      cert_url: h.certUrl,
      transmission_id: h.transmissionId,
      transmission_sig: h.transmissionSig,
      transmission_time: h.transmissionTime,
      webhook_id: this.cfg.webhookId,
    });
    const res = await this.call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", `${fields.slice(0, -1)},"webhook_event":${rawBody}}`);
    return res.verification_status === "SUCCESS";
  }
}
