// The slice of PayPal that Paywarden needs. The real implementation talks to the
// sandbox REST API; tests use an in-memory double with the same contract.

export interface Money {
  currency_code: string;
  value: string;
}

export interface CaptureResult {
  orderId: string;
  captureId: string;
  amount: number;
  currency: string;
  status: string;
  createTime: Date;
}

export interface RefundResult {
  refundId: string;
  status: string; // COMPLETED | PENDING | ...
  amount: number;
}

export interface CaptureDetails {
  captureId: string;
  amount: number;
  currency: string;
  status: string;
  /** Sum of completed refunds, from seller_receivable_breakdown / refund links. */
  refunded: number;
  createTime: Date;
}

export interface WebhookHeaders {
  transmissionId: string;
  transmissionTime: string;
  certUrl: string;
  authAlgo: string;
  transmissionSig: string;
}

export interface PayPalClient {
  /** Seed a completed card payment without a buyer redirect (sandbox test cards). */
  captureCardPayment(input: {
    amount: number;
    description: string;
    /** Customer-writable text (e.g. a delivery note) that the support bot will later read. */
    note: string;
    requestId: string;
  }): Promise<CaptureResult>;

  getCapture(captureId: string): Promise<CaptureDetails>;

  /** Omitting amount refunds the full remaining capture, as PayPal does. */
  refundCapture(input: {
    captureId: string;
    amount?: number;
    currency?: string;
    noteToPayer?: string;
    /** Stored on PayPal's refund record (custom_id, max 127): Paywarden puts the consent proof here. */
    customId?: string;
    /** Sent as PayPal-Request-Id so a retried call can't refund twice. */
    requestId: string;
  }): Promise<RefundResult>;

  verifyWebhook(headers: WebhookHeaders, rawBody: string): Promise<boolean>;

  /** Accept liability for a buyer's dispute claim (PayPal then refunds the buyer). */
  acceptDisputeClaim?(disputeId: string, note: string, requestId: string): Promise<void>;

  /** Total already refunded on a capture according to PayPal (completed + pending). */
  getRefundedTotal?(orderId: string, captureId: string): Promise<number>;
}
