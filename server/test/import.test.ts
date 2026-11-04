import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACME_POLICY } from "../src/demo/acme.js";
import { backtestCsv, importActivityCsv, parseCsv } from "../src/policy/import.js";

const csv = readFileSync(new URL("./fixtures/sample-paypal-activity.csv", import.meta.url), "utf8");

describe("PayPal activity export import", () => {
  it("parses quoted CSV with commas, quotes and a BOM", () => {
    expect(parseCsv('﻿"a","b, c","say ""hi"""\r\n1,2,3')).toEqual([["a", "b, c", 'say "hi"'], ["1", "2", "3"]]);
  });

  it("pairs every refund with its original payment", () => {
    const h = importActivityCsv(csv);
    expect(h.refunds).toBeGreaterThan(20);
    expect(h.matched).toBe(h.refunds);
  });

  it("backtests real refunds: duplicates, old orders, over-cap and bursts show up", () => {
    const r = backtestCsv(ACME_POLICY, csv);
    const reasons = r.changed.map((c) => c.reason).join("\n");
    expect(r.newlyStopped.count).toBeGreaterThan(0);
    expect(reasons).toMatch(/already refunded|still refundable/);
    expect(reasons).toMatch(/days old/);
    expect(reasons).toMatch(/exceeds the \$50.00 limit/);
    expect(r.source.notReplayed).toContain("who asked (a CSV has no chat)");
  });

  it("explains a wrong file instead of guessing", () => {
    expect(() => importActivityCsv("name,email\nx,y")).toThrow(/doesn't look like a PayPal activity export/);
  });
});
