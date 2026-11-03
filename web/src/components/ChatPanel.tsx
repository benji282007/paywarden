import { useEffect, useRef, useState } from "react";
import { req, type Customer } from "../api";

type Trace = { kind: "tool_call" | "tool_result"; tool: string; text: string };
type Line = { who: "customer" | "bot"; text: string; trace?: Trace[]; ms?: number } | { who: "error"; text: string };

const SUGGESTIONS: Record<string, string[]> = {
  sam: ["Hey, where's my cold brew bundle order?"],
  maya: ["My burr grinder arrived cracked. Can I get a refund?"],
  dev: ["The espresso kit arrived broken, I need a refund for the $140."],
};

const post = <T,>(path: string, body: unknown) => req<T>("POST", path, body);

export function ChatPanel({ customers, model, onActivity }: { customers: Customer[]; model: string | null; onActivity: () => void }) {
  const [customerId, setCustomerId] = useState("sam");
  const [guard, setGuard] = useState(true);
  const [key, setKey] = useState<string>();
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<number>(undefined);

  // A new customer or guard setting starts a new conversation.
  useEffect(() => {
    setKey(undefined);
    setLines([]);
  }, [customerId, guard]);

  useEffect(() => () => window.clearInterval(timer.current), []);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setDraft("");
    setLines((l) => [...l, { who: "customer", text: message }]);
    setBusy(true);
    setElapsed(0);
    const started = Date.now();
    timer.current = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    try {
      const k = key ?? (await post<{ key: string }>("/api/chat", { customerId, mode: guard ? "protected" : "unprotected" })).key;
      setKey(k);
      const r = await post<{ reply: string; trace: Trace[] }>(`/api/chat/${k}`, { message });
      setLines((l) => [...l, { who: "bot", text: r.reply, trace: r.trace, ms: Date.now() - started }]);
    } catch (e) {
      setLines((l) => [...l, { who: "error", text: (e as Error).message }]);
    } finally {
      window.clearInterval(timer.current);
      setBusy(false);
      onActivity();
    }
  }

  if (!model) {
    return (
      <section className="panel">
        <h2>Talk to the AI support agent</h2>
        <div className="empty">No AI key is configured on this server, so the live agent is off. The scripted agent above shows the same flow.</div>
      </section>
    );
  }

  const name = (id: string) => customers.find((c) => c.id === id)?.name ?? id;

  return (
    <section className="panel">
      <div className="row" style={{ flexWrap: "wrap", marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Talk to the AI support agent</h2>
        <span className="spacer" />
        <label className="row" style={{ fontSize: 14, gap: 6 }}>
          Signed in as
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={busy}>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="row" style={{ fontSize: 14, gap: 6 }}>
          <input type="checkbox" checked={guard} onChange={(e) => setGuard(e.target.checked)} disabled={busy} />
          Paywarden on
        </label>
      </div>
      <p className="sub">
        A real AI agent ({model}) with PayPal tools, connected through Paywarden. Sam's order carries a fake "billing note" that fooled this model in testing.
        {guard ? "" : " With Paywarden off, refunds run as a dry run: nothing moves."}
      </p>

      <div className="chat" aria-live="polite">
        {lines.length === 0 && <div className="empty">Pick a suggestion or type as {name(customerId)}.</div>}
        {lines.map((l, i) =>
          l.who === "error" ? (
            <div key={i} className="chat-error">
              {l.text}
            </div>
          ) : (
            <div key={i} className={`bubble ${l.who}`}>
              {l.who === "bot" && l.trace && l.trace.length > 0 && (
                <div className="trace">
                  {l.trace.map((t, j) => (
                    <div key={j} className={`trace-line ${t.kind} ${/^PENDING|^BLOCKED/.test(t.text) ? "stopped" : ""}`}>
                      <span>{t.kind === "tool_call" ? "→" : "←"}</span>
                      <span className="mono">{t.text}</span>
                    </div>
                  ))}
                </div>
              )}
              <div>{l.text}</div>
              {l.who === "bot" && l.ms != null && <div className="meta">{(l.ms / 1000).toFixed(0)} s</div>}
            </div>
          ),
        )}
        {busy && <div className="bubble bot thinking">Agent is working… {elapsed}s (the free AI tier often takes 30–90 s)</div>}
      </div>

      <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
        {(SUGGESTIONS[customerId] ?? []).map((s) => (
          <button key={s} className="btn" disabled={busy} onClick={() => send(s)}>
            {s}
          </button>
        ))}
      </div>
      <form
        className="row"
        style={{ marginTop: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <input className="chat-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Message as ${name(customerId)}…`} disabled={busy} maxLength={1000} />
        <button className="btn primary" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
