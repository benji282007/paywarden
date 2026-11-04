// Replay a real merchant's year of refunds (UCI Online Retail II, converted by uci-to-paypal.py)
// through Paywarden's default rules, as if an AI agent had issued every one of them.
//   python3 -I scripts/uci-to-paypal.py online_retail_II.xlsx /tmp/uci-2011.csv
//   npx tsx scripts/backtest-uci.ts /tmp/uci-2011.csv
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEMO_POLICY } from "../src/demo/acme.js";
import { backtestCsv } from "../src/policy/import.js";

const csv = readFileSync(process.argv[2], "utf8");
const r = backtestCsv(DEMO_POLICY, csv);
const round = (n: number) => Math.round(n * 100) / 100;

const total = r.replayed;
const totalAmount = round(r.changed.reduce((t, x) => t, 0) + csvRefundTotal(csv));
const stopped = r.changed.filter((c) => c.after !== "allow");
const byReason = new Map<string, { count: number; amount: number }>();
for (const c of stopped) {
  const key = c.reason.replace(/\$[\d,.]+/g, "$X").replace(/\d+ days/g, "N days").replace(/\d+(\.\d+)? refunds?/g, "N refunds").slice(0, 110);
  const b = byReason.get(key) ?? { count: 0, amount: 0 };
  b.count++;
  b.amount += c.amount;
  byReason.set(key, b);
}
const held = stopped.filter((c) => c.after === "hold");
const blocked = stopped.filter((c) => c.after === "block");
const summary = {
  dataset: "UCI Online Retail II, Dec 2010 - Dec 2011 (real UK online retailer, CC BY 4.0), amounts in GBP",
  policy: DEMO_POLICY.rules.map((x) => x.id),
  refunds: total,
  refundAmount: totalAmount,
  linkedToOrder: r.source.matched,
  wouldGoStraightThrough: { count: total - stopped.length, amount: round(totalAmount - stopped.reduce((t, c) => t + c.amount, 0)) },
  wouldWaitForMerchant: { count: held.length, amount: round(held.reduce((t, c) => t + c.amount, 0)) },
  wouldBeRefused: { count: blocked.length, amount: round(blocked.reduce((t, c) => t + c.amount, 0)) },
  reasons: [...byReason.entries()].sort((a, b) => b[1].amount - a[1].amount).slice(0, 8).map(([reason, v]) => ({ reason, count: v.count, amount: round(v.amount) })),
  serialRefunders: r.serialRefunders.map((s) => ({ ...s, customer: s.customer.replace(/@.*/, "") })),
  notReplayed: r.source.notReplayed,
};
console.log(JSON.stringify(summary, null, 1));
writeFileSync(fileURLToPath(new URL("../test/fixtures/uci-backtest.json", import.meta.url)), JSON.stringify(summary, null, 1));

function csvRefundTotal(text: string): number {
  return text
    .split("\n")
    .filter((l) => l.includes(",Refund,"))
    .reduce((t, l) => t + Math.abs(Number(l.split(",")[6])), 0);
}
