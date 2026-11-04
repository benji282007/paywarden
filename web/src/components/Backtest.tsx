import { useState } from "react";
import { req, usd, type Policy } from "../api";

type Row = { id: string; at: string; customerId: string; amount: number; before: string; after: string; reason: string };
type Report = {
  replayed: number;
  changed: Row[];
  newlyStopped: { count: number; amount: number };
  newlyAllowed: { count: number; amount: number };
  source?: { refunds: number; matched: number; notReplayed: string[] };
  exposure?: {
    hasTextColumns: boolean;
    paymentsWithText: number;
    payments: number;
    refundsOnTextOrders: number;
    dollarsOnTextOrders: number;
    refundDollars: number;
    instructionLike: { txn: string; amount: number; text: string; flagged: string }[];
  };
};

/** The finding a CSV can't replay but can measure: where an agent would meet text written by buyers. */
function Exposure({ e }: { e: NonNullable<Report["exposure"]> }) {
  if (!e.hasTextColumns) {
    return <p className="hint">This export has no Note or Subject column, so we can't show which orders carry buyer-written text.</p>;
  }
  const pct = e.refundDollars ? Math.round((100 * e.dollarsOnTextOrders) / e.refundDollars) : 0;
  return (
    <div className="exposure">
      <div className="exposure-head">
        <div>
          <div className="exposure-big">{usd(e.dollarsOnTextOrders)}</div>
          <div className="hint">
            of your {usd(e.refundDollars)} in refunds ({pct}%) were on orders carrying text the buyer wrote. An AI agent handling those refunds reads that text.
          </div>
        </div>
        <div>
          <div className="exposure-big warn">{e.instructionLike.length}</div>
          <div className="hint">
            of {e.paymentsWithText} buyer notes read like instructions to staff or a bot. With Paywarden, none of them can release money: only the customer's
            confirmation or you can.
          </div>
        </div>
      </div>
      {e.instructionLike.length > 0 && (
        <ul className="exposure-list">
          {e.instructionLike.slice(0, 4).map((x) => (
            <li key={x.txn}>
              <b>{usd(x.amount)}</b> <span className="mono small">{x.txn}</span> “{x.text}”
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const WORD: Record<string, string> = { allow: "paid out", hold: "held", block: "blocked" };

/** Replay this shop's past refund decisions under the draft, before it goes live. */
export function Backtest({ draft, names }: { draft: () => Policy; names: Record<string, string> }) {
  const [report, setReport] = useState<Report>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const [sourceName, setSourceName] = useState<string>();

  async function run(csv?: { name: string; text: string }) {
    setBusy(true);
    setError(undefined);
    try {
      setReport(
        csv
          ? await req<Report>("POST", "/api/policy/backtest-csv", { policy: draft(), csv: csv.text })
          : await req<Report>("POST", "/api/policy/backtest", { policy: draft() }),
      );
      setSourceName(csv?.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sample() {
    const text = await (await fetch("/sample-paypal-activity.csv")).text();
    await run({ name: "sample PayPal activity export", text });
  }

  const none = report && report.changed.length === 0;

  return (
    <section className="panel">
      <div className="row" style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Backtest on your history</h2>
        <span className="spacer" />
        <button className="btn primary" onClick={() => run()} disabled={busy}>
          {busy ? "Replaying…" : "Replay last 30 days"}
        </button>
      </div>
      <p className="sub">Every past refund decision, re-decided under your draft rules, in order. See what would have changed before you save. No AI, no PayPal calls.</p>
      <div className="row upload" style={{ flexWrap: "wrap" }}>
        <label className="btn">
          Use my PayPal export (CSV)
          <input
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await run({ name: f.name, text: await f.text() });
              e.target.value = "";
            }}
          />
        </label>
        <button className="btn" onClick={sample} disabled={busy}>
          Try a sample export
        </button>
        <span className="hint">PayPal: Reports → Activity download. Sent to the server for this backtest only; nothing is saved.</span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {report && (
        <div aria-live="polite">
          {report.source && (
            <p className="hint">
              From {sourceName}: {report.source.refunds} refunds, {report.source.matched} matched to their original payment. Not replayable from a CSV:{" "}
              {report.source.notReplayed.join(", ")}.
            </p>
          )}
          {report.exposure && <Exposure e={report.exposure} />}
          <div className="summary">
            <div className="kpi">
              <div className="label">Decisions replayed</div>
              <div className="value">{report.replayed}</div>
            </div>
            <div className="kpi">
              <div className="label">Would now wait or be refused</div>
              <div className="value" style={{ color: report.newlyStopped.count ? "var(--hold)" : undefined }}>
                {report.newlyStopped.count}
              </div>
              <div className="hint">{usd(report.newlyStopped.amount)} that went out before</div>
            </div>
            <div className="kpi">
              <div className="label">Would now go straight out</div>
              <div className="value" style={{ color: report.newlyAllowed.count ? "var(--allow)" : undefined }}>
                {report.newlyAllowed.count}
              </div>
              <div className="hint">{usd(report.newlyAllowed.amount)} that waited before</div>
            </div>
          </div>
          {none ? (
            <div className="empty">No past decision changes under this draft.</div>
          ) : (
            <ul className="attacks">
              {report.changed.slice(0, 8).map((r) => (
                <li key={r.id} className={r.after === "allow" ? "stopped" : "leak"}>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <b>{usd(r.amount)}</b>
                    <span>{names[r.customerId] ?? r.customerId}</span>
                    <span className="hint">{new Date(r.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                    <span className={`pill ${r.before}`}>{WORD[r.before]}</span>→<span className={`pill ${r.after}`}>{WORD[r.after]}</span>
                  </div>
                  <div className="attack-detail hint">{r.reason}</div>
                </li>
              ))}
              {report.changed.length > 8 && <li className="hint">…and {report.changed.length - 8} more</li>}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
