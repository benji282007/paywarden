// Signed refund confirmations ("mandates"). The merchant's own app, never the agent,
// issues one when the signed-in customer taps "Yes, refund this" on a card it renders
// itself. A mandate names one capture, a maximum amount and an expiry, and is signed
// with the merchant's secret (HMAC-SHA256). Nothing the agent reads or writes can
// produce a valid one, so "did the customer ask for this exact refund?" stops being a
// guess about wording and becomes a signature check.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface Mandate {
  v: 1;
  id: string;
  customerId: string;
  captureId: string;
  /** The most this confirmation can move, in the capture's currency. */
  maxAmount: number;
  currency: string;
  /** Unix seconds. */
  exp: number;
  /** How the customer confirmed: a tap in the merchant's own UI, or the merchant on their behalf. */
  via: "customer_tap" | "merchant";
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const mac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64url");

/** `<base64url json>.<base64url hmac>` — small enough for a header, an MCP `_meta` field or a QR code. */
export function signMandate(secret: string, m: Mandate): string {
  const body = b64(JSON.stringify(m));
  return `${body}.${mac(secret, body)}`;
}

export function verifyMandate(secret: string, token: string, now = new Date()): { ok: true; mandate: Mandate } | { ok: false; reason: string } {
  if (typeof token !== "string" || token.length > 2000) return { ok: false, reason: "not a mandate" };
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return { ok: false, reason: "malformed mandate" };
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "bad signature" };
  let m: Mandate;
  try {
    m = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "unreadable mandate" };
  }
  if (m.v !== 1 || typeof m.captureId !== "string" || typeof m.customerId !== "string" || !(m.maxAmount > 0)) return { ok: false, reason: "invalid mandate" };
  if (m.exp * 1000 < now.getTime()) return { ok: false, reason: "mandate expired" };
  return { ok: true, mandate: m };
}

/**
 * The mandates a workspace has accepted, and how much of each is spent. A mandate is
 * one-shot up to its amount: a confirmed $36 refund can't be replayed for another $36.
 */
export class MandateBook {
  private items = new Map<string, { mandate: Mandate; used: number }>();

  constructor(readonly secret: string = randomBytes(32).toString("base64url")) {}

  /** What the merchant's backend does when the customer taps confirm. */
  issue(input: { customerId: string; captureId: string; maxAmount: number; currency?: string; ttlSeconds?: number; via?: Mandate["via"] }, now = new Date()) {
    const mandate: Mandate = {
      v: 1,
      id: `md_${randomBytes(9).toString("base64url")}`,
      customerId: input.customerId,
      captureId: input.captureId,
      maxAmount: Math.round(input.maxAmount * 100) / 100,
      currency: input.currency ?? "USD",
      exp: Math.floor(now.getTime() / 1000) + Math.min(input.ttlSeconds ?? 900, 24 * 3600),
      via: input.via ?? "customer_tap",
    };
    return { mandate, token: signMandate(this.secret, mandate) };
  }

  /** Verify and remember a token. It only counts for the customer the session is signed in as. */
  accept(token: string, customerId: string, now = new Date()): { ok: true; mandate: Mandate } | { ok: false; reason: string } {
    const v = verifyMandate(this.secret, token, now);
    if (!v.ok) return v;
    if (v.mandate.customerId !== customerId) return { ok: false, reason: "mandate is for a different customer" };
    if (!this.items.has(v.mandate.id)) this.items.set(v.mandate.id, { mandate: v.mandate, used: 0 });
    if (this.items.size > 5000) this.items.delete(this.items.keys().next().value!);
    return v;
  }

  /** An unexpired, unspent mandate from this customer for this capture that covers the amount. */
  covering(customerId: string, captureId: string | undefined, amount: number, now = new Date()): (Mandate & { remaining: number }) | undefined {
    if (!captureId) return undefined;
    for (const { mandate, used } of this.items.values()) {
      const remaining = Math.round((mandate.maxAmount - used) * 100) / 100;
      if (mandate.customerId === customerId && mandate.captureId === captureId && mandate.exp * 1000 >= now.getTime() && amount <= remaining + 0.001) {
        return { ...mandate, remaining };
      }
    }
    return undefined;
  }

  spend(id: string, amount: number): void {
    const item = this.items.get(id);
    if (item) item.used = Math.round((item.used + amount) * 100) / 100;
  }

  /** The customer's chat turn, signed by the merchant's chat front end for one session. */
  signText(text: string, sessionKey: string): string {
    return mac(this.secret, `turn:${sessionKey}:${text}`);
  }

  verifyText(text: string, sessionKey: string, sig: string): boolean {
    const want = Buffer.from(this.signText(text, sessionKey));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** A short signature for links (the phone approval QR code). */
  signLink(...parts: string[]): string {
    return mac(this.secret, `link:${parts.join(":")}`).slice(0, 22);
  }

  verifyLink(sig: string, ...parts: string[]): boolean {
    const want = Buffer.from(this.signLink(...parts));
    const got = Buffer.from(String(sig));
    return want.length === got.length && timingSafeEqual(want, got);
  }

  clear(): void {
    this.items.clear();
  }
}
