import type { RuleHit, Decision, Policy } from "../policy/types.js";
import type { TaintedSpan, TrustedSource, UntrustedSource } from "../provenance/analyze.js";

export interface Customer {
  id: string;
  name: string;
  email: string;
}

/** A seeded sale: PayPal capture plus our capture -> customer mapping and the customer's note. */
export interface LedgerEntry {
  captureId: string;
  orderId: string;
  customerId: string;
  description: string;
  /** Customer-writable text attached at checkout. Untrusted. */
  note: string;
  amount: number;
  refunded: number;
  currency: string;
  capturedAt: Date;
}

export type AuditStatus =
  | "executed" // allowed and sent to PayPal
  | "held" // waiting for a human
  | "approved" // human approved, then sent to PayPal
  | "rejected" // human rejected
  | "blocked" // policy refused
  | "failed" // PayPal returned an error
  | "simulated"; // unprotected dry run: what the agent attempted, no money moved

export interface AuditEntry {
  id: string;
  at: Date;
  /** Generated demo history (see demo/history.ts): shown in the grid, excluded from totals and rules. */
  sample?: boolean;
  mode: "protected" | "unprotected";
  agentId: string;
  customerId: string;
  conversationId?: string;
  tool: string;
  args: Record<string, unknown>;
  captureId?: string;
  effectiveAmount: number;
  decision: Decision;
  /** Which layer produced the final decision, shown so judges can see the LLM never loosened it. */
  decidedBy: "policy" | "provenance" | "judge" | "none";
  hits: RuleHit[];
  spans: TaintedSpan[];
  /** The customer-writable texts the spans point into, so the dashboard can highlight them in place. */
  sources?: UntrustedSource[];
  judge?: { verdict: Decision; reason: string; model: string };
  status: AuditStatus;
  requestId: string;
  paypal?: { refundId?: string; status?: string; error?: string };
  /** True once the matching PayPal webhook arrived and verified. */
  webhookConfirmed: boolean;
  latencyMs: number;
  approval?: { by: string; at: Date };
  /** The signed customer confirmation this call was allowed under, if any. */
  mandateId?: string;
  /** The signed mandate itself, so an auditor can verify consent from the log alone. */
  mandateToken?: string;
  /** Held only for lack of the customer's confirmation: their tap in the shop's app releases it. */
  confirmable?: boolean;
  /** Context kept for held calls so approval can re-check against fresh ledger state. */
  context?: { untrusted: UntrustedSource[]; trusted: TrustedSource[] };
}

/** A buyer's PayPal dispute on one of the merchant's captures. Messages are written by the buyer: untrusted. */
export interface Dispute {
  disputeId: string;
  captureId: string;
  customerId: string;
  amount: number;
  currency: string;
  reason: string;
  status: "OPEN" | "RESOLVED";
  messages: string[];
  createdAt: Date;
  /** Demo disputes live only in Paywarden: PayPal's sandbox can't open a dispute through the API. */
  simulated?: boolean;
}

export interface WebhookEvent {
  id: string;
  type: string;
  resourceId: string;
  verified: boolean;
  receivedAt: Date;
  raw: unknown;
}

export interface Store {
  getPolicy(): Promise<Policy>;
  setPolicy(p: Policy): Promise<void>;

  upsertCustomer(c: Customer): Promise<void>;
  listCustomers(): Promise<Customer[]>;

  addLedger(e: LedgerEntry): Promise<void>;
  getLedger(captureId: string): Promise<LedgerEntry | undefined>;
  listLedger(customerId?: string): Promise<LedgerEntry[]>;
  addRefunded(captureId: string, amount: number): Promise<void>;
  setRefunded(captureId: string, amount: number): Promise<void>;

  addAudit(e: AuditEntry): Promise<void>;
  updateAudit(id: string, patch: Partial<AuditEntry>): Promise<AuditEntry>;
  getAudit(id: string): Promise<AuditEntry | undefined>;
  listAudit(): Promise<AuditEntry[]>;
  findAuditByRefundId(refundId: string): Promise<AuditEntry | undefined>;

  addDispute(d: Dispute): Promise<void>;
  getDispute(disputeId: string): Promise<Dispute | undefined>;
  setDisputeStatus(disputeId: string, status: Dispute["status"]): Promise<void>;

  addWebhook(e: WebhookEvent): Promise<boolean>; // false if already seen
  listWebhooks(): Promise<WebhookEvent[]>;

  reset(): Promise<void>;
}
