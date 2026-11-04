// Where the proxy sends calls it lets through. Read-only tools are forwarded as-is;
// money-moving tools only arrive here after the Guard approved them.

import type { Dispute, Store } from "../store/types.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface ToolBackend {
  readonly label: "paypal-sandbox" | "offline-simulation";
  tools(): ToolDef[];
  /** Returns the tool's JSON result, the same shape PayPal's toolkit returns. */
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}

// Names, descriptions and argument shapes are copied from PayPal's Agent Toolkit
// (paypal/agent-toolkit typescript/src/shared/{tools,parameters,prompts,regex}.ts @ a3aa963),
// so an agent written for PayPal's MCP server works unchanged when pointed at Paywarden.
const CAPTURE_ID = "^[A-Za-z0-9_-]{15,32}$";
const REFUND_ID = "^[A-Za-z0-9_-]{15,32}$";
const ORDER_ID = "^[A-Z0-9]{17,32}$";
const INVOICE_ID = "^[A-Za-z0-9_-]{1,127}$";
const DISPUTE_ID = "^[A-Za-z0-9_-]{1,255}$";

export const PAYPAL_TOOLS: ToolDef[] = [
  {
    name: "get_order",
    description:
      "Retrieves the order details from PayPal for a given order ID.\n\n" +
      "This tool is used to retrieve details of an existing order in PayPal. It provides information about the order, including items, amounts, status, and other relevant details.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", pattern: ORDER_ID, description: "The order id generated during create call" } },
      required: ["id"],
    },
  },
  {
    name: "create_refund",
    description:
      "Initiate a refund for a PayPal payment capture.\n" +
      "If you have an order ID instead of a capture ID, first use the get order tool to obtain the capture ID from the order details.\n" +
      "This function allows you to return funds to a customer by refunding a previously captured payment. You can issue a full refund or specify a partial amount. If multiple captures exist for an order, request clarification on which specific capture to refund.",
    inputSchema: {
      type: "object",
      properties: {
        capture_id: { type: "string", pattern: CAPTURE_ID, description: "The ID of the capture to refund." },
        amount: {
          type: "object",
          properties: { currency_code: { type: "string" }, value: { type: "string" } },
          required: ["currency_code", "value"],
          description: "The amount to refund. If not specified, the full captured amount is refunded.",
        },
        invoice_id: { type: "string", pattern: INVOICE_ID, description: "The invoice ID that is used to track this payment." },
        note_to_payer: { type: "string", description: "A note to the payer." },
      },
      required: ["capture_id"],
    },
  },
  {
    name: "get_dispute",
    description:
      "Get details for a specific dispute from PayPal.\n\n" +
      "This tool is used to lists disputes with a summary set of details, which shows the dispute_id, reason, status, dispute_state, dispute_life_cycle_stage, dispute_channel, dispute_amount, create_time and update_time fields.",
    inputSchema: {
      type: "object",
      properties: { dispute_id: { type: "string", pattern: DISPUTE_ID, description: "The order id generated during create call" } },
      required: ["dispute_id"],
    },
  },
  {
    name: "accept_dispute_claim",
    description:
      "Accept liability for a dispute claim.\n\n" +
      "This tool is used to accept liability for a dispute claim. When you accept liability for a dispute claim, the dispute closes in the customer's favor and PayPal automatically refunds money to the customer from the merchant's account.",
    // Upstream puts the dispute-id pattern on `note` (likely a typo); mirrored as-is, not enforced here.
    inputSchema: {
      type: "object",
      properties: {
        dispute_id: { type: "string" },
        note: { type: "string", description: "A note about why the seller is accepting the claim" },
      },
      required: ["dispute_id", "note"],
    },
  },
  {
    name: "get_refund",
    description:
      "Retrieve detailed information about a PayPal payment refund.\n" +
      "If you have an order ID instead of a refund ID, first use the get order tool to obtain the refund ID from the order details.\n" +
      "This function returns comprehensive details about a refund, including its current status (completed, pending, cancelled), refunded amount, and processing information.",
    inputSchema: {
      type: "object",
      properties: { refund_id: { type: "string", pattern: REFUND_ID, description: "The ID of the refund to get details for." } },
      required: ["refund_id"],
    },
  },
];

/** A dispute in the shape PayPal's Disputes API returns (the fields the toolkit summarises). */
export function disputeJson(d: Dispute) {
  return {
    dispute_id: d.disputeId,
    reason: d.reason,
    status: d.status === "OPEN" ? "WAITING_FOR_SELLER_RESPONSE" : "RESOLVED",
    dispute_state: d.status === "OPEN" ? "REQUIRED_ACTION" : "RESOLVED",
    dispute_life_cycle_stage: "CHARGEBACK",
    dispute_channel: "INTERNAL",
    dispute_amount: { currency_code: d.currency, value: d.amount.toFixed(2) },
    disputed_transactions: [{ seller_transaction_id: d.captureId }],
    messages: d.messages.map((content) => ({ posted_by: "BUYER", content })),
    create_time: d.createdAt.toISOString(),
  };
}

/** Forwards reads to PayPal's sandbox REST API, the same endpoints the toolkit calls. */
export class RestBackend implements ToolBackend {
  readonly label = "paypal-sandbox" as const;
  constructor(
    private readonly paypal: { get(path: string): Promise<unknown> },
    /** Demo disputes are served from the store (PayPal's sandbox can't open one by API). */
    private readonly store?: Store,
  ) {}

  tools() {
    return PAYPAL_TOOLS;
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = PAYPAL_TOOLS.find((t) => t.name === name);
    for (const [key, spec] of Object.entries(tool?.inputSchema.properties ?? {})) {
      const pattern = (spec as { pattern?: string }).pattern;
      // Validate before the id lands in a URL path.
      if (pattern && args[key] != null && !new RegExp(pattern).test(String(args[key]))) {
        return { name: "INVALID_REQUEST", message: `Invalid ${key}` };
      }
    }
    try {
      if (name === "get_order") return await this.paypal.get(`/v2/checkout/orders/${String(args.id)}`);
      if (name === "get_refund") return await this.paypal.get(`/v2/payments/refunds/${String(args.refund_id)}`);
      if (name === "get_dispute") {
        const local = this.store && (await this.store.getDispute(String(args.dispute_id)));
        if (local) return disputeJson(local);
        return await this.paypal.get(`/v1/customer/disputes/${String(args.dispute_id)}`);
      }
    } catch (err) {
      return { name: "PAYPAL_ERROR", message: (err as Error).message };
    }
    throw new Error(`Tool ${name} is not forwarded`);
  }
}

/** Serves reads from Paywarden's own ledger in PayPal's response shape. Refunds are executed by the Guard. */
export class SimBackend implements ToolBackend {
  readonly label = "offline-simulation" as const;
  constructor(private readonly store: Store) {}

  tools() {
    return PAYPAL_TOOLS;
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === "get_order") {
      const entry = (await this.store.listLedger()).find((e) => e.orderId === args.id);
      if (!entry) return { name: "RESOURCE_NOT_FOUND", message: `Order ${String(args.id)} not found` };
      return {
        id: entry.orderId,
        status: "COMPLETED",
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: "default",
            description: entry.description,
            custom_id: entry.note,
            amount: { currency_code: entry.currency, value: entry.amount.toFixed(2) },
            payments: {
              captures: [
                {
                  id: entry.captureId,
                  status: entry.refunded >= entry.amount ? "REFUNDED" : entry.refunded > 0 ? "PARTIALLY_REFUNDED" : "COMPLETED",
                  amount: { currency_code: entry.currency, value: entry.amount.toFixed(2) },
                  create_time: entry.capturedAt.toISOString(),
                },
              ],
            },
          },
        ],
      };
    }
    if (name === "get_dispute") {
      const d = await this.store.getDispute(String(args.dispute_id));
      return d ? disputeJson(d) : { name: "RESOURCE_NOT_FOUND", message: `Dispute ${String(args.dispute_id)} not found` };
    }
    if (name === "get_refund") {
      const entry = (await this.store.listAudit()).find((a) => a.paypal?.refundId === args.refund_id);
      if (!entry) return { name: "RESOURCE_NOT_FOUND", message: `Refund ${String(args.refund_id)} not found` };
      return { id: args.refund_id, status: entry.paypal?.status, amount: { currency_code: "USD", value: entry.effectiveAmount.toFixed(2) } };
    }
    throw new Error(`Tool ${name} is not available offline`);
  }
}
