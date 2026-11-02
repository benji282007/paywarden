import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Guard } from "../guard/guard.js";
import { isMoneyTool } from "../policy/evaluate.js";
import { extractUntrusted } from "../provenance/extract.js";
import type { AuditEntry } from "../store/types.js";
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

export function buildMcpServer(session: ProxySession, guard: Guard, backend: ToolBackend): Server {
  const server = new Server({ name: "paywarden", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: backend.tools() }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (!backend.tools().some((t) => t.name === name)) {
      return { isError: true, content: [{ type: "text", text: `Unknown tool ${name}` }] };
    }

    if (isMoneyTool(name)) return toToolResult(await guard.handle({ tool: name, args }, session));

    // Read-only: forward, then remember any customer-writable text the agent is about to see.
    const result = await backend.call(name, args);
    const hint = typeof args.id === "string" ? args.id : typeof args.dispute_id === "string" ? args.dispute_id : undefined;
    session.untrusted.push(...extractUntrusted(name, result, hint));
    return json(result);
  });

  return server;
}

/** Stateless Streamable HTTP: a fresh server per request, state lives in the session registry. */
export function mcpHandler(sessions: SessionRegistry, guard: Guard, backend: ToolBackend) {
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
    const server = buildMcpServer(session, guard, backend);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
