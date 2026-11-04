import { createHash, randomUUID } from "node:crypto";
import { evaluate, isMoneyTool, parseAmount, paysBack } from "../policy/evaluate.js";
import type { Decision, EvalContext, ExecutedCall, PolicyResult, ToolCall } from "../policy/types.js";
import { analyzeProvenance, type ProvenanceResult, type TrustedSource, type UntrustedSource } from "../provenance/analyze.js";
import { KeyedLock } from "./lock.js";
import { MandateBook, consentProof, mandateRequestId } from "../mandate/mandate.js";
import { customerAsked, customerRequest } from "../provenance/intent.js";
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
  /** Unguarded demo only: send the agent's refunds straight to PayPal, for real, with no checks. */
  live?: boolean;
}

export interface JudgeVerdict {
  verdict: Decision;
  reason: string;
  model: string;
}

/** Optional LLM check. It can only make a decision stricter; see Guard.decide. */
export interface Judge {
  /** Cheap pre-check; when false the model isn't called and the refund isn't delayed. */
  shouldReview?(session: Session): boolean;
  review(call: ToolCall, session: Session, policy: PolicyResult): Promise<JudgeVerdict>;
}

/** Sends an approved money-moving call to PayPal. */
export type Executor = (call: ToolCall, requestId: string, extra?: { customId?: string }) => Promise<{ refundId?: string; status?: string }>;

const PROVENANCE_KINDS = new Set(["untrusted_influence", "customer_asked", "request_match", "confirmed"]);

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
  private readonly lock = new KeyedLock();
  /** Signed customer confirmations this merchant has accepted (see mandate/mandate.ts). */
  mandates = new MandateBook();

  constructor(
    private readonly store: Store,
    private readonly paypal: PayPalClient,
    private readonly judge?: Judge,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Refunds go straight to PayPal with an idempotency key; other money tools need a forwarder. */
  executor: Executor = async (call, requestId, extra) => {
    if (call.tool === "accept_dispute_claim") {
      const d = await this.store.getDispute(String(call.args.dispute_id));
      if (!d) throw new Error(`Unknown dispute ${String(call.args.dispute_id)}`);
      if (!d.simulated) {
        if (!this.paypal.acceptDisputeClaim) throw new Error("This PayPal client can't accept dispute claims");
        await this.paypal.acceptDisputeClaim(d.disputeId, String(call.args.note ?? "Accepted by the merchant"), requestId);
      }
      await this.store.setDisputeStatus(d.disputeId, "RESOLVED");
      return { status: "RESOLVED" };
    }
    if (call.tool !== "create_refund") throw new Error(`No executor configured for ${call.tool}`);
    // Same parser the policy priced the call with; an unreadable amount never reaches PayPal.
    const amount = parseAmount(call.args.amount);
    if (!amount.ok) throw new Error(`Refusing to send unreadable amount: ${amount.reason}`);
    const r = await this.paypal.refundCapture({
      captureId: String(call.args.capture_id),
      amount: amount.value,
      currency: amount.currency,
      noteToPayer: typeof call.args.note_to_payer === "string" ? call.args.note_to_payer : undefined,
      customId: extra?.customId,
      requestId,
    });
    return { refundId: r.refundId, status: r.status };
  };

  /** The signed confirmation, if any, that covers this exact call. */
  private mandateFor(call: ToolCall, session: Session, ledger: { captureId: string; amount: number; refunded: number; payerId?: string }[]) {
    if (call.tool !== "create_refund" || typeof call.args.capture_id !== "string") return undefined;
    const entry = ledger.find((e) => e.captureId === call.args.capture_id);
    const parsed = parseAmount(call.args.amount);
    if (!entry || !parsed.ok) return undefined;
    const amount = parsed.value ?? Math.round((entry.amount - entry.refunded) * 100) / 100;
    const m = this.mandates.covering(session.customerId, entry.captureId, amount, this.now(), entry.payerId);
    return m && { id: m.id, captureId: m.captureId, remaining: m.remaining };
  }

  private async context(session: Session, untrustedInfluence?: { reason: string }[], call?: ToolCall): Promise<EvalContext> {
    const tool = call?.tool;
    const ledger = await this.store.listLedger();
    const audit = await this.store.listAudit();
    const history: ExecutedCall[] = audit
      .filter((a) => !a.sample && (a.status === "executed" || a.status === "approved"))
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
      // Filing a dispute is the buyer's own claim, so "did they ask" only applies to agent-initiated money moves.
      customerAsked: tool && isMoneyTool(tool) && tool !== "accept_dispute_claim" ? customerAsked(tool, session.trusted) : undefined,
      requested: customerRequest(session.trusted, ledger.filter((e) => e.customerId === session.customerId)),
      mandate: call ? this.mandateFor(call, session, ledger) : undefined,
      customerStats: (windowDays) => {
        const since = this.now().getTime() - windowDays * 86_400_000;
        const mine = ledger.filter((e) => e.customerId === session.customerId && e.capturedAt.getTime() >= since);
        return {
          paid: mine.reduce((t, e) => t + e.amount, 0),
          refunded: mine.reduce((t, e) => t + e.refunded, 0),
          refunds: audit.filter((a) => !a.sample && a.customerId === session.customerId && (a.status === "executed" || a.status === "approved") && a.at.getTime() >= since).length + mine.filter((e) => e.refunded > 0 && !audit.some((a) => a.captureId === e.captureId)).length,
        };
      },
    };
  }

  /**
   * Bring the ledger's refunded total up to what PayPal reports, so refunds made
   * outside Paywarden (dashboard, another tool) count before we decide. Fails closed.
   */
  private async reconcile(original: ToolCall): Promise<string | undefined> {
    const call = await this.priced(original);
    if (!paysBack(call.tool) || typeof call.args.capture_id !== "string") return undefined;
    const entry = await this.store.getLedger(call.args.capture_id);
    if (!entry || !this.paypal.getRefundedTotal) return undefined;
    try {
      const live = await this.paypal.getRefundedTotal(entry.orderId, entry.captureId);
      if (live > entry.refunded) await this.store.setRefunded(entry.captureId, live);
      return undefined;
    } catch (err) {
      return `Couldn't confirm the payment's live refund state with PayPal (${(err as Error).message})`;
    }
  }

  /**
   * Accepting a dispute claim pays the disputed amount back from the disputed capture, so it is
   * checked as exactly that payout: ownership, over-refund (a refund AND an accepted dispute on the
   * same payment would pay twice), limits, order age, repeat refunders.
   */
  async priced(call: ToolCall): Promise<ToolCall> {
    if (call.tool !== "accept_dispute_claim") return call;
    const d = typeof call.args.dispute_id === "string" ? await this.store.getDispute(call.args.dispute_id) : undefined;
    if (!d) return { tool: call.tool, args: { capture_id: `unknown-dispute:${String(call.args.dispute_id)}` } };
    return { tool: call.tool, args: { capture_id: d.captureId, amount: { currency_code: d.currency, value: d.amount.toFixed(2) }, dispute_id: d.disputeId } };
  }

  /** Deterministic layers only: fast, no network except the PayPal reconcile. */
  private async evaluateNow(original: ToolCall, session: Session, prov: ProvenanceResult) {
    const call = await this.priced(original);
    const policy = await this.store.getPolicy();
    const ctx = await this.context(session, prov.tainted ? prov.reasons.map((reason) => ({ reason })) : undefined, call);
    const result = evaluate(policy, call, ctx);
    // "Who asked" rules: the untrusted-text, customer-asked, asked-for-what and signed-confirmation checks.
    const provenanceRuleIds = new Set(policy.rules.filter((r) => PROVENANCE_KINDS.has(r.kind)).map((r) => r.id));
    const deciding = result.hits.filter((h) => h.action === result.decision);
    const decidedBy: AuditEntry["decidedBy"] =
      deciding.length === 0 ? "none" : deciding.every((h) => provenanceRuleIds.has(h.ruleId)) ? "provenance" : "policy";
    // Held only because nobody has confirmed it yet: the customer's own tap can release it.
    const confirmable =
      result.decision === "hold" && call.tool === "create_refund" && policy.rules.some((r) => r.kind === "confirmed") && deciding.every((h) => provenanceRuleIds.has(h.ruleId));
    return { result, decidedBy, mandate: ctx.mandate, confirmable };
  }

  /** The AI check runs outside the lock (it can take a minute) and only ever tightens. */
  private async consultJudge(call: ToolCall, session: Session, prov: ProvenanceResult): Promise<JudgeVerdict | undefined> {
    if (!this.judge || session.untrusted.length === 0 || !(this.judge.shouldReview?.(session) ?? true)) return undefined;
    const pre = await this.evaluateNow(call, session, prov);
    // A signed confirmation already settles who asked; there is nothing for the AI to second-guess.
    if (pre.result.decision !== "allow" || pre.mandate) return undefined;
    try {
      return await this.judge.review(call, session, pre.result);
    } catch (err) {
      // A judge outage must fail safe: hold rather than silently allow.
      return { verdict: "hold", reason: `AI check unavailable: ${(err as Error).message.slice(0, 120)}`, model: "none" };
    }
  }

  /** Full decision without executing; used by the policy test suite. */
  async decide(call: ToolCall, session: Session) {
    const prov = analyzeProvenance(call, session.untrusted, session.trusted);
    const judge = await this.consultJudge(call, session, prov);
    const { result, decidedBy } = await this.evaluateNow(call, session, prov);
    return this.combine(result, decidedBy, prov, judge);
  }

  private combine(result: PolicyResult, decidedBy: AuditEntry["decidedBy"], prov: ProvenanceResult, judge?: JudgeVerdict) {
    let decision = result.decision;
    let by = decidedBy;
    if (judge) {
      const tightened = stricter(decision, judge.verdict);
      if (tightened !== decision) {
        decision = tightened;
        by = "judge";
      }
    }
    return { result, prov, decision, decidedBy: by, judge };
  }

  async handle(call: ToolCall, session: Session): Promise<AuditEntry> {
    const started = performance.now();
    if (!isMoneyTool(call.tool)) throw new Error(`${call.tool} is read-only; forward it without guarding`);

    const requestId = requestIdFor(call, session);
    const pricedCall = await this.priced(call);
    const captureId = typeof pricedCall.args.capture_id === "string" ? pricedCall.args.capture_id : undefined;
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

    if (session.mode === "unprotected" && session.live) {
      // What an unguarded agent does: whatever it asks for goes straight to PayPal.
      const ledger = captureId ? await this.store.getLedger(captureId) : undefined;
      const amount = parseAmount(call.args.amount);
      const entry: AuditEntry = {
        ...base,
        effectiveAmount: amount.ok && amount.value != null ? amount.value : ledger ? ledger.amount - ledger.refunded : 0,
        decision: "allow",
        decidedBy: "none",
        hits: [],
        spans: [],
        status: "executed",
        latencyMs: 0,
      };
      await this.store.addAudit(entry);
      return this.execute(entry, call);
    }

    if (session.mode === "unprotected") {
      // Dry run: record what an unguarded agent would have done. No money moves.
      const ledger = captureId ? await this.store.getLedger(captureId) : undefined;
      const amount = parseAmount(call.args.amount);
      const entry: AuditEntry = {
        ...base,
        effectiveAmount: amount.ok && amount.value != null ? amount.value : ledger ? ledger.amount - ledger.refunded : 0,
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

    const prov = analyzeProvenance(call, session.untrusted, session.trusted);
    const judge = await this.consultJudge(call, session, prov);

    // Everything that reads or changes money state happens under one lock per agent,
    // so parallel calls can't all pass a velocity or balance check before any is recorded.
    return this.lock.run(session.agentId, async () => {
      const reconcileProblem = await this.reconcile(call);
      const { result, decidedBy, mandate, confirmable } = await this.evaluateNow(call, session, prov);
      if (reconcileProblem) result.hits.push({ ruleId: "builtin.reconcile", action: "hold", reason: reconcileProblem, source: "Refunds wait if PayPal's state can't be checked." });
      const combined = this.combine(result, decidedBy, prov, judge);
      if (reconcileProblem && combined.decision === "allow") {
        combined.decision = "hold";
        combined.decidedBy = "policy";
      }
      const entry: AuditEntry = {
        ...base,
        effectiveAmount: result.effectiveAmount,
        decision: combined.decision,
        decidedBy: combined.decidedBy,
        hits: result.hits,
        spans: prov.spans,
        // Everything customer-written the agent read, highlighted or not, so the merchant sees the evidence.
        sources: combined.decision === "allow" ? session.untrusted.filter((u) => prov.spans.some((s) => s.origin === u.origin)) : session.untrusted,
        judge,
        status: combined.decision === "allow" ? "executed" : combined.decision === "hold" ? "held" : "blocked",
        latencyMs: 0,
        context: combined.decision === "hold" ? { untrusted: session.untrusted, trusted: session.trusted } : undefined,
        mandateId: mandate?.id,
        mandateToken: mandate ? this.mandates.tokenFor(mandate.id) : undefined,
        // A mandate's refund carries an id derived from the mandate: one mandate, at most one PayPal payout.
        ...(mandate ? { requestId: mandateRequestId(mandate.id) } : {}),
        confirmable: combined.decision === "hold" && confirmable && !reconcileProblem ? true : undefined,
      };
      entry.latencyMs = Math.round(performance.now() - started);
      await this.store.addAudit(entry);
      if (combined.decision === "allow") return this.execute(entry, call);
      return entry;
    });
  }

  private async execute(entry: AuditEntry, call: ToolCall): Promise<AuditEntry> {
    try {
      const token = entry.mandateId ? this.mandates.tokenFor(entry.mandateId) : undefined;
      const payer = entry.mandateId ? this.mandates.get(entry.mandateId)?.payer?.paypalPayerId : undefined;
      const r = await this.executor(call, entry.requestId, { customId: entry.mandateId && token ? consentProof(entry.mandateId, token, payer) : undefined });
      if (entry.captureId) await this.store.addRefunded(entry.captureId, entry.effectiveAmount);
      if (entry.mandateId) this.mandates.spend(entry.mandateId);
      return this.store.updateAudit(entry.id, { paypal: { refundId: r.refundId, status: r.status } });
    } catch (err) {
      return this.store.updateAudit(entry.id, { status: "failed", paypal: { error: (err as Error).message } });
    }
  }

  /**
   * One-tap approval. Ledger state may have changed while the call waited (another
   * refund landed), so blocking rules are re-checked; hold-level rules are what the
   * human is overriding. Runs under the agent's lock, so two approvals can't both pay.
   */
  async approve(id: string, by: string): Promise<AuditEntry> {
    const first = await this.store.getAudit(id);
    if (!first || first.status !== "held") throw new Error(`No held call ${id}`);
    return this.lock.run(first.agentId, async () => {
      const entry = await this.store.getAudit(id);
      if (!entry || entry.status !== "held") throw new Error(`No held call ${id}`);
      const call = { tool: entry.tool, args: entry.args };
      const reconcileProblem = await this.reconcile(call);
      if (reconcileProblem) throw new Error(reconcileProblem);
      const policy = await this.store.getPolicy();
      const ctx = await this.context({ mode: "protected", agentId: entry.agentId, customerId: entry.customerId, untrusted: [], trusted: [] });
      ctx.mandate = undefined;
      const recheck = evaluate(policy, await this.priced(call), ctx);
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
      return this.execute((await this.store.getAudit(id))!, call);
    });
  }

  /**
   * The customer tapped "Yes, refund this" in the merchant's app, which signed a mandate
   * for exactly this capture and amount. Re-evaluate everything with it under the lock:
   * every limit still applies; only the "who asked" questions are settled by the signature.
   */
  async confirm(id: string, token: string): Promise<AuditEntry> {
    const first = await this.store.getAudit(id);
    if (!first || first.status !== "held") throw new Error(`No held call ${id}`);
    const accepted = this.mandates.accept(token, first.customerId, this.now());
    if (!accepted.ok) throw new Error(`Confirmation rejected: ${accepted.reason}`);
    const paidBy = first.captureId ? (await this.store.getLedger(first.captureId))?.payerId : undefined;
    if (accepted.mandate.payer && paidBy && accepted.mandate.payer.paypalPayerId !== paidBy) {
      throw new Error("Confirmation rejected: signed in to PayPal as a different account than the one that paid for this order");
    }
    return this.lock.run(first.agentId, async () => {
      const entry = await this.store.getAudit(id);
      if (!entry || entry.status !== "held") throw new Error(`No held call ${id}`);
      const call = { tool: entry.tool, args: entry.args };
      const reconcileProblem = await this.reconcile(call);
      if (reconcileProblem) throw new Error(reconcileProblem);
      const policy = await this.store.getPolicy();
      const session: Session = { mode: "protected", agentId: entry.agentId, customerId: entry.customerId, untrusted: entry.context?.untrusted ?? [], trusted: entry.context?.trusted ?? [] };
      const ctx = await this.context(session, undefined, call);
      if (!ctx.mandate || ctx.mandate.id !== accepted.mandate.id) throw new Error("That confirmation doesn't cover this refund (different order, or a smaller amount)");
      const recheck = evaluate(policy, call, ctx);
      if (recheck.decision === "block") {
        return this.store.updateAudit(id, { status: "blocked", decision: "block", decidedBy: "policy", confirmable: undefined, hits: [...entry.hits, ...recheck.hits.filter((h) => h.action === "block").map((h) => ({ ...h, reason: `On confirmation: ${h.reason}` }))] });
      }
      if (recheck.decision === "hold") {
        // Confirmed by the customer, but a merchant limit still applies: now it's the merchant's call.
        return this.store.updateAudit(id, { confirmable: undefined, mandateId: ctx.mandate.id, hits: recheck.hits });
      }
      await this.store.updateAudit(id, {
        status: "approved",
        confirmable: undefined,
        mandateId: ctx.mandate.id,
        mandateToken: this.mandates.tokenFor(ctx.mandate.id),
        requestId: mandateRequestId(ctx.mandate.id),
        approval: { by: accepted.mandate.payer ? `customer (signed in to PayPal, payer ${accepted.mandate.payer.paypalPayerId}${paidBy ? ", the account that paid" : ""})` : "customer (signed confirmation)", at: this.now() },
      });
      return this.execute((await this.store.getAudit(id))!, call);
    });
  }

  async reject(id: string, by: string): Promise<AuditEntry> {
    const entry = await this.store.getAudit(id);
    if (!entry || entry.status !== "held") throw new Error(`No held call ${id}`);
    return this.store.updateAudit(id, { status: "rejected", approval: { by, at: this.now() } });
  }
}
