import { useEffect, useState } from "react";
import qrcode from "qrcode-generator";
import { api, usd, type AuditEntry } from "../api";

/**
 * What the customer sees in the shop's own app when the agent tries to refund them.
 * The shop renders it, not the agent, and only the customer's tap signs a confirmation.
 */
export function ConfirmCard({
  entry,
  item,
  who = "Sam",
  onDone,
  onResult,
}: {
  entry: AuditEntry;
  item?: string;
  who?: string;
  onDone: () => void;
  /** Money that left on the customer's confirmation (0 if none). */
  onResult?: (moved: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();

  async function act(kind: "confirm" | "reject") {
    setBusy(true);
    try {
      const r = kind === "confirm" ? await api.confirm(entry.id) : await api.reject(entry.id);
      onResult?.(r.status === "approved" || r.status === "executed" ? r.effectiveAmount : 0);
      setResult(
        r.status === "approved" || r.status === "executed"
          ? `${usd(r.effectiveAmount)} refunded on ${who}'s signed confirmation.`
          : r.status === "rejected"
            ? `${who} said no. Nothing was refunded, and the attempt is in your audit log.`
            : r.status === "held"
              ? `Confirmed by ${who}, but your limits still apply: it now waits for you.`
              : `Not refunded: ${r.hits.at(-1)?.reason ?? r.status}`,
      );
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <div className="phone-card" role="group" aria-label={`${who}'s view in the shop's app`}>
      <div className="phone-card-head">
        <span>Acme Coffee app · {who}'s phone</span>
        <span className="phone-lock" aria-hidden>
          🔒
        </span>
      </div>
      {result ? (
        <p className="phone-result">{result}</p>
      ) : (
        <>
          <p className="phone-q">
            Refund <b>{usd(entry.effectiveAmount)}</b>
            {item ? (
              <>
                {" "}
                for <b>{item}</b>
              </>
            ) : null}{" "}
            to you?
          </p>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => act("reject")}>
              I didn't ask for this
            </button>
            <button className="btn approve" disabled={busy} onClick={() => act("confirm")}>
              Yes, refund me
            </button>
          </div>
          <p className="phone-fine">The agent can't press this button. A tap signs a confirmation for this order and amount only.</p>
        </>
      )}
    </div>
  );
}

/** QR code for approving a held refund on the merchant's phone (signed link, no login). */
export function PhoneQr({ id }: { id: string }) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api
      .phoneLink(id)
      .then((r) => setUrl(new URL(r.path, window.location.origin).toString()))
      .catch((e: Error) => setError(e.message));
  }, [id]);
  if (error) return <p className="error">{error}</p>;
  if (!url) return <p className="hint">Making a link…</p>;
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  return (
    <div className="qr">
      <div className="qr-img" dangerouslySetInnerHTML={{ __html: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) }} />
      <div>
        <b>Scan to approve on your phone</b>
        <p className="hint">
          A signed one-time link to this refund only. On localhost your phone can't reach this computer; on the hosted demo it works from anywhere.
        </p>
        <a className="mono small" href={url} target="_blank" rel="noreferrer">
          open the phone view
        </a>
      </div>
    </div>
  );
}

/** The merchant's phone: one held refund, the evidence, and two buttons. */
export function PhoneApprove({ path }: { path: string }) {
  const [entry, setEntry] = useState<AuditEntry & { item?: string; customer: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.phoneEntry(path).then(setEntry, (e: Error) => setError(e.message));
  }, [path]);

  async function act(kind: "approve" | "reject") {
    setBusy(true);
    try {
      const r = await api.phoneAct(path, kind);
      setEntry({ ...entry!, ...r });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="phone-page">
      <div className="logo-line">Paywarden · Acme Coffee</div>
      {error && <p className="error">{error}</p>}
      {entry && (
        <section className="panel">
          <div className="phone-amount">{usd(entry.effectiveAmount)}</div>
          <p>
            Refund to <b>{entry.customer}</b>
            {entry.item ? ` for ${entry.item}` : ""}
          </p>
          <ul className="reasons">
            {entry.hits.map((h, i) => (
              <li key={i}>
                <span className={`pill ${h.action}`}>{h.action}</span>
                <div>{h.reason}</div>
              </li>
            ))}
          </ul>
          {entry.sources?.filter((s, i, all) => all.findIndex((x) => x.text === s.text) === i).map((s) => (
            <div className="source" key={s.origin}>
              <div className="origin">Customer-written text the agent read · {s.origin}</div>
              {s.text}
            </div>
          ))}
          {entry.status === "held" ? (
            <div className="row phone-actions">
              <button className="btn big" disabled={busy} onClick={() => act("reject")}>
                Reject
              </button>
              <button className="btn approve big" disabled={busy} onClick={() => act("approve")}>
                Approve
              </button>
            </div>
          ) : (
            <p className={`phone-done ${entry.status}`}>
              {entry.status === "approved" || entry.status === "executed" ? "Approved and refunded." : entry.status === "rejected" ? "Rejected. Nothing was refunded." : `Status: ${entry.status}`}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
