import { randomUUID } from "node:crypto";
import type { CaptureDetails, CaptureResult, PayPalClient, RefundResult } from "./types.js";

/**
 * In-memory stand-in for PayPal, used by tests and for local development before
 * sandbox keys exist. It mirrors the behaviors Paywarden relies on: full refund when
 * amount is omitted, over-refund rejection, and PayPal-Request-Id replay.
 * Never used when PAYPAL_CLIENT_ID is set; the UI labels it "offline simulation".
 */
export class MemoryPayPalClient implements PayPalClient {
  readonly simulated = true;
  private captures = new Map<string, CaptureDetails>();
  private byRequestId = new Map<string, RefundResult>();
  refundCalls = 0;

  async captureCardPayment(input: { amount: number; description: string; note: string; requestId: string }): Promise<CaptureResult> {
    const captureId = `SIM-CAP-${randomUUID().slice(0, 8).toUpperCase()}`;
    const createTime = new Date();
    this.captures.set(captureId, { captureId, amount: input.amount, currency: "USD", status: "COMPLETED", refunded: 0, createTime });
    // Matches PayPal's order id format (17-32 uppercase alphanumerics) so tool schemas validate.
    const orderId = `SIM${randomUUID().replace(/-/g, "").slice(0, 15).toUpperCase()}`;
    return { orderId, captureId, amount: input.amount, currency: "USD", status: "COMPLETED", createTime };
  }

  async getCapture(captureId: string): Promise<CaptureDetails> {
    const c = this.captures.get(captureId);
    if (!c) throw new Error(`RESOURCE_NOT_FOUND: capture ${captureId}`);
    return { ...c };
  }

  async refundCapture(input: { captureId: string; amount?: number; requestId: string }): Promise<RefundResult> {
    const replay = this.byRequestId.get(input.requestId);
    if (replay) return replay;
    this.refundCalls++;
    const c = this.captures.get(input.captureId);
    if (!c) throw new Error(`RESOURCE_NOT_FOUND: capture ${input.captureId}`);
    const remaining = Math.round((c.amount - c.refunded) * 100) / 100;
    const amount = input.amount ?? remaining;
    if (amount > remaining) throw new Error("UNPROCESSABLE_ENTITY: REFUND_AMOUNT_EXCEEDED");
    c.refunded = Math.round((c.refunded + amount) * 100) / 100;
    c.status = c.refunded >= c.amount ? "REFUNDED" : "PARTIALLY_REFUNDED";
    const result = { refundId: `SIM-REF-${randomUUID().slice(0, 8).toUpperCase()}`, status: "COMPLETED", amount };
    this.byRequestId.set(input.requestId, result);
    return result;
  }

  async verifyWebhook(): Promise<boolean> {
    return false;
  }
}
