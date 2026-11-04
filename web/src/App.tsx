import { useCallback, useEffect, useRef, useState } from "react";
import { api, usd, type AuditEntry, type Customer, type Policy } from "./api";
import { Approvals } from "./components/Approvals";
import { AuditLog, Kpis } from "./components/AuditLog";
import { ChatPanel } from "./components/ChatPanel";
import { PolicyStudio } from "./components/PolicyStudio";
import { Backtest } from "./components/Backtest";
import { Hero } from "./components/TryIt";
import { Impact } from "./components/Impact";
import { Integrate } from "./components/Integrate";
import { PhoneApprove } from "./components/Confirm";

type Tab = "overview" | "merchant" | "audit" | "policy";

/** /approve/<workspace>/<id>/<sig>: the merchant's phone, opened from a QR code. */
export function Root() {
  const m = /^\/approve\/([\w-]+\/[\w-]+\/[\w-]+)$/.exec(window.location.pathname);
  return m ? <PhoneApprove path={m[1]} /> : <App />;
}
type Status = Awaited<ReturnType<typeof api.status>>;

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [more, setMore] = useState<"history" | "connect" | "numbers">();
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
  const held = entries.filter((e) => e.status === "held").length;

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
            The attack
          </button>
          <button className="tab" role="tab" id="tab-merchant" aria-controls="panel" aria-selected={tab === "merchant"} onClick={() => setTab("merchant")}>
            Merchant{held > 0 && <span className="tab-count">{held}</span>}
          </button>
          <button
            className="tab"
            role="tab"
            id="tab-audit"
            aria-controls="panel"
            aria-selected={tab === "audit" || tab === "policy"}
            onClick={() => setTab("audit")}
          >
            Advanced
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
        {tab === "overview" && (
          <>
            <Hero
              entries={entries}
              onDone={refresh}
              onGoto={(t) => {
                if (t === "audit" || t === "policy") return setTab(t);
                setMore(t === "history" ? "history" : "connect");
                setTab("merchant");
              }}
              steps={{
                attacked: entries.some((e) => !e.sample && e.mode === "protected" && e.status !== "executed"),
                decided: entries.some((e) => !e.sample && (e.status === "approved" || e.status === "rejected")),
              }}
            />
            <Approvals entries={entries} customers={customers} onChange={refresh} />
            <section className="panel cta-history">
              <div>
                <h2>Try it on your own PayPal history</h2>
                <p className="sub" style={{ margin: 0 }}>Upload an activity export. See what an agent could have been talked into, and who refunds too often.</p>
              </div>
              <button
                className="btn primary"
                onClick={() => {
                  setMore("history");
                  setTab("merchant");
                }}
              >
                Upload my PayPal export
              </button>
            </section>
            <details className="panel live-agent">
              <summary>
                <b>Chat with the AI agent yourself</b> <span className="hint">live Gemini, free tier: 30–90 s per reply</span>
              </summary>
              <ChatPanel customers={customers} model={status?.ai.chat ?? null} onActivity={refresh} />
            </details>
          </>
        )}
        {tab === "merchant" && (
          <>
            <section className="panel headline">
              <div className="headline-num">{held}</div>
              <div>
                <h2 style={{ margin: 0 }}>{held === 1 ? "payout waits for you" : "payouts wait for you"}</h2>
                <p className="sub" style={{ margin: 0 }}>
                  {held
                    ? `${usd(entries.filter((e) => e.status === "held").reduce((t, e) => t + e.effectiveAmount, 0))} held. Everything else within your rules went straight out.`
                    : "Everything within your rules went straight out. Anything else lands here and on your phone."}
                </p>
              </div>
            </section>
            {held > 0 && <Approvals entries={entries} customers={customers} onChange={refresh} triage />}
            <nav className="subtabs" aria-label="More for merchants">
              {(
                [
                  ["history", "Your PayPal history"],
                  ["connect", "Connect your agent"],
                  ["numbers", "Your numbers"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} className={`subtab ${more === k ? "on" : ""}`} aria-expanded={more === k} onClick={() => setMore(more === k ? undefined : k)}>
                  {label}
                </button>
              ))}
            </nav>
            {more === "history" && policy && <Backtest draft={() => policy} names={Object.fromEntries([...customers, ...sampleNames].map((c) => [c.id, c.name]))} />}
            {more === "connect" && <Integrate onGoto={(t) => (t === "policy" ? setMore("history") : setTab("audit"))} />}
            {more === "numbers" && (
              <>
                {entries.some((e) => !e.sample) && <Kpis entries={entries} />}
                <Impact />
              </>
            )}
          </>
        )}
        {(tab === "audit" || tab === "policy") && (
          <nav className="subtabs" aria-label="Advanced">
            <button className={`subtab ${tab === "audit" ? "on" : ""}`} onClick={() => setTab("audit")}>
              Audit log
            </button>
            <button className={`subtab ${tab === "policy" ? "on" : ""}`} onClick={() => setTab("policy")}>
              Rules, red team &amp; test suite
            </button>
          </nav>
        )}
        {tab === "audit" && <AuditLog entries={entries} customers={[...customers, ...sampleNames.map((x) => ({ ...x, email: "" }))]} />}
        {tab === "policy" &&
          policy && (
            <PolicyStudio
              live={policy}
              onSaved={loadAll}
              aiModel={status?.ai.reasoning ?? null}
              names={Object.fromEntries([...customers, ...sampleNames].map((c) => [c.id, c.name]))}
            />
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
