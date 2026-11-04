import { useState } from "react";
import { req, type Policy } from "../api";

const SYM: Record<string, string> = { USD: "$", GBP: "£", EUR: "€" };
const money = (currency?: string) => (n: number) => `${SYM[currency ?? "USD"] ?? `${currency} `}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Row = { id: string; at: string; customerId: string; amount: number; before: string; after: string; reason: string };
type Report = {
  replayed: number;
  changed: Row[];
  newlyStopped: { count: number; amount: number };
  newlyAllowed: { count: number; amount: number };
  newlyHeld?: { count: number; amount: number };
  newlyRefused?: { count: number; amount: number };
  days?: number;
  currency?: string;
  suggestion?: { ruleId: string; current: number; suggested: number; reviewsPerDay: { current: number; suggested: number }; reviewed: { count: number; amount: number } };
  source?: { refunds: number; matched: number; notReplayed: string[] };
  serialRefunders?: { customer: string; payments: number; paid: number; refunds: number; refunded: number }[];
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
function Exposure({ e, usd, builtIn }: { e: NonNullable<Report["exposure"]>; usd: (n: number) => string; builtIn?: boolean }) {
  if (!e.hasTextColumns) {
    // The public retailer dataset never has buyer notes; only worth saying for a merchant's own export.
    return builtIn ? null : <p className="hint">This export has no Note or Subject column, so we can't show which orders carry buyer-written text.</p>;
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

  async function realRetailer() {
    const text = await (await fetch("/real-retailer-2011.csv")).text();
    await run({ name: "a real UK online retailer's year (UCI Online Retail II, Dec 2010–Dec 2011, CC BY 4.0; amounts in GBP)", text });
  }

  const usd = money(report?.currency);
  const none = report && report.changed.length === 0;
  // Of all the refunds in the upload: how many an agent could have done alone, how many (and how
  // often) a person would see, and how many would be refused outright.
  const total = report?.exposure?.refundDollars ?? 0;
  const split =
    report?.source && total > 0 && report.newlyHeld && report.newlyRefused
      ? {
          alone: report.replayed - report.newlyStopped.count,
          aloneShare: Math.round((100 * (total - report.newlyStopped.amount)) / total),
          held: report.newlyHeld.count,
          heldShare: Math.round((100 * report.newlyHeld.amount) / total),
          perDay: report.days ? Math.round((10 * report.newlyHeld.count) / report.days) / 10 : undefined,
          refused: report.newlyRefused.count,
        }
      : undefined;

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
        <button className="btn" onClick={realRetailer} disabled={busy} title="UCI Online Retail II: real transactions of a UK online gift shop, CC BY 4.0">
          Try a real retailer's year (3,383 refunds)
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
          {split && (
            <p className="split-headline">
              An agent could have issued <b>{split.alone.toLocaleString()}</b> of these {report.replayed.toLocaleString()} refunds on its own ({split.aloneShare}% of the
              money). <b>{split.held.toLocaleString()}</b> would have waited for you
              {split.perDay !== undefined && (
                <>
                  , <b>about {split.perDay} a day</b>
                </>
              )}
              , carrying {split.heldShare}% of the money{split.refused ? <>, and {split.refused} would have been refused</> : null}.
            </p>
          )}
          {report.suggestion && (
            <p className="hint suggest">
              Set from your own history: 90% of your refunds are under {usd(report.suggestion.suggested)}. With that limit instead of {usd(report.suggestion.current)},
              about {report.suggestion.reviewsPerDay.suggested} a day would wait for you (now {report.suggestion.reviewsPerDay.current}). Change it in Policy Studio.
            </p>
          )}
          {report.exposure && <Exposure e={report.exposure} usd={usd} builtIn={sourceName?.startsWith("a real UK online retailer")} />}
          {report.serialRefunders && report.serialRefunders.length > 0 && (
            <div className="exposure serial">
              <b>Refunds a confirm button can't stop: the customer is the one asking.</b>
              <ul className="exposure-list">
                {report.serialRefunders.map((c) => (
                  <li key={c.customer}>
                    <span className="mono small">{c.customer}</span>: {c.refunds} refunds on {c.payments} orders, {usd(c.refunded)} back of {usd(c.paid)} paid (
                    {Math.round((100 * c.refunded) / c.paid)}%)
                  </li>
                ))}
              </ul>
              <div className="hint">The repeat-refunder rule holds their later refunds for you; see the replay below.</div>
            </div>
          )}
          <div className="summary">
            <div className="kpi">
              <div className="label">Decisions replayed</div>
              <div className="value">{report.replayed}</div>
            </div>
            {report.newlyHeld && report.newlyRefused ? (
              <>
                <div className="kpi">
                  <div className="label">Would now wait for you</div>
                  <div className="value" style={{ color: report.newlyHeld.count ? "var(--hold)" : undefined }}>
                    {report.newlyHeld.count}
                  </div>
                  <div className="hint">{usd(report.newlyHeld.amount)} that went out before</div>
                </div>
                <div className="kpi">
                  <div className="label">Would now be refused</div>
                  <div className="value" style={{ color: report.newlyRefused.count ? "var(--block)" : undefined }}>
                    {report.newlyRefused.count}
                  </div>
                  <div className="hint">{usd(report.newlyRefused.amount)} that went out before</div>
                </div>
              </>
            ) : (
              <div className="kpi">
                <div className="label">Would now wait or be refused</div>
                <div className="value" style={{ color: report.newlyStopped.count ? "var(--hold)" : undefined }}>
                  {report.newlyStopped.count}
                </div>
                <div className="hint">{usd(report.newlyStopped.amount)} that went out before</div>
              </div>
            )}
            {(!report.source || report.newlyAllowed.count > 0) && (
            <div className="kpi">
              <div className="label">Would now go straight out</div>
              <div className="value" style={{ color: report.newlyAllowed.count ? "var(--allow)" : undefined }}>
                {report.newlyAllowed.count}
              </div>
              <div className="hint">{usd(report.newlyAllowed.amount)} that waited before</div>
            </div>
            )}
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
