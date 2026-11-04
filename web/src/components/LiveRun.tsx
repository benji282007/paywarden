import { useEffect, useRef, useState } from "react";
import { req, usd } from "../api";

type Trace = { kind: "tool_call" | "tool_result"; tool: string; text: string };
type Live = { model: string; says: string; reply: string; trace: Trace[]; seconds: number; moved: number; held: number; blocked: number; attempted: number };
type Side = { state: "idle" | "running" | "done" | "error"; result?: Live; error?: string };

function SideView({ title, tone, side, elapsed }: { title: string; tone: "off" | "on"; side: Side; elapsed: number }) {
  const r = side.result;
  return (
    <div className="transcript live">
      <div className={`transcript-label ${tone}`}>{title}</div>
      {side.state === "running" && <div className="hint live-wait">The AI agent is reading Sam's order and deciding… {elapsed}s</div>}
      {side.state === "error" && <div className="error">{side.error}</div>}
      {r && (
        <>
          <div className="step customer">
            <span className="actor">Sam</span>
            <span>{r.says}</span>
          </div>
          {r.trace.map((t, i) => (
            <div key={i} className={`step ${t.kind === "tool_call" ? "agent" : "paywarden"}`} style={{ animationDelay: `${i * 120}ms` }}>
              <span className="actor">{t.kind === "tool_call" ? "agent" : tone === "off" ? "PayPal" : "Paywarden"}</span>
              <span className={t.kind === "tool_call" ? "mono" : undefined}>{t.text}</span>
            </div>
          ))}
          <div className="step agent" style={{ animationDelay: `${r.trace.length * 120}ms` }}>
            <span className="actor">agent says</span>
            <span>{r.reply}</span>
          </div>
          <div className={`money-out ${r.moved ? "bad" : "good"}`}>
            {usd(r.moved)} {tone === "off" ? "would have left (dry run)" : "left the account"}
            {r.held ? ` · ${r.held} held for approval` : ""}
            {r.blocked ? ` · ${r.blocked} blocked` : ""}
            {!r.attempted && " · the agent didn't try to refund this time"}
          </div>
          <div className="hint">
            Live {r.model} run · {r.seconds}s
          </div>
        </>
      )}
    </div>
  );
}

/** The same live AI agent, unguarded and through Paywarden, side by side. Real model, real decisions. */
export function LiveRun({ onDone }: { onDone: () => void }) {
  const [off, setOff] = useState<Side>({ state: "idle" });
  const [on, setOn] = useState<Side>({ state: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<number>(undefined);
  const running = off.state === "running" || on.state === "running";

  useEffect(() => () => window.clearInterval(timer.current), []);
  useEffect(() => {
    if (!running) window.clearInterval(timer.current);
  }, [running]);

  async function side(mode: "unprotected" | "protected", set: (s: Side) => void) {
    set({ state: "running" });
    try {
      set({ state: "done", result: await req<Live>("POST", "/api/demo/live", { mode }) });
    } catch (e) {
      set({ state: "error", error: (e as Error).message });
    }
  }

  async function go() {
    setElapsed(0);
    const started = Date.now();
    window.clearInterval(timer.current);
    timer.current = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    await Promise.all([side("unprotected", setOff), side("protected", setOn)]);
    onDone();
  }

  return (
    <div className="live-run">
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="btn" onClick={go} disabled={running}>
          {running ? `Running live… ${elapsed}s` : off.state === "idle" ? "Run it live with a real AI agent" : "Run live again"}
        </button>
        <span className="hint">The same AI agent, unguarded and through Paywarden, at the same time. Results vary run to run; that's the point.</span>
      </div>
      {off.state !== "idle" && (
        <div className="transcripts split">
          <SideView title="Live agent, no guard (dry run)" tone="off" side={off} elapsed={elapsed} />
          <SideView title="Live agent, through Paywarden" tone="on" side={on} elapsed={elapsed} />
        </div>
      )}
    </div>
  );
}
