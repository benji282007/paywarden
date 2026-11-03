import { useState } from "react";
import { req, usd, type Policy, type Rule } from "../api";

type Outcome = { status: string; amount: number; reason: string };
type Scenario = { title: string; technique: string; customer: string; says: string; note?: string; calls: unknown[]; leaked: number; outcomes: Outcome[] };
type Report = {
  model: string;
  scenarios: Scenario[];
  leakedTotal: number;
  attemptedTotal: number;
  suggestions: { rule: Rule; why: string; stops: number; of: number }[];
  rejectedFixes: number;
};

/** AI red team: fresh attacks aimed at the draft rules, run in a throwaway copy of the shop. */
export function RedTeam({ draft, onAddRule, aiModel }: { draft: () => Policy; onAddRule: (r: Rule) => void; aiModel: string | null }) {
  const [report, setReport] = useState<Report>();
  const [busy, setBusy] = useState<"attack" | "rerun">();
  const [error, setError] = useState<string>();
  const [added, setAdded] = useState<string[]>([]);

  async function attack() {
    setBusy("attack");
    setError(undefined);
    setAdded([]);
    try {
      setReport(await req<Report>("POST", "/api/policy/redteam", { policy: draft() }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  // Same attacks, new rules: no AI call, so the comparison is exact.
  async function rerun() {
    if (!report) return;
    setBusy("rerun");
    setError(undefined);
    try {
      const r = await req<{ scenarios: Scenario[] }>("POST", "/api/policy/redteam/rerun", { policy: draft(), scenarios: report.scenarios });
      setReport({ ...report, scenarios: r.scenarios, leakedTotal: r.scenarios.reduce((t, s) => t + s.leaked, 0) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  const leaks = report?.scenarios.filter((s) => s.leaked > 0).length ?? 0;

  return (
    <section className="panel redteam">
      <div className="row" style={{ marginBottom: 4, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Attack my policy</h2>
        <span className="spacer" />
        {report && (
          <button className="btn" onClick={rerun} disabled={!!busy}>
            {busy === "rerun" ? "Re-running…" : "Re-run these attacks"}
          </button>
        )}
        <button className="btn primary" onClick={attack} disabled={!!busy || !aiModel}>
          {busy === "attack" ? "Attacking…" : report ? "New attacks" : "Attack my policy"}
        </button>
      </div>
      <p className="sub">
        An AI red team reads your draft rules and writes fresh attacks aimed at their gaps. Each one runs through the real guard in a throwaway copy of the shop, so
        nothing moves. Leaks come with a proposed rule, tested against the same attacks before you see it.
      </p>
      {!aiModel && <div className="empty">Needs an AI key on the server.</div>}
      {busy === "attack" && <div className="hint">Writing and running attacks (free AI tier: about 45 s)…</div>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {report && (
        <div aria-live="polite">
          <div className={`banner ${report.leakedTotal ? "error" : "ok"}`}>
            {report.leakedTotal
              ? `${leaks} of ${report.scenarios.length} attacks got ${usd(report.leakedTotal)} out.`
              : `All ${report.scenarios.length} attacks were stopped. Nothing got out.`}
          </div>
          <ul className="attacks">
            {report.scenarios.map((s, i) => (
              <li key={i} className={s.leaked ? "leak" : "stopped"}>
                <div className="row" style={{ gap: 8 }}>
                  <span className={`pill ${s.leaked ? "block" : "allow"}`}>{s.leaked ? `leaked ${usd(s.leaked)}` : "stopped"}</span>
                  <b>{s.title}</b>
                  <span className="hint">{s.technique}</span>
                </div>
                <div className="attack-detail">
                  {s.customer} says: “{s.says}”{s.note ? <> · note: “{s.note}”</> : null}
                </div>
                <div className="attack-detail hint">{s.outcomes.map((o) => `${o.status} ${usd(o.amount)}${o.status === "executed" ? "" : `: ${o.reason}`}`).join(" · ")}</div>
              </li>
            ))}
          </ul>
          {leaks > 0 && report.suggestions.length === 0 && (
            <p className="hint" style={{ marginTop: 12 }}>
              {report.rejectedFixes
                ? `The AI proposed ${report.rejectedFixes} rule${report.rejectedFixes > 1 ? "s" : ""}, but ${report.rejectedFixes > 1 ? "none" : "it"} stopped these attacks when re-run, so nothing is suggested. Try switching a rule back on and re-running.`
                : "No fix proposed. Try switching a rule back on and re-running."}
            </p>
          )}
          {report.suggestions.length > 0 && (
            <div className="fixes">
              <h3>Proposed fixes</h3>
              {report.suggestions.map((g) => (
                <div className="rule-row" key={g.rule.id}>
                  <span className={`pill ${g.rule.action}`}>{g.rule.action}</span>
                  <div>
                    <div className="en">{g.rule.source}</div>
                    <div className="hint">
                      Stops {g.stops} of {g.of} leaked attacks when re-run. {g.why}
                    </div>
                  </div>
                  <button
                    className="btn"
                    disabled={added.includes(g.rule.id)}
                    onClick={() => {
                      onAddRule(g.rule);
                      setAdded((a) => [...a, g.rule.id]);
                    }}
                  >
                    {added.includes(g.rule.id) ? "Added" : "Add to draft"}
                  </button>
                </div>
              ))}
              {added.length > 0 && <p className="hint">Added. Press “Re-run these attacks” to check the same attacks against your new draft.</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
