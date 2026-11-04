// Backtest on a merchant's own PayPal history: parse PayPal's "Activity download" CSV
// (Reports > Activity download), pair each refund with its original payment through
// "Reference Txn ID", and replay the refunds under a draft policy. A CSV carries no chat,
// so the "who asked" and untrusted-text checks can't be replayed; the report says so.

import { randomUUID } from "node:crypto";
import type { AuditEntry } from "../store/types.js";
import { backtest, type BacktestReport, type CaptureFacts } from "./backtest.js";
import type { Policy } from "./types.js";

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

export interface ImportedHistory {
  refunds: number;
  matched: number;
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
  const iId = col("transaction id"), iRef = col("reference txn id");
  if ([iDate, iType, iGross, iId].some((i) => i < 0)) {
    throw new Error("This doesn't look like a PayPal activity export: expected Date, Type, Gross and Transaction ID columns.");
  }

  const payments = new Map<string, { amount: number; at: Date }>();
  const refundRows: string[][] = [];
  for (const r of rows.slice(1)) {
    const type = (r[iType] ?? "").toLowerCase();
    const status = (r[iStatus] ?? "completed").toLowerCase();
    const gross = money(r[iGross]);
    if (/refund/.test(type) && gross < 0) refundRows.push(r);
    else if (gross > 0 && /payment/.test(type) && status !== "denied") payments.set(r[iId], { amount: gross, at: when(r[iDate], r[iTime] ?? "") });
  }
  if (refundRows.length === 0) throw new Error("No refunds found in this export (refund rows have a negative Gross).");

  const entries: AuditEntry[] = [];
  const captures = new Map<string, CaptureFacts>();
  let matched = 0;
  for (const r of refundRows.slice(0, 5000)) {
    const ref = iRef >= 0 ? r[iRef] : "";
    const original = ref ? payments.get(ref) : undefined;
    if (original) matched++;
    const id = randomUUID();
    const customer = (iTo >= 0 && r[iTo]) || (iFrom >= 0 && r[iFrom]) || (iName >= 0 && r[iName]) || "unknown";
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
  return { refunds: refundRows.length, matched, entries, captures };
}

export function backtestCsv(policy: Policy, csv: string): BacktestReport & { source: { refunds: number; matched: number; notReplayed: string[] } } {
  const h = importActivityCsv(csv);
  return {
    ...backtest(policy, h.entries, h.captures),
    source: {
      refunds: h.refunds,
      matched: h.matched,
      notReplayed: ["who asked (a CSV has no chat)", "untrusted text in notes", "order ownership (assumed correct)"],
    },
  };
}
