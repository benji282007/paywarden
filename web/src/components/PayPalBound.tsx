import { useEffect, useState } from "react";
import { api, paypalPopup, usd, type AuditEntry } from "../api";
import { ConfirmCard } from "./Confirm";

/**
 * The strongest version of consent: the order was paid from a PayPal account, and only
 * someone signed in to that same PayPal account can confirm its refund. PayPal, not the shop
 * or the agent, tells Paywarden who signed in.
 */
export function PayPalBound({ onDone }: { onDone: () => void }) {
  const [enabled, setEnabled] = useState<boolean>();
  const [paid, setPaid] = useState<{ payerId: string }>();
  const [held, setHeld] = useState<{ entry: AuditEntry; item: string; payerId: string }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.status().then((s) => setEnabled(!!s.paypalLogin), () => setEnabled(false));
  }, []);

  async function pay() {
    setBusy("pay");
    setError(undefined);
    try {
      const r = await paypalPopup(async () => (await api.walletOrder()).approveUrl);
      if (r.ok) setPaid({ payerId: String(r.payerId) });
      else setError(r.reason ?? "The payment didn't complete.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
      onDone();
    }
  }

  async function attack() {
    setBusy("attack");
    setError(undefined);
    try {
      const r = await api.walletAttack();
      setHeld({ entry: r.entry, item: r.order.item, payerId: r.order.payerId });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
      onDone();
    }
  }

  if (enabled === undefined) return null;
  return (
    <section className="bound">
      <h3>Bound to the PayPal account that paid</h3>
      <p className="hint">
        For orders paid with PayPal, Sam confirms by signing in to PayPal. PayPal tells Paywarden which account signed in, and only the account that paid can
        release the refund. Try signing in as a different sandbox account: nothing moves.
      </p>
      {!enabled ? (
        <p className="hint">Needs PayPal sandbox keys with "Log in with PayPal" turned on for the app (see README).</p>
      ) : (
        <ol className="bound-steps">
          <li>
            <button className="btn" disabled={!!busy || !!paid} onClick={pay}>
              {busy === "pay" ? "Waiting for PayPal…" : paid ? "Paid" : "1. Sam pays $24 with his PayPal account"}
            </button>
            {paid && <span className="hint"> PayPal payer {paid.payerId}</span>}
          </li>
          <li>
            <button className="btn" disabled={!!busy || !paid || !!held} onClick={attack}>
              {busy === "attack" ? "Agent working…" : "2. The agent reads the same note on this order"}
            </button>
            {held && <span className="hint"> {held.entry.status === "held" ? "Held: Paywarden asks Sam." : held.entry.status}</span>}
          </li>
          {held?.entry.status === "held" && (
            <li>
              <ConfirmCard key={held.entry.id} entry={held.entry} item={held.item} onDone={onDone} paypal={{ payerId: held.payerId }} />
            </li>
          )}
        </ol>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {held && <p className="hint">{`Refunds ${usd(held.entry.effectiveAmount)} only on PayPal's word that the paying account said yes.`}</p>}
    </section>
  );
}
