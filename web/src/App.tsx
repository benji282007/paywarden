import { useCallback, useEffect, useState } from "react";
import { api, type AuditEntry, type Customer, type LedgerEntry, type Policy } from "./api";
import { Approvals } from "./components/Approvals";
import { AuditLog, Kpis } from "./components/AuditLog";
import { PolicyStudio } from "./components/PolicyStudio";
import { TryIt } from "./components/TryIt";

type Tab = "overview" | "policy";

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [mode, setMode] = useState<"sandbox" | "offline-simulation">();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [policy, setPolicy] = useState<Policy>();
  const [resetting, setResetting] = useState(false);

  const refresh = useCallback(async () => {
    const [a, l] = await Promise.all([api.audit(), api.ledger()]);
    setEntries(a);
    setLedger(l);
  }, []);

  const loadAll = useCallback(async () => {
    const [s, c, p] = await Promise.all([api.status(), api.customers(), api.policy()]);
    setMode(s.paypal);
    setCustomers(c);
    setPolicy(p);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void loadAll();
    const t = window.setInterval(() => void refresh().catch(() => {}), 2000);
    return () => window.clearInterval(t);
  }, [loadAll, refresh]);

  async function reset() {
    setResetting(true);
    try {
      await api.reset();
      await loadAll();
    } finally {
      setResetting(false);
    }
  }

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
        <nav className="tabs" role="tablist">
          <button className="tab" role="tab" aria-selected={tab === "overview"} onClick={() => setTab("overview")}>
            Overview
          </button>
          <button className="tab" role="tab" aria-selected={tab === "policy"} onClick={() => setTab("policy")}>
            Policy Studio
          </button>
        </nav>
        <span className="spacer" />
        {mode && (
          <span className={`badge ${mode === "sandbox" ? "sandbox" : "offline"}`} title={mode === "sandbox" ? "Refunds are real PayPal sandbox transactions" : "No PayPal keys configured: PayPal is simulated in memory"}>
            {mode === "sandbox" ? "PayPal sandbox · live" : "Offline simulation"}
          </span>
        )}
        <button className="btn ghost-light" onClick={reset} disabled={resetting}>
          {resetting ? "Resetting…" : "Reset demo"}
        </button>
      </header>
      <main>
        {tab === "overview" ? (
          <>
            <Kpis entries={entries} />
            <TryIt customers={customers} ledger={ledger} onDone={refresh} />
            <Approvals entries={entries} customers={customers} onChange={refresh} />
            <AuditLog entries={entries} customers={customers} />
          </>
        ) : (
          policy && <PolicyStudio live={policy} onSaved={loadAll} />
        )}
      </main>
    </>
  );
}
