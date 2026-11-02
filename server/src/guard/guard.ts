import { createHash, randomUUID } from "node:crypto";
import { evaluate, isMoneyTool } from "../policy/evaluate.js";
import type { Decision, EvalContext, ExecutedCall, PolicyResult, ToolCall } from "../policy/types.js";
import { analyzeProvenance, type TrustedSource, type UntrustedSource } from "../provenance/analyze.js";
import type { PayPalClient } from "../paypal/types.js";
import type { AuditEntry, Store } from "../store/types.js";

export interface Session {
  mode: "protected" | "unprotected";
  agentId: string;
  /** Authenticated by the merchant's app, never taken from the model or the chat. */
  customerId: string;
  conversationId?: string;
  /** Customer-writable PayPal data the agent read this turn (order notes, dispute messages). */
  untrusted: UntrustedSource[];
  /** What the customer actually said in chat. */
  trusted: TrustedSource[];
}

export interface JudgeVerdict {
  verdict: Decision;
  reason: string;
  model: string;
}

/** Optional LLM check. It can only make a decision stricter; see Guard.decide. */
export interface Judge {
  review(call: ToolCall, session: Session, policy: PolicyResult): Promise<JudgeVerdict>;
}

/** Sends an approved money-moving call to PayPal. */
export type Executor = (call: ToolCall, requestId: string) => Promise<{ refundId?: string; status?: string }>;

const RANK: Record<Decision, number> = { allow: 0, hold: 1, block: 2 };
const stricter = (a: Decision, b: Decision): Decision => (RANK[b] > RANK[a] ? b : a);

/** Same conversation + same tool + same args => same PayPal-Request-Id, so an agent retry can't move money twice. */
export function requestIdFor(call: ToolCall, session: Session): string {
  const canonical = JSON.stringify([session.conversationId ?? randomUUID(), call.tool, sortKeys(call.args)]);
  return `pw-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  }
  return v;
}

export class Guard {
  constructor(
    private readonly store: Store,
    private readonly paypal: PayPalClient,
    private readonly judge?: Judge,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Refunds go straight to PayPal with an idempotency key; other money tools need a forwarder. */
  executor: Executor = async (call, requestId) => {
    if (call.tool !== "create_refund") throw new Error(`No executor configured for ${call.tool}`);
    const amount = call.args.amount as { value?: string; currency_code?: string } | undefined;
    const r = await this.paypal.refundCapture({
      captureId: String(call.args.capture_id),
      amount: amount?.value != null ? Number(amount.value) : undefined,
      currency: amount?.currency_code,
      noteToPayer: typeof call.args.note_to_payer === "string" ? call.args.note_to_payer : undefined,
      requestId,
    });
    return { refundId: r.refundId, status: r.status };
  };

  private async context(session: Session, untrustedInfluence?: { reason: string }[]): Promise<EvalContext> {
    const ledger = await this.store.listLedger();
    const audit = await this.store.listAudit();
    const history: ExecutedCall[] = audit
      .filter((a) => a.status === "executed" || a.status === "approved")
      .map((a) => ({ tool: a.tool, customerId: a.customerId, captureId: a.captureId, amount: a.effectiveAmount, at: a.at }));
    const byId = new Map(ledger.map((e) => [e.captureId, e]));
    return {
      now: this.now(),
      customerId: session.customerId,
      agentId: session.agentId,
      getCapture: (id) => {
        const e = byId.get(id);
        return e && { captureId: e.captureId, customerId: e.customerId, amount: e.amount, refunded: e.refunded, currency: e.currency, capturedAt: e.capturedAt };
      },
      history,
      untrustedInfluence,
    };
  }

  /** Deterministic layers decide; the judge runs only for would-be-allowed calls that saw untrusted text, and can only tighten. */
  async decide(call: ToolCall, session: Session) {
    const policy = await this.store.getPolicy();
    const prov = analyzeProvenance(call, session.untrusted, session.trusted);
    const ctx = await this.context(session, prov.tainted ? prov.reasons.map((reason) => ({ reason })) : undefined);
    const result = evaluate(policy, call, ctx);

    const provenanceRuleIds = new Set(policy.rules.filter((r) => r.kind === "untrusted_influence").map((r) => r.id));
    const deciding = result.hits.filter((h) => h.action === result.decision);
    let decidedBy: AuditEntry["decidedBy"] =
      deciding.length === 0 ? "none" : deciding.every((h) => provenanceRuleIds.has(h.ruleId)) ? "provenance" : "policy";
    let decision = result.decision;

    let judge: JudgeVerdict | undefined;
    if (this.judge && decision === "allow" && session.untrusted.length > 0) {
      try {
        judge = await this.judge.review(call, session, result);
        const tightened = stricter(decision, judge.verdict);
        if (tightened !== decision) {
          decision = tightened;
          decidedBy = "judge";
        }
      } catch (err) {
        // A judge outage must fail safe: hold rather than silently allow.
        judge = { verdict: "hold", reason: `Judge unavailable: ${(err as Error).message}`, model: "none" };
        decision = "hold";
        decidedBy = "judge";
      }
    }
    return { result, prov, decision, decidedBy, judge };
  }

  async handle(call: ToolCall, session: Session): Promise<AuditEntry> {
    const started = performance.now();
    if (!isMoneyTool(call.tool)) throw new Error(`${call.tool} is read-only; forward it without guarding`);

    const requestId = requestIdFor(call, session);
    const captureId = typeof call.args.capture_id === "string" ? call.args.capture_id : undefined;
    const base = {
      id: randomUUID(),
      at: this.now(),
      mode: session.mode,
      agentId: session.agentId,
      customerId: session.customerId,
      conversationId: session.conversationId,
      tool: call.tool,
      args: call.args,
      captureId,
      requestId,
      webhookConfirmed: false,
    };

    if (session.mode === "unprotected") {
      // Dry run: record what an unguarded agent would have done. No money moves.
      const ledger = captureId ? await this.store.getLedger(captureId) : undefined;
      const amount = call.args.amount as { value?: string } | undefined;
      const entry: AuditEntry = {
        ...base,
        effectiveAmount: amount?.value != null ? Number(amount.value) : ledger ? ledger.amount - ledger.refunded : 0,
        decision: "allow",
        decidedBy: "none",
        hits: [],
        spans: [],
        status: "simulated",
        latencyMs: 0,
      };
      await this.store.addAudit(entry);
      return entry;
    }

    const { result, prov, decision, decidedBy, judge } = await this.decide(call, session);
    const entry: AuditEntry = {
      ...base,
      effectiveAmount: result.effectiveAmount,
      decision,
      decidedBy,
      hits: result.hits,
      spans: prov.spans,
      sources: session.untrusted.filter((u) => prov.spans.some((s) => s.origin === u.origin)),
      judge,
      status: decision === "allow" ? "executed" : decision === "hold" ? "held" : "blocked",
      latencyMs: 0,
      context: decision === "hold" ? { untrusted: session.untrusted, trusted: session.trusted } : undefined,
    };
    entry.latencyMs = Math.round(performance.now() - started);
    await this.store.addAudit(entry);

    if (decision === "allow") return this.execute(entry, call);
    return entry;
  }

  private async execute(entry: AuditEntry, call: ToolCall): Promise<AuditEntry> {
    try {
      const r = await this.executor(call, entry.requestId);
      if (entry.captureId) await this.store.addRefunded(entry.captureId, entry.effectiveAmount);
      return this.store.updateAudit(entry.id, { paypal: { refundId: r.refundId, status: r.status } });
    } catch (err) {
      return this.store.updateAudit(entry.id, { status: "failed", paypal: { error: (err as Error).message } });
    }
  }

  /**
   * One-tap approval. Ledger state may have changed while the call waited (another
   * refund landed), so blocking rules are re-checked; hold-level rules are what the
   * human is overriding.
   */
  async approve(id: string, by: string): Promise<AuditEntry> {
    const entry = await this.store.getAudit(id);
    if (!entry || entry.status !== "held") throw new Error(`No held call ${id}`);
    const policy = await this.store.getPolicy();
    const ctx = await this.context({ mode: "protected", agentId: entry.agentId, customerId: entry.customerId, untrusted: [], trusted: [] });
    const recheck = evaluate(policy, { tool: entry.tool, args: entry.args }, ctx);
    const blocking = recheck.hits.filter((h) => h.action === "block");
    if (blocking.length) {
      return this.store.updateAudit(id, {
        status: "blocked",
        decision: "block",
        decidedBy: "policy",
        hits: [...entry.hits, ...blocking.map((h) => ({ ...h, reason: `On approval: ${h.reason}` }))],
      });
    }
    await this.store.updateAudit(id, { status: "approved", approval: { by, at: this.now() } });
    return this.execute((await this.store.getAudit(id))!, { tool: entry.tool, args: entry.args });
  }

  async reject(id: string, by: string): Promise<AuditEntry> {
    const entry = await this.store.getAudit(id);
    if (!entry || entry.status !== "held") throw new Error(`No held call ${id}`);
    return this.store.updateAudit(id, { status: "rejected", approval: { by, at: this.now() } });
  }
}
