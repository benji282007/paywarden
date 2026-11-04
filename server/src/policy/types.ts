// Policy DSL. Plain-English rules are compiled (by an LLM) into this shape;
// enforcement is fully deterministic and never calls a model.

export type Action = "hold" | "block";
export type Decision = "allow" | Action;

/** Tools that move merchant money. Everything else is read-only and passes through. */
export const MONEY_TOOLS = ["create_refund", "accept_dispute_claim", "send_invoice"] as const;
export type MoneyTool = (typeof MONEY_TOOLS)[number];

interface RuleBase {
  id: string;
  /** The English sentence this rule was compiled from, shown in the UI. */
  source: string;
  action: Action;
}

export type Rule =
  | (RuleBase & { kind: "max_amount"; tool: MoneyTool; max: number })
  // Velocity limits over a rolling window (24 h unless windowHours says otherwise).
  | (RuleBase & { kind: "daily_count"; tool: MoneyTool; max: number; per: "customer" | "agent"; windowHours?: number })
  | (RuleBase & { kind: "daily_total"; tool: MoneyTool; max: number; per: "customer" | "agent"; windowHours?: number })
  | (RuleBase & { kind: "max_order_age_days"; days: number })
  | (RuleBase & { kind: "owner_match" })
  | (RuleBase & { kind: "no_over_refund" })
  | (RuleBase & { kind: "no_duplicate"; windowSeconds: number })
  | (RuleBase & { kind: "untrusted_influence" })
  // Hold money moves the signed-in customer never asked for in their own chat messages.
  | (RuleBase & { kind: "customer_asked" })
  // Hold refunds for a different order, or a bigger amount, than the customer named in chat.
  | (RuleBase & { kind: "request_match" })
  // Only refund what the customer confirmed in the merchant's own UI (a signed mandate).
  | (RuleBase & { kind: "confirmed" })
  // Serial refunders: hold when this customer's refunds, including this one, pass a share of what
  // they paid in the window, once they've had at least `minRefunds` refunds there before.
  | (RuleBase & { kind: "refund_rate"; maxRatio: number; minRefunds: number; windowDays: number })
  | (RuleBase & { kind: "deny_tool"; tool: MoneyTool });

export interface Policy {
  version: number;
  rules: Rule[];
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** A capture as PayPal reports it, joined with our capture -> customer mapping. */
export interface CaptureRecord {
  captureId: string;
  customerId: string;
  amount: number;
  refunded: number;
  currency: string;
  capturedAt: Date;
}

/** A money-moving call that already executed, used for velocity and duplicate checks. */
export interface ExecutedCall {
  tool: string;
  customerId: string;
  captureId?: string;
  amount: number;
  at: Date;
}

export interface EvalContext {
  now: Date;
  /** Currency of the amounts, for wording reasons (rule limits are compared as plain numbers). */
  currency?: string;
  /** The customer authenticated in this conversation (never taken from the model). */
  customerId: string;
  agentId: string;
  getCapture(captureId: string): CaptureRecord | undefined;
  history: ExecutedCall[];
  /** Set by the provenance analyzer when untrusted text influenced this call. */
  untrustedInfluence?: { reason: string }[];
  /** Whether the customer's own chat messages ask for this kind of money move. */
  customerAsked?: boolean;
  /** Which of the customer's orders, and how much, their own chat names (if anything). */
  requested?: { captureIds: string[]; maxAmount?: number };
  /**
   * A signed confirmation from the customer that covers this exact capture and amount.
   * When present it settles "who asked" and "asked for what" with a signature instead
   * of reading words, so the text-based checks are skipped.
   */
  mandate?: { id: string; captureId: string; remaining: number };
  /** This customer's payments and refunds in a window, for refund_rate (computed per rule window). */
  customerStats?: (windowDays: number) => CustomerStats;
}

export interface CustomerStats {
  paid: number;
  refunded: number;
  refunds: number;
}

export interface RuleHit {
  ruleId: string;
  action: Action;
  reason: string;
  source: string;
}

export interface PolicyResult {
  decision: Decision;
  hits: RuleHit[];
  /** The refund amount the call will actually move (missing amount = full remaining). */
  effectiveAmount: number;
}
