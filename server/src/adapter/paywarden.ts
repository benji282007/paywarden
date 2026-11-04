// The merchant-side adapter: what "point your agent at Paywarden" takes in code.
// No dependencies; it wraps any MCP client that has callTool (the official SDK's Client,
// or anything shaped like it).
//
//   const pw = new Paywarden({ baseUrl, merchantToken });
//   const s = await pw.openSession(signedInCustomer.id);          // 1. per conversation
//   await client.connect(new StreamableHTTPClientTransport(s.mcpUrl));  // 2. instead of PayPal's URL
//   s.guard(client);                                              // 3. confirmations ride along in _meta
//   await s.customerSaid(text);                                   // each customer turn
//   await s.customerConfirmed(captureId, 36);                     // when they tap "Yes, refund"
//
// The model only ever fills tool `arguments`; `_meta` is set here, by the merchant's code,
// so nothing the agent reads can add or forge a confirmation.

export const META_MANDATES = "paywarden/mandates";

export interface PaywardenOptions {
  /** Where Paywarden runs, e.g. https://paywarden.example.com */
  baseUrl: string;
  /** The merchant API token (PAYWARDEN_MERCHANT_TOKEN on the server). */
  merchantToken?: string;
  fetch?: typeof fetch;
}

type CallToolLike = { callTool: (params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }, ...rest: never[]) => Promise<unknown> };

export class Paywarden {
  private cookie?: string;
  constructor(private readonly opts: PaywardenOptions) {}

  /** @internal */
  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await (this.opts.fetch ?? fetch)(new URL(path, this.opts.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.merchantToken ? { authorization: `Bearer ${this.opts.merchantToken}` } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`Paywarden ${path}: ${json.error ?? res.status}`);
    return json;
  }

  /** Call once you've authenticated the customer. Their identity comes from you, never from the model. */
  async openSession(customerId: string, opts: { agentId?: string } = {}): Promise<PaywardenSession> {
    const r = await this.post<{ key: string; mcpPath: string }>("/api/sessions", { customerId, agentId: opts.agentId });
    return new PaywardenSession(this, customerId, r.key, new URL(r.mcpPath, this.opts.baseUrl));
  }
}

export class PaywardenSession {
  private mandates: string[] = [];

  constructor(
    private readonly pw: Paywarden,
    readonly customerId: string,
    readonly key: string,
    /** Give this to your MCP client instead of PayPal's MCP URL. */
    readonly mcpUrl: URL,
  ) {}

  /** Forward the customer's own chat turn: the only text that can express their intent. */
  async customerSaid(text: string): Promise<void> {
    await this.pw.post(`/api/sessions/${this.key}/messages`, { text });
  }

  /**
   * The customer tapped "Yes, refund this" in your UI. Paywarden signs a confirmation for
   * exactly this capture and amount; the next matching refund the agent makes goes through
   * (still within every limit in your policy).
   */
  async customerConfirmed(captureId: string, maxAmount: number, ttlSeconds = 900): Promise<string> {
    const { token } = await this.pw.post<{ token: string }>("/api/mandates", { customerId: this.customerId, captureId, maxAmount, ttlSeconds });
    this.mandates.push(token);
    if (this.mandates.length > 10) this.mandates.shift();
    return token;
  }

  /** Attach this session's confirmations to every tool call the client makes. Returns the same client. */
  guard<C extends CallToolLike>(client: C): C {
    const original = client.callTool.bind(client) as (...a: unknown[]) => Promise<unknown>;
    const session = this;
    (client as CallToolLike).callTool = ((params: Parameters<CallToolLike["callTool"]>[0], ...rest: unknown[]) =>
      original({ ...params, _meta: { ...(params._meta ?? {}), [META_MANDATES]: [...session.mandates] } }, ...rest)) as CallToolLike["callTool"];
    return client;
  }
}
