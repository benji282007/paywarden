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
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      // Retrying with the same PayPal-Request-Id is safe: PayPal replays the original result.
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) throw new PayPalApiError(res.status, json, res.headers.get("paypal-debug-id") ?? undefined);
      return json as T;
    }
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
    return {
      orderId: order.id,
      captureId: cap.id,
      amount: Number(cap.amount.value),
      currency: cap.amount.currency_code,
      status: cap.status,
      createTime: new Date(cap.create_time),
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

  async refundCapture(input: { captureId: string; amount?: number; currency?: string; noteToPayer?: string; requestId: string }): Promise<RefundResult> {
    const refund = await this.call<{ id: string; status: string; amount?: { value: string } }>(
      "POST",
      `/v2/payments/captures/${input.captureId}/refund`,
      {
        ...(input.amount != null ? { amount: { currency_code: input.currency ?? "USD", value: fmt(input.amount) } } : {}),
        ...(input.noteToPayer ? { note_to_payer: input.noteToPayer.slice(0, 255) } : {}),
      },
      input.requestId,
    );
    return { refundId: refund.id, status: refund.status, amount: Number(refund.amount?.value ?? input.amount ?? 0) };
  }

  async verifyWebhook(h: WebhookHeaders, rawBody: string): Promise<boolean> {
    if (!this.cfg.webhookId) return false;
    const res = await this.call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h.authAlgo,
      cert_url: h.certUrl,
      transmission_id: h.transmissionId,
      transmission_sig: h.transmissionSig,
      transmission_time: h.transmissionTime,
      webhook_id: this.cfg.webhookId,
      webhook_event: JSON.parse(rawBody),
    });
    return res.verification_status === "SUCCESS";
  }
}
