#!/usr/bin/env node
// Verify a Paywarden refund mandate with nothing but the merchant's public JWKS and
// Node's built-in crypto: no Paywarden code, no secret. This is what an auditor runs.
//
//   node scripts/verify-mandate.mjs <jwks.json | jwks URL> <mandate token>

import { createPublicKey, createHash, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const [src, token] = process.argv.slice(2);
if (!src || !token) {
  console.error("usage: node scripts/verify-mandate.mjs <jwks.json | url> <token>");
  process.exit(2);
}
const jwks = /^https?:/.test(src) ? await (await fetch(src)).json() : JSON.parse(readFileSync(src, "utf8"));
const [h, p, s] = token.split(".");
const header = JSON.parse(Buffer.from(h, "base64url").toString());
const claims = JSON.parse(Buffer.from(p, "base64url").toString());
const jwk = jwks.keys.find((k) => k.kid === header.kid);
if (!jwk) throw new Error(`No key ${header.kid} in the JWKS`);
const key = createPublicKey({ key: jwk, format: "jwk" });
const kid = createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("base64url").slice(0, 16);
const ok = header.alg === "EdDSA" && kid === header.kid && verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
const m = claims.mandate ?? {};
console.log(`${ok ? "VALID" : "INVALID"} signature (EdDSA, key ${header.kid})`);
console.log(`  customer ${claims.sub} consented to refund capture ${m.capture_id}, up to ${m.max_amount?.value} ${m.max_amount?.currency_code}`);
console.log(`  via ${m.presence}, issued ${new Date(claims.iat * 1000).toISOString()}, expires ${new Date(claims.exp * 1000).toISOString()}, id ${claims.jti}`);
process.exit(ok ? 0 : 1);
