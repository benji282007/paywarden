import { randomBytes } from "node:crypto";
import type { Session } from "../guard/guard.js";

export interface ProxySession extends Session {
  key: string;
  createdAt: Date;
}

/**
 * One session per customer conversation. The merchant's app creates it after it has
 * authenticated the customer, and hands the agent an MCP URL containing the key. The
 * customer identity therefore comes from the merchant, never from the model.
 */
export class SessionRegistry {
  private sessions = new Map<string, ProxySession>();

  create(input: { customerId: string; agentId?: string; mode?: Session["mode"] }): ProxySession {
    const key = randomBytes(18).toString("base64url");
    const s: ProxySession = {
      key,
      createdAt: new Date(),
      mode: input.mode === "unprotected" ? "unprotected" : "protected",
      agentId: input.agentId ?? "acme-support",
      customerId: input.customerId,
      conversationId: key,
      untrusted: [],
      trusted: [],
    };
    this.sessions.set(key, s);
    return s;
  }

  get(key: string): ProxySession | undefined {
    return this.sessions.get(key);
  }

  /** The customer's own chat message: the only text that legitimately expresses intent. */
  addCustomerMessage(key: string, text: string): void {
    const s = this.sessions.get(key);
    if (s) s.trusted.push({ origin: "customer chat", text });
  }

  clear(): void {
    this.sessions.clear();
  }
}
