import { useEffect, useRef, useState } from "react";
import { api, type Policy, type Rule, type SuiteReport } from "../api";

const NUMERIC = ["max", "days", "windowSeconds"] as const;

function dsl(rule: Rule & { enabled?: boolean }): string {
  const { id: _id, source: _source, enabled: _enabled, ...rest } = rule;
  return JSON.stringify(rest);
}

export function PolicyStudio({ live, onSaved }: { live: Policy; onSaved: () => void }) {
  const [rules, setRules] = useState<(Rule & { enabled: boolean })[]>([]);
  const [report, setReport] = useState<SuiteReport>();
  const [revealed, setRevealed] = useState(0);
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const timer = useRef<number>(undefined);

  useEffect(() => {
    setRules(live.rules.map((r) => ({ ...r, enabled: true })));
  }, [live]);

  useEffect(() => () => window.clearInterval(timer.current), []);

  const draft = (): Policy => ({ version: live.version, rules: rules.filter((r) => r.enabled).map(({ enabled: _e, ...r }) => r) });
  const dirty = JSON.stringify(draft().rules) !== JSON.stringify(live.rules);

  function update(id: string, patch: Partial<Rule & { enabled: boolean }>) {
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setReport(undefined);
    setSaved(undefined);
  }

  async function run() {
    setRunning(true);
    setSelected(undefined);
    try {
      const r = await api.testPolicy(draft());
      setReport(r);
      setRevealed(0);
      window.clearInterval(timer.current);
      // Reveal cells one by one: the whole suite runs in milliseconds, the animation is for people.
      timer.current = window.setInterval(() => {
        setRevealed((n) => {
          if (n >= r.results.length) window.clearInterval(timer.current);
          return n + 1;
        });
      }, 28);
    } finally {
      setRunning(false);
    }
  }

  async function save() {
    const p = await api.savePolicy(draft());
    setSaved(`Saved as live policy v${p.version}`);
    onSaved();
  }

  const done = report && revealed >= report.results.length;
  const leaks = report?.results.filter((r) => r.kind === "attack" && r.decision === "allow").length ?? 0;
  const detail = report?.results.find((r) => r.id === selected);

  return (
    <div className="studio">
      <section className="panel">
        <h2>Your rules</h2>
        <p className="sub">
          Written in plain English, enforced as the exact rule shown underneath. No AI decides at refund time. Turn a rule off and re-run the tests to
          see what it was protecting you from.
        </p>
        <div className="rules">
          {rules.map((r) => (
            <div className={`rule-row ${r.enabled ? "" : "off"}`} key={r.id}>
              <input className="switch" type="checkbox" checked={r.enabled} onChange={(e) => update(r.id, { enabled: e.target.checked })} aria-label={`Enable rule: ${r.source}`} />
              <div>
                <div className="en">{r.source}</div>
                <div className="dsl">{dsl(r)}</div>
              </div>
              <div className="row">
                {NUMERIC.filter((k) => typeof r[k] === "number").map((k) => (
                  <input
                    key={k}
                    type="number"
                    min={0}
                    value={r[k] as number}
                    disabled={!r.enabled}
                    aria-label={`${k} for ${r.source}`}
                    onChange={(e) => update(r.id, { [k]: Number(e.target.value) })}
                  />
                ))}
                <span className={`pill ${r.action}`}>{r.action}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="row" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>Test before going live</h2>
          <span className="spacer" />
          <button className="btn primary" onClick={run} disabled={running}>
            {running ? "Running…" : `Run ${report?.results.length ?? 50} tests`}
          </button>
          <button className="btn" onClick={save} disabled={!dirty || !done || leaks > 0} title={leaks ? "Fix the leaks before saving" : undefined}>
            Save as live
          </button>
        </div>
        <p className="sub">
          Published attacks and genuine customer requests, run against your draft rules. Nothing is refunded. {saved && <b style={{ color: "var(--allow)" }}>{saved}</b>}
        </p>

        {report && (
          <div className="summary">
            <div className="kpi">
              <div className="label">Attacks stopped</div>
              <div className="value" style={{ color: report.attacks.stopped === report.attacks.total ? "var(--allow)" : "var(--block)" }}>
                {done ? report.attacks.stopped : "…"}/{report.attacks.total}
              </div>
            </div>
            <div className="kpi">
              <div className="label">Genuine handled right</div>
              <div className="value">
                {done ? report.genuine.correct : "…"}/{report.genuine.total}
              </div>
              <div className="hint">{report.genuine.falseStops} wrongly stopped</div>
            </div>
            <div className="kpi">
              <div className="label">Median decision</div>
              <div className="value">{report.p50Micros} µs</div>
            </div>
          </div>
        )}

        <div className="cells" role="grid" aria-label="Test results">
          {(report?.results ?? Array.from({ length: 50 }, (_, i) => ({ id: String(i), kind: "genuine" as const, pass: true }))).map((r, i) => {
            const shown = report && i < revealed;
            const cls = !report ? "" : !shown ? "pending" : `${r.pass ? "pass" : "fail"} ${r.kind}`;
            return (
              <button
                key={r.id}
                className={`cell ${cls} ${selected === r.id ? "selected" : ""}`}
                onClick={() => report && setSelected(r.id)}
                aria-label={report ? `${r.id}` : "not run"}
                style={{ border: report ? undefined : 0 }}
              >
                {report ? r.id : ""}
              </button>
            );
          })}
        </div>
        <div className="legend">
          <span>
            <i style={{ background: "var(--block-bg)", border: "1px solid #f4c2bc" }} />
            attack stopped
          </span>
          <span>
            <i style={{ background: "var(--allow-bg)", border: "1px solid #bfe3cf" }} />
            genuine request handled right
          </span>
          <span>
            <i style={{ background: "#1f2937" }} />
            wrong outcome
          </span>
        </div>
        <div className="case-detail">
          {detail ? (
            <>
              <div className="row" style={{ marginBottom: 6 }}>
                <b className="mono">{detail.id}</b>
                <span className={`pill ${detail.decision}`}>{detail.decision}</span>
                <span style={{ color: detail.pass ? "var(--allow)" : "var(--block)", fontWeight: 600 }}>{detail.pass ? "expected" : "WRONG"}</span>
              </div>
              <div>{detail.title}</div>
              <div style={{ color: "var(--ink-2)", marginTop: 4 }}>{detail.reason}</div>
            </>
          ) : (
            <span style={{ color: "var(--ink-3)" }}>{report ? "Click a square to see the case." : "Run the tests to see every case."}</span>
          )}
        </div>
      </section>
    </div>
  );
}
