import type { Policy } from "../policy/types.js";
import type { AuditEntry, Customer, LedgerEntry, Store, WebhookEvent } from "./types.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

export class MemoryStore implements Store {
  private policy: Policy;
  private customers = new Map<string, Customer>();
  private ledger = new Map<string, LedgerEntry>();
  private audit: AuditEntry[] = [];
  private webhooks = new Map<string, WebhookEvent>();

  constructor(private readonly initialPolicy: Policy) {
    this.policy = structuredClone(initialPolicy);
  }

  async getPolicy() {
    return this.policy;
  }
  async setPolicy(p: Policy) {
    this.policy = p;
  }

  async upsertCustomer(c: Customer) {
    this.customers.set(c.id, c);
  }
  async listCustomers() {
    return [...this.customers.values()];
  }

  async addLedger(e: LedgerEntry) {
    this.ledger.set(e.captureId, e);
  }
  async getLedger(captureId: string) {
    return this.ledger.get(captureId);
  }
  async listLedger(customerId?: string) {
    return [...this.ledger.values()].filter((e) => !customerId || e.customerId === customerId);
  }
  async addRefunded(captureId: string, amount: number) {
    const e = this.ledger.get(captureId);
    if (e) e.refunded = round2(e.refunded + amount);
  }

  async addAudit(e: AuditEntry) {
    this.audit.push(e);
  }
  async updateAudit(id: string, patch: Partial<AuditEntry>) {
    const e = this.audit.find((a) => a.id === id);
    if (!e) throw new Error(`audit entry ${id} not found`);
    Object.assign(e, patch);
    return e;
  }
  async getAudit(id: string) {
    return this.audit.find((a) => a.id === id);
  }
  async listAudit() {
    return [...this.audit].reverse();
  }
  async findAuditByRefundId(refundId: string) {
    return this.audit.find((a) => a.paypal?.refundId === refundId);
  }

  async addWebhook(e: WebhookEvent) {
    if (this.webhooks.has(e.id)) return false;
    this.webhooks.set(e.id, e);
    return true;
  }
  async listWebhooks() {
    return [...this.webhooks.values()].reverse();
  }

  async reset() {
    this.policy = structuredClone(this.initialPolicy);
    this.customers.clear();
    this.ledger.clear();
    this.audit = [];
    this.webhooks.clear();
  }
}
