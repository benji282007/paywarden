// Durable store for a real deployment: Node's built-in SQLite (no dependency, one file).
// Every write goes straight to disk, so held refunds, refund totals, approvals and spent
// mandates survive a restart. The hosted demo keeps per-visitor in-memory shops instead.

import { DatabaseSync } from "node:sqlite";
import type { Policy } from "../policy/types.js";
import type { AuditEntry, Customer, Dispute, LedgerEntry, Store, WebhookEvent } from "./types.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const DATE_KEYS = new Set(["at", "capturedAt", "receivedAt", "createdAt"]);
const revive = (_k: string, v: unknown) => (DATE_KEYS.has(_k) && typeof v === "string" ? new Date(v) : v);
const parse = <T>(s: unknown): T => JSON.parse(String(s), revive) as T;

export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(
    file: string,
    private readonly initialPolicy: Policy,
  ) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger (capture_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, refund_id TEXT, doc TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_refund ON audit (refund_id);
      CREATE TABLE IF NOT EXISTS webhooks (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS disputes (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spent_mandates (id TEXT PRIMARY KEY, at TEXT NOT NULL);
    `);
  }

  async getPolicy(): Promise<Policy> {
    const row = this.db.prepare("SELECT v FROM kv WHERE k = 'policy'").get() as { v: string } | undefined;
    return row ? parse<Policy>(row.v) : structuredClone(this.initialPolicy);
  }
  async setPolicy(p: Policy) {
    this.db.prepare("INSERT INTO kv (k, v) VALUES ('policy', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(p));
  }

  async upsertCustomer(c: Customer) {
    this.db.prepare("INSERT INTO customers (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc").run(c.id, JSON.stringify(c));
  }
  async listCustomers() {
    return (this.db.prepare("SELECT doc FROM customers ORDER BY rowid").all() as { doc: string }[]).map((r) => parse<Customer>(r.doc));
  }

  async addLedger(e: LedgerEntry) {
    this.db.prepare("INSERT INTO ledger (capture_id, customer_id, doc) VALUES (?, ?, ?) ON CONFLICT(capture_id) DO UPDATE SET doc = excluded.doc").run(e.captureId, e.customerId, JSON.stringify(e));
  }
  async getLedger(captureId: string) {
    const row = this.db.prepare("SELECT doc FROM ledger WHERE capture_id = ?").get(captureId) as { doc: string } | undefined;
    return row ? parse<LedgerEntry>(row.doc) : undefined;
  }
  async listLedger(customerId?: string) {
    const rows = (customerId
      ? this.db.prepare("SELECT doc FROM ledger WHERE customer_id = ? ORDER BY rowid").all(customerId)
      : this.db.prepare("SELECT doc FROM ledger ORDER BY rowid").all()) as { doc: string }[];
    return rows.map((r) => parse<LedgerEntry>(r.doc));
  }
  async addRefunded(captureId: string, amount: number) {
    const e = await this.getLedger(captureId);
    if (e) await this.addLedger({ ...e, refunded: round2(e.refunded + amount) });
  }
  async setRefunded(captureId: string, amount: number) {
    const e = await this.getLedger(captureId);
    if (e) await this.addLedger({ ...e, refunded: round2(amount) });
  }

  async addAudit(e: AuditEntry) {
    this.db.prepare("INSERT INTO audit (id, refund_id, doc) VALUES (?, ?, ?)").run(e.id, e.paypal?.refundId ?? null, JSON.stringify(e));
  }
  async updateAudit(id: string, patch: Partial<AuditEntry>) {
    const e = await this.getAudit(id);
    if (!e) throw new Error(`audit entry ${id} not found`);
    const next = { ...e, ...patch };
    this.db.prepare("UPDATE audit SET doc = ?, refund_id = ? WHERE id = ?").run(JSON.stringify(next), next.paypal?.refundId ?? null, id);
    return next;
  }
  async getAudit(id: string) {
    const row = this.db.prepare("SELECT doc FROM audit WHERE id = ?").get(id) as { doc: string } | undefined;
    return row ? parse<AuditEntry>(row.doc) : undefined;
  }
  async listAudit() {
    return (this.db.prepare("SELECT doc FROM audit ORDER BY seq DESC LIMIT 5000").all() as { doc: string }[]).map((r) => parse<AuditEntry>(r.doc));
  }
  async findAuditByRefundId(refundId: string) {
    const row = this.db.prepare("SELECT doc FROM audit WHERE refund_id = ?").get(refundId) as { doc: string } | undefined;
    return row ? parse<AuditEntry>(row.doc) : undefined;
  }

  async addDispute(d: Dispute) {
    this.db.prepare("INSERT INTO disputes (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc").run(d.disputeId, JSON.stringify(d));
  }
  async getDispute(id: string) {
    const row = this.db.prepare("SELECT doc FROM disputes WHERE id = ?").get(id) as { doc: string } | undefined;
    return row ? parse<Dispute>(row.doc) : undefined;
  }
  async setDisputeStatus(id: string, status: Dispute["status"]) {
    const d = await this.getDispute(id);
    if (d) await this.addDispute({ ...d, status });
  }

  async addWebhook(e: WebhookEvent) {
    const r = this.db.prepare("INSERT OR IGNORE INTO webhooks (id, doc) VALUES (?, ?)").run(e.id, JSON.stringify(e));
    return Number(r.changes) > 0;
  }
  async listWebhooks() {
    return (this.db.prepare("SELECT doc FROM webhooks ORDER BY seq DESC LIMIT 2000").all() as { doc: string }[]).map((r) => parse<WebhookEvent>(r.doc));
  }

  /** Spent mandate ids, so a confirmation can't be replayed after a restart. */
  spentMandates(): string[] {
    return (this.db.prepare("SELECT id FROM spent_mandates").all() as { id: string }[]).map((r) => r.id);
  }
  markMandateSpent(id: string) {
    this.db.prepare("INSERT OR IGNORE INTO spent_mandates (id, at) VALUES (?, ?)").run(id, new Date().toISOString());
  }

  async reset() {
    this.db.exec("DELETE FROM kv; DELETE FROM customers; DELETE FROM ledger; DELETE FROM audit; DELETE FROM webhooks; DELETE FROM disputes;");
  }

  close() {
    this.db.close();
  }
}
