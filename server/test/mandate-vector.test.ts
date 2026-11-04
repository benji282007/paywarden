import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { signRefundMandate } from "../src/adapter/paywarden.js";
import { signMandate, verifyMandate, type Mandate } from "../src/mandate/mandate.js";

const vec = JSON.parse(readFileSync(new URL("../../docs/refund-mandate-test-vector.json", import.meta.url), "utf8")) as {
  private_key_seed_hex: string;
  jwks: { keys: Record<string, unknown>[] };
  mandate: Mandate;
  verify_at_unix: number;
  token: string;
};
const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(vec.private_key_seed_hex, "hex")]), format: "der", type: "pkcs8" });

describe("RefundMandate v1 test vector (docs/REFUND-MANDATE.md)", () => {
  it("signing the vector's mandate reproduces its token exactly (Ed25519 is deterministic)", () => {
    expect(signMandate(priv, vec.mandate)).toBe(vec.token);
  });

  it("verifies from the published JWKS alone, and fails after expiry", () => {
    const keys = vec.jwks.keys.map((k) => createPublicKey({ key: k as never, format: "jwk" }));
    const ok = verifyMandate(keys, vec.token, new Date(vec.verify_at_unix * 1000));
    expect(ok).toMatchObject({ ok: true, mandate: { id: vec.mandate.id, captureId: vec.mandate.captureId, maxAmount: 36, customerId: "sam" } });
    expect(verifyMandate(keys, vec.token, new Date((vec.mandate.exp + 1) * 1000)).ok).toBe(false);
  });

  it("the adapter's standalone signer emits the same format", () => {
    const t = signRefundMandate(priv, { customerId: "sam", captureId: "X", maxAmount: 1 });
    expect(verifyMandate([createPublicKey(priv)], t).ok).toBe(true);
  });
});
