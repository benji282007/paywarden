// Refund mandates: the customer's consent, signed by the merchant, verifiable by anyone.
//
// When the agent wants to refund, the merchant's own app shows the signed-in customer
// "Refund $36.00 to you?". Their tap makes the merchant's backend sign a mandate with
// the merchant's PRIVATE key (Ed25519). Paywarden holds only the PUBLIC key, so neither
// the agent, nor anything it reads, nor Paywarden itself can mint one.
//
// The format is a standard compact JWS (alg EdDSA), so any JOSE library, an auditor or
// PayPal could check it against the merchant's published JWKS. The claims follow the idea
// of agent-payment "mandates" (a signed, scoped, expiring statement of user intent):
//
//   { iss, sub: customer, aud: "paywarden", jti, iat, exp,
//     mandate: { type: "RefundMandate", capture_id, max_amount: {currency_code, value}, presence: "customer_tap" } }
//
// Each mandate pays out at most once: the refund it releases is sent to PayPal with a
// PayPal-Request-Id derived from its jti, so even a replay reaching PayPal can't pay twice.

import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";

export interface Mandate {
  id: string;
  iss: string;
  customerId: string;
  captureId: string;
  /** The most this mandate can move, in the capture's currency. */
  maxAmount: number;
  currency: string;
  iat: number;
  /** Unix seconds. */
  exp: number;
  via: "customer_tap" | "merchant";
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const json64 = (v: unknown) => b64(JSON.stringify(v));
const hmac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64url");

export function keyId(publicKey: KeyObject): string {
  return createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("base64url").slice(0, 16);
}

/** Sign a mandate as the merchant's backend does. Needs the merchant's private key. */
export function signMandate(privateKey: KeyObject, m: Mandate): string {
  const kid = keyId(createPublicKey(privateKey));
  const header = json64({ alg: "EdDSA", typ: "refund-mandate+jwt", kid });
  const payload = json64({
    iss: m.iss,
    sub: m.customerId,
    aud: "paywarden",
    jti: m.id,
    iat: m.iat,
    exp: m.exp,
    mandate: { type: "RefundMandate", capture_id: m.captureId, max_amount: { currency_code: m.currency, value: m.maxAmount.toFixed(2) }, presence: m.via },
  });
  return `${header}.${payload}.${b64(sign(null, Buffer.from(`${header}.${payload}`), privateKey))}`;
}

/** Verify a mandate against the merchant's public key(s). No secret needed: this is what an auditor runs. */
export function verifyMandate(publicKeys: KeyObject[], token: string, now = new Date()): { ok: true; mandate: Mandate } | { ok: false; reason: string } {
  if (typeof token !== "string" || token.length > 4000) return { ok: false, reason: "not a mandate" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed mandate" };
  const [h, p, s] = parts;
  let header: { alg?: string; kid?: string };
  let claims: {
    iss?: string;
    sub?: string;
    aud?: string;
    jti?: string;
    iat?: number;
    exp?: number;
    mandate?: { type?: string; capture_id?: string; max_amount?: { currency_code?: string; value?: string }; presence?: string };
  };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "unreadable mandate" };
  }
  if (header.alg !== "EdDSA") return { ok: false, reason: "unsupported algorithm" };
  const key = publicKeys.find((k) => keyId(k) === header.kid);
  if (!key) return { ok: false, reason: "signed by an unknown key" };
  if (!verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) return { ok: false, reason: "bad signature" };
  const m = claims.mandate;
  const max = Number(m?.max_amount?.value);
  if (claims.aud !== "paywarden" || m?.type !== "RefundMandate" || typeof m.capture_id !== "string" || typeof claims.sub !== "string" || typeof claims.jti !== "string" || !(max > 0)) {
    return { ok: false, reason: "invalid mandate" };
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now.getTime()) return { ok: false, reason: "mandate expired" };
  return {
    ok: true,
    mandate: {
      id: claims.jti,
      iss: claims.iss ?? "",
      customerId: claims.sub,
      captureId: m.capture_id,
      maxAmount: max,
      currency: m.max_amount?.currency_code ?? "USD",
      iat: claims.iat ?? 0,
      exp: claims.exp,
      via: m.presence === "merchant" ? "merchant" : "customer_tap",
    },
  };
}

/** The PayPal-Request-Id a mandate's refund is sent with: one mandate, at most one payout. */
export const mandateRequestId = (jti: string) => `pw-m-${createHash("sha256").update(jti).digest("hex").slice(0, 32)}`;

/** The merchant side: holds the private key and signs on the customer's tap. */
export class MandateIssuer {
  readonly publicKey: KeyObject;
  constructor(
    private readonly privateKey: KeyObject,
    readonly issuer = "merchant",
  ) {
    this.publicKey = createPublicKey(privateKey);
  }

  static generate(issuer?: string): MandateIssuer {
    return new MandateIssuer(generateKeyPairSync("ed25519").privateKey, issuer);
  }

  issue(input: { customerId: string; captureId: string; maxAmount: number; currency?: string; ttlSeconds?: number; via?: Mandate["via"] }, now = new Date()) {
    const iat = Math.floor(now.getTime() / 1000);
    const mandate: Mandate = {
      id: `md_${randomBytes(12).toString("base64url")}`,
      iss: this.issuer,
      customerId: input.customerId,
      captureId: input.captureId,
      maxAmount: Math.round(input.maxAmount * 100) / 100,
      currency: input.currency ?? "USD",
      iat,
      exp: iat + Math.min(input.ttlSeconds ?? 900, 24 * 3600),
      via: input.via ?? "customer_tap",
    };
    return { mandate, token: signMandate(this.privateKey, mandate) };
  }
}

/** A JWKS document for the merchant's public keys, so anyone can verify a mandate. */
export function jwks(keys: KeyObject[]) {
  return { keys: keys.map((k) => ({ ...(k.export({ format: "jwk" }) as object), kid: keyId(k), alg: "EdDSA", use: "sig" })) };
}

/** Load a merchant key from PEM or a JWK JSON string. */
export function loadKey(text: string, kind: "public" | "private"): KeyObject {
  const t = text.trim();
  if (t.startsWith("{")) return kind === "public" ? createPublicKey({ key: JSON.parse(t), format: "jwk" }) : createPrivateKey({ key: JSON.parse(t), format: "jwk" });
  return kind === "public" ? createPublicKey(t) : createPrivateKey(t);
}

/**
 * Paywarden's side: verifies mandates with the merchant's PUBLIC key(s) and remembers
 * which are spent. In the hosted demo, Paywarden also plays the merchant's backend
 * (`issuer`), because there is no separate merchant app; a real deployment sets only
 * PAYWARDEN_MERCHANT_PUBLIC_KEY and Paywarden can verify but never sign.
 */
export class MandateBook {
  private items = new Map<string, { mandate: Mandate; spent: boolean }>();
  readonly publicKeys: KeyObject[];
  /** Only for the demo / self-hosted issuer. Undefined when the merchant keeps its key. */
  readonly issuer?: MandateIssuer;
  private readonly linkSecret: string;

  constructor(opts: { publicKeys?: KeyObject[]; issuer?: MandateIssuer; linkSecret?: string } = {}) {
    this.issuer = opts.issuer ?? (opts.publicKeys ? undefined : MandateIssuer.generate("demo-merchant"));
    this.publicKeys = [...(opts.publicKeys ?? []), ...(this.issuer ? [this.issuer.publicKey] : [])];
    this.linkSecret = opts.linkSecret ?? randomBytes(32).toString("base64url");
  }

  /** Demo / self-hosted issuer only: what the merchant's backend does on the customer's tap. */
  issue(input: Parameters<MandateIssuer["issue"]>[0], now = new Date()) {
    if (!this.issuer) throw new Error("This Paywarden only verifies mandates; the merchant signs them with its own key");
    return this.issuer.issue(input, now);
  }

  /** Persistence hook: called when a mandate is spent, and to restore spent ids on start. */
  onSpend?: (id: string) => void;
  markSpent(ids: Iterable<string>) {
    for (const id of ids) this.spentIds.add(id);
  }
  private spentIds = new Set<string>();

  /** Verify and remember a token. It only counts for the customer the session is signed in as. */
  accept(token: string, customerId: string, now = new Date()): { ok: true; mandate: Mandate } | { ok: false; reason: string } {
    const v = verifyMandate(this.publicKeys, token, now);
    if (!v.ok) return v;
    if (v.mandate.customerId !== customerId) return { ok: false, reason: "mandate is for a different customer" };
    if (this.spentIds.has(v.mandate.id)) return { ok: false, reason: "mandate already used" };
    if (!this.items.has(v.mandate.id)) this.items.set(v.mandate.id, { mandate: v.mandate, spent: false });
    if (this.items.size > 5000) this.items.delete(this.items.keys().next().value!);
    return v;
  }

  /** An unexpired, unspent mandate from this customer for this capture that covers the amount. */
  covering(customerId: string, captureId: string | undefined, amount: number, now = new Date()): (Mandate & { remaining: number }) | undefined {
    if (!captureId) return undefined;
    for (const { mandate, spent } of this.items.values()) {
      if (spent || this.spentIds.has(mandate.id)) continue;
      if (mandate.customerId === customerId && mandate.captureId === captureId && mandate.exp * 1000 >= now.getTime() && amount <= mandate.maxAmount + 0.001) {
        return { ...mandate, remaining: mandate.maxAmount };
      }
    }
    return undefined;
  }

  /** One mandate, one refund. */
  spend(id: string): void {
    const item = this.items.get(id);
    if (item) item.spent = true;
    this.spentIds.add(id);
    this.onSpend?.(id);
  }

  jwks() {
    return jwks(this.publicKeys);
  }

  /** The customer's chat turn, signed by the merchant's chat front end for one session. */
  signText(text: string, sessionKey: string): string {
    return hmac(this.linkSecret, `turn:${sessionKey}:${text}`);
  }

  verifyText(text: string, sessionKey: string, sig: string): boolean {
    return same(this.signText(text, sessionKey), sig);
  }

  /** A short signature for links (the phone approval QR code). */
  signLink(...parts: string[]): string {
    return hmac(this.linkSecret, `link:${parts.join(":")}`).slice(0, 22);
  }

  verifyLink(sig: string, ...parts: string[]): boolean {
    return same(this.signLink(...parts), String(sig));
  }

  clear(): void {
    this.items.clear();
    this.spentIds.clear();
  }
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
