import { useState } from "react";
import type { Customer, LedgerEntry } from "../api";

type Step = { actor: "customer" | "agent" | "paywarden"; text: string };
type Run = { title: string; off?: Step[]; on: Step[] };

const SCENARIOS: { name: string; title: string; split?: boolean }[] = [
  { name: "injection", title: "Hidden instruction in a delivery note", split: true },
  { name: "genuine", title: "Genuine $18 refund" },
  { name: "large", title: "Genuine $140 refund" },
  { name: "retry", title: "Agent retries a refund" },
  { name: "other", title: "Refund someone else's order" },
];

async function scenario(name: string, mode: "protected" | "unprotected"): Promise<Step[]> {
  const res = await fetch("/api/demo/scenario", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mode }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json.steps;
}

function Transcript({ steps, label, tone }: { steps: Step[]; label: string; tone: "off" | "on" }) {
  return (
    <div className="transcript">
      <div className={`transcript-label ${tone}`}>{label}</div>
      {steps.map((s, i) => (
        <div key={i} className={`step ${s.actor}`}>
          <span className="actor">{s.actor === "paywarden" ? (tone === "off" ? "proxy" : "Paywarden") : s.actor}</span>
          <span className={s.actor === "agent" ? "mono" : undefined}>{s.text}</span>
        </div>
      ))}
    </div>
  );
}

export function TryIt({ onDone }: { customers: Customer[]; ledger: LedgerEntry[]; onDone: () => void }) {
  const [run, setRun] = useState<Run>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  async function go(s: (typeof SCENARIOS)[number]) {
    setBusy(s.name);
    setError(undefined);
    try {
      const off = s.split ? await scenario(s.name, "unprotected") : undefined;
      const on = await scenario(s.name, "protected");
      setRun({ title: s.title, off, on });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="panel">
      <h2>Try it</h2>
      <p className="sub">
        A scripted support agent (no AI yet) talks to PayPal through Paywarden's MCP proxy. The attack also runs with the guard off as a dry run, so you can
        compare: no money moves on that side.
      </p>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {SCENARIOS.map((s) => (
          <button key={s.name} className={`btn ${s.split ? "primary" : ""}`} disabled={!!busy} onClick={() => go(s)}>
            {busy === s.name ? "Running…" : s.title}
          </button>
        ))}
      </div>
      {error && <p style={{ color: "var(--block)" }}>{error}</p>}
      {run && (
        <div className={`transcripts ${run.off ? "split" : ""}`}>
          {run.off && <Transcript steps={run.off} label="Guard off · dry run" tone="off" />}
          <Transcript steps={run.on} label={run.off ? "Guard on" : run.title} tone="on" />
        </div>
      )}
    </section>
  );
}
