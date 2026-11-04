import { useState } from "react";
import { api, usd, type AuditEntry, type Customer, type Span } from "../api";

/** Renders text with every tainted span marked, merging overlaps. */
export function Highlighted({ text, spans }: { text: string; spans: Span[] }) {
  const ranges = [...spans].sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const s of ranges) {
    if (s.end <= cursor) continue;
    const start = Math.max(s.start, cursor);
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={start} className="taint" title={s.reason}>
        {text.slice(start, s.end)}
      </mark>,
    );
    cursor = s.end;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function Evidence({ entry }: { entry: AuditEntry }) {
  return (
    <>
      <ul className="reasons">
        {entry.hits.map((h, i) => (
          <li key={i}>
            <span className={`pill ${h.action}`}>{h.action}</span>
            <div>
              {h.reason}
              <div className="rule">Rule: “{h.source}”</div>
            </div>
          </li>
        ))}
        {entry.judge && (
          <li>
            <span className={`pill ${entry.judge.verdict}`}>{entry.judge.verdict}</span>
            <div>
              {entry.judge.reason}
              <div className="rule">AI intent check ({entry.judge.model}), can only tighten</div>
            </div>
          </li>
        )}
      </ul>
      {entry.sources?.map((src) => (
        <div className="source" key={src.origin}>
          <div className="origin">Customer-written text the agent read · {src.origin}</div>
          <Highlighted text={src.text} spans={entry.spans.filter((s) => s.origin === src.origin)} />
        </div>
      ))}
    </>
  );
}

export function Approvals({ entries, customers, onChange }: { entries: AuditEntry[]; customers: Customer[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const held = entries.filter((e) => e.status === "held");
  const name = (id: string) => customers.find((c) => c.id === id)?.name ?? id;

  async function act(id: string, kind: "approve" | "reject") {
    setBusy(id);
    setError(undefined);
    try {
      const r = await (kind === "approve" ? api.approve(id) : api.reject(id));
      if (r.status === "blocked") setError(`Not paid: ${r.hits.at(-1)?.reason ?? "a blocking rule applies now"}.`);
      if (r.status === "failed") setError(`PayPal refused the refund: ${r.paypal?.error ?? "unknown error"}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
      onChange();
    }
  }

  // Nothing waiting: a slim line instead of an empty panel, so the first screen stays about the story.
  if (held.length === 0 && !error) {
    return <div className="slim">No refunds waiting for your approval. Refunds within your rules go through on their own.</div>;
  }

  return (
    <section className="panel approvals-panel">
      <h2>Waiting for your approval {held.length > 0 && <span className="pill held">{held.length}</span>}</h2>
      <p className="sub">The agent asked to move money that your rules said a person should check first. Nothing has been refunded yet.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {held.length === 0 ? (
        <div className="empty">Nothing waiting. Refunds within your rules go through on their own.</div>
      ) : (
        <div className="approvals">
          {held.map((e) => (
            <article className="approval" key={e.id}>
              <div className="head">
                <span className="amount">{usd(e.effectiveAmount)}</span>
                <span className="who">
                  {e.tool === "create_refund" ? "refund" : e.tool} for <b>{name(e.customerId)}</b>
                  {e.captureId && (
                    <>
                      {" "}
                      · capture <span className="mono">{e.captureId}</span>
                    </>
                  )}
                </span>
                <span className="spacer" />
                <button className="btn" disabled={busy === e.id} onClick={() => act(e.id, "reject")}>
                  Reject
                </button>
                <button className="btn approve" disabled={busy === e.id} onClick={() => act(e.id, "approve")}>
                  Approve refund
                </button>
              </div>
              <Evidence entry={e} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
