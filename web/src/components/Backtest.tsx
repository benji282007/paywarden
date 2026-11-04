import { useState } from "react";
import { req, usd, type Policy } from "../api";

type Row = { id: string; at: string; customerId: string; amount: number; before: string; after: string; reason: string };
type Report = {
  replayed: number;
  changed: Row[];
  newlyStopped: { count: number; amount: number };
  newlyAllowed: { count: number; amount: number };
  source?: { refunds: number; matched: number; notReplayed: string[] };
};

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
