// Backtest on a merchant's own PayPal history: parse PayPal's "Activity download" CSV
// (Reports > Activity download), pair each refund with its original payment through
// "Reference Txn ID", and replay the refunds under a draft policy. A CSV carries no chat,
// so the "who asked" and untrusted-text checks can't be replayed; the report says so.

import { randomUUID } from "node:crypto";
import type { AuditEntry } from "../store/types.js";
import { backtest, type BacktestReport, type CaptureFacts, type StatsAt } from "./backtest.js";
import type { Policy } from "./types.js";
import { findInstructionSpans } from "../provenance/analyze.js";

/** RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

const money = (v: string | undefined) => Number(String(v ?? "").replace(/[^0-9.-]/g, "")) || 0;

function when(date: string, time: string): Date {
  // PayPal exports dates as MM/DD/YYYY (US) or DD/MM/YYYY; ISO also accepted.
  const t = time?.trim() || "00:00:00";
  if (/^\d{4}-\d{2}-\d{2}/.test(date)) return new Date(`${date.slice(0, 10)}T${t}Z`);
  const [a, b, y] = date.split(/[/.-]/).map(Number);
  const [m, d] = a > 12 ? [b, a] : [a, b];
  return new Date(Date.UTC(y, m - 1, d, ...t.split(":").map(Number)));
}

/**
 * What an AI agent reading these orders would have been exposed to: refunds on payments
 * that carried text the buyer typed (PayPal's Note / Subject / Custom fields). Every one is
 * a place an injected instruction can sit; the ones that read like instructions are listed.
 */
export interface Exposure {
  /** Whether the export had any buyer-text column at all. */
  hasTextColumns: boolean;
  paymentsWithText: number;
  payments: number;
  refundsOnTextOrders: number;
  dollarsOnTextOrders: number;
  refundDollars: number;
  /** Payments whose buyer text reads like an instruction to staff or a bot. */
  instructionLike: { txn: string; amount: number; text: string; flagged: string }[];
}

/** Customers whose refunds come back to a big share of what they paid: abuse a confirm button can't stop. */
export interface SerialRefunder {
  customer: string;
  payments: number;
  paid: number;
  refunds: number;
  refunded: number;
}

export interface ImportedHistory {
  refunds: number;
  matched: number;
  exposure: Exposure;
  serialRefunders: SerialRefunder[];
  statsAt: StatsAt;
  /** From the export's Currency column (first refund row); USD when absent. */
  currency: string;
  entries: AuditEntry[];
  captures: Map<string, CaptureFacts>;
}

export function importActivityCsv(text: string): ImportedHistory {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("That file has no rows.");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iDate = col("date"), iTime = col("time"), iName = col("name"), iType = col("type"), iStatus = col("status");
  const iGross = col("gross"), iFrom = col("from email address"), iTo = col("to email address");
  const iId = col("transaction id"), iRef = col("reference txn id"), iCur = col("currency");
  const textCols = ["note", "subject", "custom number", "custom field", "message"].map((n) => col(n)).filter((i) => i >= 0);
  if ([iDate, iType, iGross, iId].some((i) => i < 0)) {
    throw new Error("This doesn't look like a PayPal activity export: expected Date, Type, Gross and Transaction ID columns.");
  }

  const payments = new Map<string, { amount: number; at: Date; text: string; customer: string }>();
  const byCustomer = new Map<string, { payments: { at: Date; amount: number }[]; refunds: { at: Date; amount: number }[] }>();
  const bucket = (c: string) => {
    let b = byCustomer.get(c);
    if (!b) byCustomer.set(c, (b = { payments: [], refunds: [] }));
    return b;
  };
  const refundRows: string[][] = [];
  for (const r of rows.slice(1)) {
    const type = (r[iType] ?? "").toLowerCase();
    const status = (r[iStatus] ?? "completed").toLowerCase();
    const gross = money(r[iGross]);
    if (/refund/.test(type) && gross < 0) refundRows.push(r);
    else if (gross > 0 && /payment/.test(type) && status !== "denied") {
      const customer = ((iFrom >= 0 && r[iFrom]) || (iName >= 0 && r[iName]) || "unknown").trim().toLowerCase();
      const at = when(r[iDate], r[iTime] ?? "");
      payments.set(r[iId], { amount: gross, at, text: textCols.map((i) => (r[i] ?? "").trim()).filter(Boolean).join(" · "), customer });
      bucket(customer).payments.push({ at, amount: gross });
    }
  }
  if (refundRows.length === 0) throw new Error("No refunds found in this export (refund rows have a negative Gross).");

  const entries: AuditEntry[] = [];
  const captures = new Map<string, CaptureFacts>();
  let matched = 0;
  const exposure: Exposure = {
    hasTextColumns: textCols.length > 0,
    payments: payments.size,
    paymentsWithText: [...payments.values()].filter((p) => p.text).length,
    refundsOnTextOrders: 0,
    dollarsOnTextOrders: 0,
    refundDollars: 0,
    instructionLike: [],
  };
  for (const r of refundRows.slice(0, 5000)) {
    const ref = iRef >= 0 ? r[iRef] : "";
    const original = ref ? payments.get(ref) : undefined;
    if (original) matched++;
    const refundAmount = Math.abs(money(r[iGross]));
    const customer = (original?.customer ?? ((iTo >= 0 && r[iTo]) || (iName >= 0 && r[iName]) || "unknown")).trim().toLowerCase();
    bucket(customer).refunds.push({ at: when(r[iDate], iTime >= 0 ? r[iTime] : ""), amount: refundAmount });
    exposure.refundDollars += refundAmount;
    if (original?.text) {
      exposure.refundsOnTextOrders++;
      exposure.dollarsOnTextOrders += refundAmount;
    }
    const id = randomUUID();
    entries.push({
      id,
      at: when(r[iDate], iTime >= 0 ? r[iTime] : ""),
      mode: "protected",
      agentId: "imported",
      customerId: customer,
      tool: "create_refund",
      args: {},
      captureId: ref || `refund-${id}`,
      effectiveAmount: Math.abs(money(r[iGross])),
      decision: "allow",
      decidedBy: "none",
      hits: [],
      spans: [],
      status: "executed",
      requestId: id,
      webhookConfirmed: true,
      latencyMs: 0,
    });
    if (original && ref) captures.set(ref, { amount: original.amount, capturedAt: original.at });
  }
  // Any payment, refunded or not: each is an order an agent could be asked about tomorrow.
  for (const [txn, p] of payments) {
    const spans = p.text ? findInstructionSpans({ origin: "note", text: p.text }) : [];
    if (spans.length) exposure.instructionLike.push({ txn, amount: p.amount, text: p.text.slice(0, 200), flagged: spans[0].text.slice(0, 120) });
  }
  exposure.refundDollars = Math.round(exposure.refundDollars * 100) / 100;
  exposure.dollarsOnTextOrders = Math.round(exposure.dollarsOnTextOrders * 100) / 100;
  exposure.instructionLike = exposure.instructionLike.slice(0, 20);
  const statsAt: StatsAt = (customerId, at, windowDays) => {
    const b = byCustomer.get(customerId);
    const since = at.getTime() - windowDays * 86_400_000;
    const inWindow = (x: { at: Date }) => x.at.getTime() >= since && x.at.getTime() < at.getTime();
    const prior = b?.refunds.filter(inWindow) ?? [];
    return { paid: (b?.payments.filter(inWindow) ?? []).reduce((t, x) => t + x.amount, 0), refunded: prior.reduce((t, x) => t + x.amount, 0), refunds: prior.length };
  };
  const serialRefunders = [...byCustomer.entries()]
    .map(([customer, b]) => ({
      customer,
      payments: b.payments.length,
      paid: Math.round(b.payments.reduce((t, x) => t + x.amount, 0) * 100) / 100,
      refunds: b.refunds.length,
      refunded: Math.round(b.refunds.reduce((t, x) => t + x.amount, 0) * 100) / 100,
    }))
    .filter((c) => c.refunds >= 3 && c.paid > 0 && c.refunded / c.paid > 0.5)
    .sort((a, b) => b.refunded - a.refunded)
    .slice(0, 10);
  const currency = iCur >= 0 ? (refundRows[0]?.[iCur] ?? "USD").trim().toUpperCase() || "USD" : "USD";
  return { refunds: refundRows.length, matched, entries, captures, exposure, serialRefunders, statsAt, currency };
}

export function backtestCsv(
  policy: Policy,
  csv: string,
): BacktestReport & {
  source: { refunds: number; matched: number; notReplayed: string[] };
  exposure: Exposure;
  serialRefunders: SerialRefunder[];
  currency: string;
  suggestion?: CapSuggestion;
} {
  const h = importActivityCsv(csv);
  const report = backtest(policy, h.entries, h.captures, h.statsAt, h.currency);
  return {
    ...report,
    currency: h.currency,
    suggestion: suggestCap(policy, h, report),
    exposure: h.exposure,
    serialRefunders: h.serialRefunders,
    source: {
      refunds: h.refunds,
      matched: h.matched,
      notReplayed: ["who asked (a CSV has no chat)", "customer confirmation (assumed given)", "untrusted text in notes", "order ownership (assumed correct)"],
    },
  };
}

/** "Set my limit from my own history": the refund size most of this merchant's refunds stay under. */
export interface CapSuggestion {
  ruleId: string;
  current: number;
  /** 90th percentile of the merchant's refunds, rounded up to a round number. */
  suggested: number;
  /** People-reviews per day now and with the suggested limit. */
  reviewsPerDay: { current: number; suggested: number };
  /** Refunds and money that would still reach the merchant with the suggested limit. */
  reviewed: { count: number; amount: number };
}

function suggestCap(policy: Policy, h: ImportedHistory, now: BacktestReport): CapSuggestion | undefined {
  const cap = policy.rules.find((r): r is Extract<Policy["rules"][number], { kind: "max_amount" }> => r.kind === "max_amount" && r.tool === "create_refund");
  if (!cap || h.entries.length < 20) return undefined;
  const sizes = h.entries.map((e) => e.effectiveAmount).sort((a, b) => a - b);
  const p90 = sizes[Math.floor(sizes.length * 0.9)];
  const step = p90 >= 500 ? 100 : p90 >= 100 ? 25 : 10;
  const suggested = Math.ceil(p90 / step) * step;
  if (suggested <= cap.max) return undefined;
  const draft: Policy = { ...policy, rules: policy.rules.map((r) => (r.id === cap.id ? { ...cap, max: suggested } : r)) };
  const next = backtest(draft, h.entries, h.captures, h.statsAt, h.currency);
  const perDay = (n: number, days: number) => Math.round((10 * n) / days) / 10;
  return {
    ruleId: cap.id,
    current: cap.max,
    suggested,
    reviewsPerDay: { current: perDay(now.newlyHeld.count, now.days), suggested: perDay(next.newlyHeld.count, next.days) },
    reviewed: next.newlyHeld,
  };
}
