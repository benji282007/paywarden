import { createElement, useEffect, useRef, useState } from "react";

const AGENT_CODE = `import { Paywarden } from "./paywarden"; // one file, no dependencies

const pw = new Paywarden({ baseUrl: PAYWARDEN_URL, merchantToken, signingKey }); // your Ed25519 key

// When a signed-in customer opens the chat:
const s = await pw.openSession(customer.id);
await client.connect(new StreamableHTTPClientTransport(s.mcpUrl)); // was PayPal's MCP URL
s.guard(client); // mandates ride along in MCP _meta, where the model can't write`;

const CARD_CODE = `<script src="${typeof window === "undefined" ? "" : window.location.origin}/paywarden-confirm.js" defer></script>

<paywarden-confirm merchant="Acme Coffee" amount="36.00" item="Cold brew bundle"></paywarden-confirm>

card.addEventListener("confirm", () =>
  session.customerConfirmed(order.captureId, 36.00)); // your backend signs the mandate`;

/** Loads the drop-in card from this server, exactly as a merchant's page would. */
function useConfirmScript() {
  useEffect(() => {
    if (document.querySelector('script[src="/paywarden-confirm.js"]')) return;
    const s = document.createElement("script");
    s.src = "/paywarden-confirm.js";
    s.defer = true;
    document.head.appendChild(s);
  }, []);
}

/** For merchants: what connecting an existing agent takes. */
export function Integrate({ onGoto }: { onGoto: (t: "policy" | "audit") => void }) {
  useConfirmScript();
  const card = useRef<HTMLElement>(null);
  const [heard, setHeard] = useState<string>();
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const on = (e: Event) => setHeard(`"${e.type}" event fired. Your backend now signs the mandate for this order and amount.`);
    el.addEventListener("confirm", on);
    el.addEventListener("decline", on);
    return () => {
      el.removeEventListener("confirm", on);
      el.removeEventListener("decline", on);
    };
  }, []);

  return (
    <section className="panel integrate">
      <h2>Connect in two pieces</h2>
      <p className="sub">
        Your agent keeps its prompt, model and PayPal's tools, word for word (<span className="mono">server/scripts/dropin-proof.sh</span> proves it with
        PayPal's MCP Inspector).
      </p>

      <h3 className="step-title">1 · Your agent: three lines</h3>
      <pre className="code" aria-label="Agent adapter code">
        <code>{AGENT_CODE}</code>
      </pre>

      <h3 className="step-title">2 · Your customer: one tag</h3>
      <div className="integrate-grid">
        <pre className="code" aria-label="Confirm card code">
          <code>{CARD_CODE}</code>
        </pre>
        <div className="card-preview">
          <div className="hint">Live preview (the real component). Try it:</div>
          {createElement("paywarden-confirm", { ref: card, merchant: "Acme Coffee", amount: "36.00", item: "Cold brew bundle" })}
          {heard && <p className="hint">{heard}</p>}
        </div>
      </div>

      <details className="why">
        <summary>What Paywarden checks on every refund and dispute</summary>
        <ul className="integrate-why">
          <li>
            <b>Consent:</b> a mandate your backend signs with your key on the customer's tap. One order, one amount, 15 minutes, one payout. Paywarden holds only
            your public key; the proof is also written onto PayPal's own refund record.
          </li>
          <li>
            <b>Ownership:</b> from your login, never the model. No refunds or dispute acceptances on someone else's payment.
          </li>
          <li>
            <b>Ledger:</b> PayPal's live refund total, under a lock, with an idempotency key. A refund and an accepted dispute on the same payment can't both pay.
          </li>
          <li>
            <b>Your rules:</b> caps, velocity, order age, repeat refunders, and "the bot never accepts a dispute on its own". A customer's yes never lifts a limit.
          </li>
          <li>
            <b>No confirm button yet?</b> Skip piece 2: Paywarden reads the customer's own chat instead (unseen attacks: 90–100% stopped, 90% of genuine refunds
            straight through) and holds the rest for you, on the dashboard or your phone.
          </li>
        </ul>
      </details>

      <div className="row" style={{ flexWrap: "wrap", marginTop: 12 }}>
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
