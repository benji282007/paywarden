const CODE = `import { Paywarden } from "./paywarden"; // one file, no dependencies

const pw = new Paywarden({ baseUrl: PAYWARDEN_URL, merchantToken, signingKey }); // your Ed25519 key

// 1. When a signed-in customer opens the chat:
const s = await pw.openSession(customer.id);
await client.connect(new StreamableHTTPClientTransport(s.mcpUrl)); // was PayPal's MCP URL
s.guard(client);                       // confirmations ride along in _meta

// 2. Each customer turn:
await s.customerSaid(message.text);

// 3. When they tap "Yes, refund me" on the card your app shows:
await s.customerConfirmed(order.captureId, 36.00); // signed locally with your key`;

/** For merchants: what connecting an existing agent takes, and what each piece buys. */
export function Integrate({ onGoto }: { onGoto: (t: "policy" | "audit") => void }) {
  return (
    <section className="panel integrate">
      <h2>Connect your agent</h2>
      <p className="sub">
        Your agent keeps its prompt, model and framework. It talks to Paywarden exactly as it talks to PayPal's MCP server: same tools, same arguments, same
        responses. Proven with PayPal's own MCP Inspector against the PayPal sandbox (<span className="mono">server/scripts/dropin-proof.sh</span>).
      </p>
      <div className="integrate-grid">
        <pre className="code" aria-label="Adapter code">
          <code>{CODE}</code>
        </pre>
        <ol className="integrate-why">
          <li>
            <b>Who is the customer?</b> Comes from your login, never from the model. Paywarden blocks refunds on anyone else's order and scopes reads to theirs.
          </li>
          <li>
            <b>What did they ask for?</b> A tap in <i>your</i> app makes your backend sign a refund mandate with your own key: one order, one maximum amount, 15 minutes, one payout. Paywarden holds only your public key, so it can verify consent but never create it.
            Nothing the agent reads or writes can make one, so a note can't talk money out of you.
          </li>
          <li>
            <b>Is it within your rules?</b> Caps, daily limits, order age, duplicates and over-refunds are checked against PayPal's live refund total, under a
            lock, with an idempotency key. A confirmation never lifts a limit.
          </li>
          <li>
            <b>Anything else waits for you.</b> One tap in the dashboard, or scan a QR code and approve on your phone.
          </li>
        </ol>
      </div>
      <p className="hint">
        No confirm button in your chat yet? Leave out step 3: Paywarden falls back to reading the customer's own words (measured on unseen attacks: 90–100%
        stopped, 90% of genuine refunds straight through) and holds the rest for you.
      </p>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="btn primary" onClick={() => onGoto("policy")}>
          Backtest on my PayPal history
        </button>
        <button className="btn" onClick={() => onGoto("audit")}>
          See the audit log
        </button>
      </div>
    </section>
  );
}
