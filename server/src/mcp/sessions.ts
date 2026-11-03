import { randomBytes } from "node:crypto";
import type { Session } from "../guard/guard.js";

export interface ProxySession extends Session {
  key: string;
  createdAt: Date;
  lastUsed: number;
}

const MAX_SESSIONS = 200;
const IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_TEXTS = 50;

/**
 * One session per customer conversation. The merchant's app creates it after it has
 * authenticated the customer, and hands the agent an MCP URL containing the key. The
 * customer identity therefore comes from the merchant, never from the model.
 * Sessions expire after two idle hours and are capped, so a public demo can't grow without bound.
 */
export class SessionRegistry {
  private sessions = new Map<string, ProxySession>();
  /** Called when a session is dropped, so per-session state elsewhere (chat history) goes too. */
  onEvict?: (key: string) => void;

  create(input: { customerId: string; agentId?: string; mode?: Session["mode"] }): ProxySession {
    this.evict();
    const key = randomBytes(18).toString("base64url");
    const s: ProxySession = {
      key,
      createdAt: new Date(),
      lastUsed: Date.now(),
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
    const s = this.sessions.get(key);
    if (s) s.lastUsed = Date.now();
    return s;
  }

  keys(): string[] {
    return [...this.sessions.keys()];
  }

  /** The customer's own chat message: the only text that legitimately expresses intent. */
  addCustomerMessage(key: string, text: string): void {
    const s = this.get(key);
    if (!s) return;
    s.trusted.push({ origin: "customer chat", text: text.slice(0, 2000) });
    if (s.trusted.length > MAX_TEXTS) s.trusted.splice(0, s.trusted.length - MAX_TEXTS);
  }

  /** Customer-writable text the agent saw. Kept (capped) for the session's lifetime: once read, it can steer later calls too. */
  addUntrusted(key: string, sources: Session["untrusted"]): void {
    const s = this.sessions.get(key);
    if (!s || sources.length === 0) return;
    for (const src of sources) if (!s.untrusted.some((u) => u.origin === src.origin && u.text === src.text)) s.untrusted.push({ origin: src.origin, text: src.text.slice(0, 4000) });
    if (s.untrusted.length > MAX_TEXTS) s.untrusted.splice(0, s.untrusted.length - MAX_TEXTS);
  }

  clear(): void {
    for (const key of this.sessions.keys()) this.onEvict?.(key);
    this.sessions.clear();
  }

  private evict() {
    const now = Date.now();
    for (const [key, s] of this.sessions) {
      if (now - s.lastUsed > IDLE_MS) {
        this.sessions.delete(key);
        this.onEvict?.(key);
      }
    }
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      this.sessions.delete(oldest.key);
      this.onEvict?.(oldest.key);
    }
  }
}
