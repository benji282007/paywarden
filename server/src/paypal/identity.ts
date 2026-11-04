// Log in with PayPal (OpenID Connect), used for one thing: learning which PayPal account
// the person confirming a refund is signed in to.
//
// Paywarden runs this flow itself with the merchant's PayPal app credentials, so the payer id
// comes straight from PayPal's userinfo endpoint over TLS. Neither the shop's front end nor
// the agent (nor anything the agent read) can supply it. Paywarden then compares it with the
// payer on PayPal's own capture: only the account that paid can consent to its refund.
//
// Needs "Log in with PayPal" turned on for the app in the PayPal developer dashboard, with
// "PayPal account ID (payer ID)" among the requested fields and the callback as a return URL.

export interface PayPalLoginConfig {
  clientId: string;
  clientSecret: string;
  /** API host. Defaults to the sandbox. */
  apiBase?: string;
  /** Where the customer signs in. Defaults to the sandbox. */
  webBase?: string;
}

export interface PayPalIdentity {
  payerId: string;
  /** For display only ("Signed in as ..."); never used for decisions. */
  email?: string;
}

export class PayPalLoginError extends Error {}

export class PayPalLogin {
  private readonly api: string;
  private readonly web: string;

  constructor(
    private readonly cfg: PayPalLoginConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.api = cfg.apiBase ?? "https://api-m.sandbox.paypal.com";
    this.web = cfg.webBase ?? "https://www.sandbox.paypal.com";
  }

  /** The PayPal page the customer is sent to. `state` must be unguessable and tied to one refund. */
  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({
      flowEntry: "static",
      client_id: this.cfg.clientId,
      response_type: "code",
      scope: "openid https://uri.paypal.com/services/paypalattributes email",
      redirect_uri: redirectUri,
      state,
    });
    return `${this.web}/connect/?${q}`;
  }

  /** Exchange the one-time code PayPal returned for the signed-in account's payer id. */
  async identify(code: string, redirectUri: string): Promise<PayPalIdentity> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const tok = await this.fetchFn(`${this.api}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const t = (await tok.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
    if (!tok.ok || !t.access_token) throw new PayPalLoginError(`PayPal sign-in failed: ${t.error_description ?? tok.status}`);

    const info = await this.fetchFn(`${this.api}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, {
      headers: { Authorization: `Bearer ${t.access_token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const u = (await info.json().catch(() => ({}))) as { payer_id?: unknown; emails?: { value?: string; primary?: boolean }[] };
    if (!info.ok) throw new PayPalLoginError(`PayPal userinfo failed: ${info.status}`);
    if (typeof u.payer_id !== "string" || !/^[A-Z0-9]{8,20}$/.test(u.payer_id)) {
      throw new PayPalLoginError('PayPal did not return a payer id. In the app\'s "Log in with PayPal" settings, request "PayPal account ID (payer ID)".');
    }
    const email = u.emails?.find((e) => e.primary)?.value ?? u.emails?.[0]?.value;
    return { payerId: u.payer_id, ...(email ? { email } : {}) };
  }
}
