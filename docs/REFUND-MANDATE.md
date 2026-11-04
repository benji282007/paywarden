# RefundMandate v1

A small, open format for a customer's consent to one refund, so that an AI agent can be
allowed to move money only when the person it moves money *to* actually said yes. Anyone can
implement it; nothing in it is specific to Paywarden.

## Roles

- **Customer:** signed in to the merchant's app; taps "Yes, refund me" on a card the merchant
  renders (for example `<paywarden-confirm>`).
- **Merchant (issuer):** holds an Ed25519 private key. Its backend, which knows who is signed
  in, signs a mandate on the tap. Publishes the public key as a JWKS.
- **Guard (verifier):** sits between the agent and the payment API (Paywarden). Holds only the
  public key. Releases a refund only if a valid mandate covers it.
- **Agent:** never sees the key, and never sets the field the mandate travels in (MCP
  `_meta["paywarden/mandates"]`, set by the client code, not the model).

## Token

A compact JWS (RFC 7515), `alg: "EdDSA"` (Ed25519, RFC 8037).

Header:

```json
{ "alg": "EdDSA", "typ": "refund-mandate+jwt", "kid": "<first 16 chars of base64url(sha256(SPKI DER))>" }
```

Claims:

| Claim | Meaning |
|---|---|
| `iss` | Merchant identifier |
| `sub` | The signed-in customer's id in the merchant's system |
| `aud` | `"paywarden"` (the verifier) |
| `jti` | Unique mandate id |
| `iat`, `exp` | Issued / expires, Unix seconds. Recommended lifetime: 15 minutes |
| `mandate.type` | `"RefundMandate"` |
| `mandate.capture_id` | The one PayPal capture this consent is for |
| `mandate.max_amount` | `{ "currency_code": "USD", "value": "36.00" }`: the most it may move |
| `mandate.presence` | `"customer_tap"` (customer present) or `"merchant"` |

## Verifier rules

A refund call `(capture_id, amount)` for signed-in customer `C` is covered when **all** hold:

1. Signature verifies against a key in the merchant's JWKS whose `kid` matches; `alg` is `EdDSA`.
2. `aud == "paywarden"`, `mandate.type == "RefundMandate"`, `exp` is in the future.
3. `sub == C` (the session's customer, which comes from the merchant's login, never the model).
4. `mandate.capture_id == capture_id` and `amount <= mandate.max_amount.value` in the same currency.
5. The `jti` has not been spent. **One mandate releases at most one refund.**

A covered refund is still subject to every merchant limit (caps, velocity, order age, repeat
refunders, ownership, the live refund total). A mandate settles *who asked and for what*; it
never lifts a limit.

## Binding to the payment

- The refund is sent with `PayPal-Request-Id = "pw-m-" + hex(sha256(jti))[0:32]`, so even a
  replay that reached PayPal can't pay twice.
- The refund's `custom_id` on PayPal's own record is
  `"pw-consent:" + jti + ":" + base64url(sha256(token))[0:32]`, so PayPal's record points at
  verifiable consent in any later chargeback or audit.

## Test vector

[`refund-mandate-test-vector.json`](refund-mandate-test-vector.json): a private key seed
(32 bytes of `0x07`, **test only**), its JWKS, the mandate fields, and the exact token they
produce (Ed25519 signatures are deterministic, so any implementation must produce the same
string). Verify it with nothing but Node:

```bash
node server/scripts/verify-mandate.mjs <(node -e 'console.log(JSON.stringify(require("./docs/refund-mandate-test-vector.json").jwks))') "$(node -p 'require("./docs/refund-mandate-test-vector.json").token')"
```

(The token's `exp` is in the past by design; the script reports the signature, the test in
`server/test/mandate-vector.test.ts` checks the full rules at the vector's `verify_at_unix`.)
