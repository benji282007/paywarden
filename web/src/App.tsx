import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AuditEntry, type Customer, type Policy } from "./api";
import { Approvals } from "./components/Approvals";
import { AuditLog, Kpis } from "./components/AuditLog";
import { ChatPanel } from "./components/ChatPanel";
import { PolicyStudio } from "./components/PolicyStudio";
import { Hero } from "./components/TryIt";
import { Impact } from "./components/Impact";

type Tab = "overview" | "policy";
type Status = Awaited<ReturnType<typeof api.status>>;

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [status, setStatus] = useState<Status>();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sampleNames, setSampleNames] = useState<{ id: string; name: string }[]>([]);
  const [policy, setPolicy] = useState<Policy>();
  const [loadError, setLoadError] = useState<string>();
  const [resetting, setResetting] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    // Never stack requests: on a cold free host one poll can take longer than the interval.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setEntries(await api.audit());
    } finally {
      inFlight.current = false;
    }
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [s, c, p, sc] = await Promise.all([api.status(), api.customers(), api.policy(), api.sampleCustomers()]);
      setStatus(s);
      setCustomers(c);
      setSampleNames(sc);
      setPolicy(p);
      setLoadError(undefined);
      await refresh();
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [refresh]);

  useEffect(() => {
    void loadAll();
    const t = window.setInterval(() => {
      if (!document.hidden) void refresh().catch(() => {});
    }, 3000);
    return () => window.clearInterval(t);
  }, [loadAll, refresh]);

  async function reset() {
    setResetting(true);
    try {
      await api.reset();
      await loadAll();
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setResetting(false);
    }
  }

  const sandbox = status?.paypal === "sandbox";

  return (
    <>
      <header className="topbar">
        <div className="logo">
          <svg viewBox="0 0 32 32" aria-hidden>
            <path d="M16 2 4 7v8c0 7.4 5.1 13.4 12 15 6.9-1.6 12-7.6 12-15V7z" fill="#fff" />
            <path d="m11 16 4 4 7-8" stroke="#113a5c" strokeWidth="3" fill="none" />
          </svg>
          Paywarden
        </div>
        <span className="shop">for Acme Coffee</span>
        <nav className="tabs" role="tablist" aria-label="Sections">
          <button className="tab" role="tab" id="tab-overview" aria-controls="panel" aria-selected={tab === "overview"} onClick={() => setTab("overview")}>
            Overview
          </button>
          <button className="tab" role="tab" id="tab-policy" aria-controls="panel" aria-selected={tab === "policy"} onClick={() => setTab("policy")}>
            Policy Studio
          </button>
        </nav>
        <span className="spacer" />
        <div className="topbar-actions">
          {status && (
            <span
              className={`badge ${sandbox ? "sandbox" : "offline"}`}
              title={sandbox ? "Refunds are real PayPal sandbox transactions" : (status.seedError ?? "No PayPal keys configured: PayPal is simulated in memory")}
            >
              {sandbox ? "PayPal sandbox · live" : "Offline simulation"}
            </span>
          )}
          <button className="btn ghost-light" onClick={reset} disabled={resetting}>
            {resetting ? "Resetting…" : "Reset demo"}
          </button>
        </div>
      </header>
      <main id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {loadError && (
          <div className="banner error" role="alert">
            {loadError}{" "}
            <button className="btn" onClick={() => void loadAll()}>
              Retry
            </button>
          </div>
        )}
        {status?.seedError && <div className="banner warn">{status.seedError}</div>}
        {tab === "overview" ? (
          <>
            <Hero
              onDone={refresh}
              steps={{
                attacked: entries.some((e) => !e.sample && e.mode === "protected" && e.status !== "executed"),
                decided: entries.some((e) => !e.sample && (e.status === "approved" || e.status === "rejected")),
              }}
            />
            <Approvals entries={entries} customers={customers} onChange={refresh} />
            {entries.some((e) => !e.sample) && <Kpis entries={entries} />}
            <Impact />
            <AuditLog entries={entries} customers={[...customers, ...sampleNames.map((x) => ({ ...x, email: "" }))]} />
            <details className="panel live-agent">
              <summary>
                <b>Try the real AI agent</b> <span className="hint">live Gemini on the free tier: replies take 30–90 s</span>
              </summary>
              <ChatPanel customers={customers} model={status?.ai.chat ?? null} onActivity={refresh} />
            </details>
          </>
        ) : (
          policy && (
            <PolicyStudio
              live={policy}
              onSaved={loadAll}
              aiModel={status?.ai.reasoning ?? null}
              names={Object.fromEntries([...customers, ...sampleNames].map((c) => [c.id, c.name]))}
            />
          )
        )}
        <footer className="footer">
          Paywarden · open source (MIT) ·{" "}
          <a href="https://github.com/benji282007/paywarden" target="_blank" rel="noreferrer">
            code and measured results
          </a>{" "}
          · PayPal sandbox · built for the PayPal AI Hackathon
        </footer>
      </main>
    </>
  );
}
