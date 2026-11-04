import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Guard } from "../guard/guard.js";
import { isMoneyTool } from "../policy/evaluate.js";
import { extractUntrusted } from "../provenance/extract.js";
import type { AuditEntry, Store } from "../store/types.js";
import type { ToolBackend } from "./backend.js";
import type { ProxySession, SessionRegistry } from "./sessions.js";

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Turn a guard decision into what the agent sees. Held and blocked results tell the
 * agent plainly what happened and not to retry, so a well-behaved agent tells the
 * customer instead of looping.
 */
export function toToolResult(entry: AuditEntry): CallToolResult {
  switch (entry.status) {
    case "executed":
    case "approved":
      return json({ id: entry.paypal?.refundId, status: entry.paypal?.status, amount: { currency_code: "USD", value: entry.effectiveAmount.toFixed(2) } });
    case "simulated":
      return json({ id: `SIMULATED-${entry.id.slice(0, 8)}`, status: "COMPLETED", amount: { currency_code: "USD", value: entry.effectiveAmount.toFixed(2) } });
    case "held":
      if (entry.confirmable) {
        return {
          content: [
            {
              type: "text",
              text:
                `CUSTOMER_CONFIRMATION_REQUIRED: the shop's app is now showing the customer a button to confirm this ${usd(entry.effectiveAmount)} refund (reference ${entry.id.slice(0, 8)}). ` +
                `If they tap it, the refund goes through. Tell them that, in one sentence. Do not retry.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `PENDING_MERCHANT_APPROVAL: this ${usd(entry.effectiveAmount)} refund needs the merchant's approval (reference ${entry.id.slice(0, 8)}). ` +
              `Tell the customer their request is being reviewed by the team. Do not retry.`,
          },
        ],
      };
    case "blocked":
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `BLOCKED_BY_POLICY: ${entry.hits.map((h) => h.reason).join("; ")}. ` +
              `Do not retry. Tell the customer you can't do this yourself and offer to connect them with the team.`,
          },
        ],
      };
    default:
      return { isError: true, content: [{ type: "text", text: `PayPal error: ${entry.paypal?.error ?? entry.status}` }] };
  }
}

/**
 * Reads are scoped to the signed-in customer too: an agent can't be talked into
 * fetching someone else's order (and reading their address or notes).
 */
async function ownsTarget(store: Store, session: ProxySession, name: string, args: Record<string, unknown>): Promise<boolean> {
  if (name === "get_order" && typeof args.id === "string") {
    const entry = (await store.listLedger()).find((e) => e.orderId === args.id);
    return !!entry && entry.customerId === session.customerId;
  }
  if (name === "get_refund" && typeof args.refund_id === "string") {
    const entry = await store.findAuditByRefundId(args.refund_id);
    return !!entry && entry.customerId === session.customerId;
  }
  return true;
}

export const META_MANDATES = "paywarden/mandates";
export const META_CUSTOMER_TURN = "paywarden/customer_turn";

/**
 * MCP lets the *client* attach `_meta` to a tool call. The model only fills `arguments`,
 * so `_meta` is where the merchant's own code can pass what the agent must not forge:
 * signed confirmations (verified here; a bad signature is ignored) and the customer's
 * latest message, signed with the same merchant secret.
 */
function absorbMeta(meta: unknown, session: ProxySession, guard: Guard, sessions?: SessionRegistry) {
  if (!meta || typeof meta !== "object") return;
  const m = meta as Record<string, unknown>;
  const tokens = Array.isArray(m[META_MANDATES]) ? (m[META_MANDATES] as unknown[]) : [];
  for (const t of tokens.slice(0, 10)) if (typeof t === "string") guard.mandates.accept(t, session.customerId);
  const turn = m[META_CUSTOMER_TURN] as { text?: unknown; sig?: unknown } | undefined;
  if (turn && typeof turn.text === "string" && typeof turn.sig === "string" && guard.mandates.verifyText(turn.text, session.key, turn.sig)) {
    if (sessions) sessions.addCustomerMessage(session.key, turn.text);
    else session.trusted.push({ origin: "customer chat", text: turn.text });
  }
}

export function buildMcpServer(session: ProxySession, guard: Guard, backend: ToolBackend, store: Store, sessions?: SessionRegistry): Server {
  const server = new Server({ name: "paywarden", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: backend.tools() }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    // Set by the merchant's code (the adapter), never by the model: signed confirmations and the customer's own turn.
    absorbMeta(req.params._meta, session, guard, sessions);
    if (!backend.tools().some((t) => t.name === name)) {
      return { isError: true, content: [{ type: "text", text: `Unknown tool ${name}` }] };
    }

    if (isMoneyTool(name)) return toToolResult(await guard.handle({ tool: name, args }, session));

    if (!(await ownsTarget(store, session, name, args))) {
      // Same answer as a missing order, so the agent learns nothing about other customers.
      return json({ name: "RESOURCE_NOT_FOUND", message: "No matching record for this customer." });
    }

    // Read-only: forward, then remember any customer-writable text the agent is about to see.
    const result = await backend.call(name, args);
    const hint = typeof args.id === "string" ? args.id : typeof args.dispute_id === "string" ? args.dispute_id : undefined;
    const seen = extractUntrusted(name, result, hint);
    if (sessions) sessions.addUntrusted(session.key, seen);
    else session.untrusted.push(...seen);
    return json(result);
  });

  return server;
}

/** Stateless Streamable HTTP: a fresh server per request, state lives in the session registry. */
export function mcpHandler(sessions: SessionRegistry, guard: Guard, backend: ToolBackend, store: Store) {
  return async (req: Request, res: Response) => {
    const session = sessions.get(String(req.params.key));
    if (!session) {
      res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unknown Paywarden session" }, id: null });
      return;
    }
    if (req.method !== "POST") {
      res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
      return;
    }
    const server = buildMcpServer(session, guard, backend, store, sessions);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
