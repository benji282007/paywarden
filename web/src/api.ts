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
  conversationId?: string;
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
  mandateId?: string;
  /** Held only for the customer's own confirmation tap. */
  confirmable?: boolean;
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
    req<{ paypal: "sandbox" | "offline-simulation"; paypalLogin?: boolean; seedError: string | null; ai: { reasoning: string | null; chat: string | null } }>("GET", "/api/status"),
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
  /** The customer's "Yes, refund this" tap; the server plays the shop's backend and signs it. */
  confirm: (id: string) => req<AuditEntry>("POST", `/api/approvals/${id}/confirm`, {}),
  /** "Confirm with PayPal": where to send the customer to sign in. */
  paypalLogin: (id: string) => req<{ url: string }>("GET", `/api/approvals/${id}/paypal-login`),
  walletOrder: () => req<{ orderId: string; approveUrl: string }>("POST", "/api/demo/wallet-order"),
  walletAttack: () => req<{ entry: AuditEntry; order: { item: string; payerId: string; amount: number } }>("POST", "/api/demo/wallet-attack"),
  phoneLink: (id: string) => req<{ path: string }>("GET", `/api/approvals/${id}/phone-link`),
  phoneEntry: (path: string) => req<AuditEntry & { item?: string; customer: string }>("GET", `/api/phone/${path}`),
  phoneAct: (path: string, action: "approve" | "reject") => req<AuditEntry>("POST", `/api/phone/${path}/${action}`),
  reset: () => req<{ ok: true }>("POST", "/api/demo/reset"),
  guard: (body: unknown) => req<AuditEntry>("POST", "/api/guard", body),
};

export const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Open a PayPal page in a popup and wait for Paywarden's return page to report back
 * (it posts { paywarden: "paypal", ok, ... } to this window, same origin only).
 */
export function paypalPopup(getUrl: () => Promise<string>): Promise<{ ok: boolean; reason?: string; [k: string]: unknown }> {
  // Open the window inside the click itself (browsers block pop-ups opened after an await),
  // then point it at PayPal once the server has made the link.
  const w = window.open("about:blank", "paypal", "width=520,height=760");
  if (!w) return Promise.reject(new Error("Your browser blocked the PayPal window. Allow pop-ups for this page and try again."));
  return new Promise((resolve, reject) => {
    getUrl().then(
      (url) => {
        w.location.href = url;
      },
      (err: Error) => {
        w.close();
        done();
        reject(err);
      },
    );
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || (e.data as { paywarden?: string })?.paywarden !== "paypal") return;
      done();
      resolve(e.data);
    };
    const timer = window.setInterval(() => {
      if (w.closed) {
        done();
        resolve({ ok: false, reason: "The PayPal window was closed." });
      }
    }, 800);
    const done = () => {
      window.removeEventListener("message", onMsg);
      window.clearInterval(timer);
    };
    window.addEventListener("message", onMsg);
  });
}
