// Types mirror the server's JSON. Kept by hand: the API surface is small.

export type Decision = "allow" | "hold" | "block";
export type AuditStatus = "executed" | "held" | "approved" | "rejected" | "blocked" | "failed" | "simulated";

export interface RuleHit {
  ruleId: string;
  action: "hold" | "block";
  reason: string;
  source: string;
}

export interface Span {
  origin: string;
  start: number;
  end: number;
  text: string;
  kind: "instruction" | "argument";
  reason: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  /** Generated demo history: shown in the grid, excluded from totals. */
  sample?: boolean;
  mode: "protected" | "unprotected";
  customerId: string;
  tool: string;
  args: Record<string, unknown>;
  captureId?: string;
  effectiveAmount: number;
  decision: Decision;
  decidedBy: "policy" | "provenance" | "judge" | "none";
  hits: RuleHit[];
  spans: Span[];
  sources?: { origin: string; text: string }[];
  judge?: { verdict: Decision; reason: string; model: string };
  status: AuditStatus;
  requestId: string;
  paypal?: { refundId?: string; status?: string; error?: string };
  webhookConfirmed: boolean;
  latencyMs: number;
  approval?: { by: string; at: string };
}

export interface Rule {
  id: string;
  kind: string;
  source: string;
  action: "hold" | "block";
  [param: string]: unknown;
}

export interface Policy {
  version: number;
  rules: Rule[];
}

export interface Customer {
  id: string;
  name: string;
  email: string;
}

export interface LedgerEntry {
  captureId: string;
  orderId: string;
  customerId: string;
  description: string;
  note: string;
  amount: number;
  refunded: number;
}

export interface CaseResult {
  id: string;
  kind: "attack" | "genuine";
  title: string;
  decision: Decision;
  decidedBy: string;
  reason: string;
  pass: boolean;
  micros: number;
}

export interface SuiteReport {
  policyVersion: number;
  results: CaseResult[];
  attacks: { total: number; stopped: number };
  genuine: { total: number; correct: number; falseStops: number };
  p50Micros: number;
}

/** Fetch JSON with errors a person can read: cold starts, rate limits and server errors. */
export async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // An HTML error page: on the free host this is almost always the server waking up.
    throw new Error(res.status >= 500 ? "The free server is waking up. Give it ~30 seconds and try again." : `Unexpected response (${res.status}).`);
  }
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status}).`);
  return json as T;
}

export const api = {
  status: () =>
    req<{ paypal: "sandbox" | "offline-simulation"; seedError: string | null; ai: { reasoning: string | null; chat: string | null } }>("GET", "/api/status"),
  scenario: (name: string, mode: "protected" | "unprotected") =>
    req<{ steps: { actor: "customer" | "agent" | "paywarden"; text: string }[] }>("POST", "/api/demo/scenario", { name, mode }),
  compileRule: (english: string, existingIds: string[]) =>
    req<{ ok: true; rule: Rule; explanation: string } | { ok: false; explanation: string }>("POST", "/api/policy/compile", { english, existingIds }),
  audit: () => req<AuditEntry[]>("GET", "/api/audit"),
  customers: () => req<Customer[]>("GET", "/api/customers"),
  sampleCustomers: () => req<{ id: string; name: string }[]>("GET", "/api/sample-customers"),
  ledger: () => req<LedgerEntry[]>("GET", "/api/ledger"),
  policy: () => req<Policy>("GET", "/api/policy"),
  savePolicy: (p: Policy) => req<Policy>("PUT", "/api/policy", p),
  testPolicy: (p?: Policy) => req<SuiteReport>("POST", "/api/policy/test", p ? { policy: p } : {}),
  approve: (id: string) => req<AuditEntry>("POST", `/api/approvals/${id}/approve`),
  reject: (id: string) => req<AuditEntry>("POST", `/api/approvals/${id}/reject`),
  reset: () => req<{ ok: true }>("POST", "/api/demo/reset"),
  guard: (body: unknown) => req<AuditEntry>("POST", "/api/guard", body),
};

export const usd = (n: number) => `$${n.toFixed(2)}`;
