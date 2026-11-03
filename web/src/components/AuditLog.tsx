import { useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi, GridState, ICellRendererParams } from "ag-grid-community";
import { req, usd, type AuditEntry, type Customer } from "../api";
import { gridTheme } from "../grid";
import { Evidence } from "./Approvals";

const STATUS_LABEL: Record<AuditEntry["status"], string> = {
  executed: "refunded",
  approved: "approved",
  held: "held",
  blocked: "blocked",
  rejected: "rejected",
  failed: "failed",
  simulated: "dry run",
};

const DECIDER: Record<AuditEntry["decidedBy"], string> = {
  none: "within policy",
  policy: "rule",
  provenance: "untrusted text",
  judge: "AI check",
};

const sum = (xs: AuditEntry[]) => xs.reduce((s, e) => s + e.effectiveAmount, 0);

export function Kpis({ entries }: { entries: AuditEntry[] }) {
  // Totals reflect this visit only; generated sample history is excluded.
  const protectedOnly = entries.filter((e) => e.mode === "protected" && !e.sample);
  const paid = protectedOnly.filter((e) => e.status === "executed" || e.status === "approved");
  const stopped = protectedOnly.filter((e) => e.status === "blocked" || e.status === "rejected");
  const held = protectedOnly.filter((e) => e.status === "held");
  const xs = protectedOnly.map((e) => e.latencyMs).sort((a, b) => a - b);
  const p50 = xs.length ? xs[Math.floor(xs.length / 2)] : 0;
  return (
    <div className="kpis">
      <div className="kpi">
        <div className="label">Refunded automatically</div>
        <div className="value">{usd(sum(paid))}</div>
        <div className="hint">{paid.length} refunds within your rules</div>
      </div>
      <div className="kpi">
        <div className="label">Waiting for you</div>
        <div className="value" style={{ color: "var(--hold)" }}>{usd(sum(held))}</div>
        <div className="hint">{held.length} held for approval</div>
      </div>
      <div className="kpi">
        <div className="label">Stopped</div>
        <div className="value" style={{ color: "var(--block)" }}>{usd(sum(stopped))}</div>
        <div className="hint">{stopped.length} blocked or rejected</div>
      </div>
      <div className="kpi">
        <div className="label">Decision time (median)</div>
        <div className="value">{protectedOnly.length === 0 ? "–" : p50 < 1 ? "<1 ms" : `${p50} ms`}</div>
        <div className="hint">no AI call on normal refunds; includes a live PayPal balance check</div>
      </div>
    </div>
  );
}

export function AuditLog({ entries, customers }: { entries: AuditEntry[]; customers: Customer[] }) {
  const [selected, setSelected] = useState<string>();
  const [gridApi, setGridApi] = useState<GridApi<AuditEntry>>();
  const chartRef = useRef<HTMLDivElement>(null);
  const names = useMemo(() => Object.fromEntries(customers.map((c) => [c.id, c.name])), [customers]);

  const columns = useMemo<ColDef<AuditEntry>[]>(
    () => [
      {
        field: "at",
        headerName: "Time",
        width: 130,
        sort: "desc",
        valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""),
      },
      {
        field: "status",
        headerName: "Outcome",
        width: 120,
        cellRenderer: (p: ICellRendererParams<AuditEntry>) =>
          p.value ? (
            <>
              <span className={`pill ${p.value}`}>{STATUS_LABEL[p.value as AuditEntry["status"]] ?? p.value}</span>
              {p.data?.sample && <span className="sample-tag">sample</span>}
            </>
          ) : null,
        filter: "agSetColumnFilter",
        enableRowGroup: true,
        chartDataType: "category",
      },
      { field: "customerId", headerName: "Customer", width: 130, valueFormatter: (p) => names[p.value] ?? p.value, filter: "agSetColumnFilter", enableRowGroup: true, chartDataType: "category" },
      {
        field: "effectiveAmount",
        headerName: "Amount",
        width: 110,
        type: "rightAligned",
        valueFormatter: (p) => (typeof p.value === "number" ? usd(p.value) : ""),
        filter: "agNumberColumnFilter",
        enableValue: true,
        chartDataType: "series",
      },
      {
        colId: "decidedBy",
        headerName: "Decided by",
        width: 140,
        // Group rows (when the grid is grouped) have no data.
        valueGetter: (p) => (!p.data ? undefined : p.data.mode === "unprotected" ? "no guard" : DECIDER[p.data.decidedBy]),
        filter: "agSetColumnFilter",
      },
      {
        colId: "reason",
        headerName: "Reason",
        flex: 1,
        minWidth: 240,
        valueGetter: (p) =>
          !p.data ? undefined : (p.data.hits.find((h) => h.action === p.data!.decision)?.reason ?? (p.data.mode === "unprotected" ? "No guard: agent's call recorded, no money moved" : "Within policy")),
        tooltipValueGetter: (p) => p.value,
      },
      { field: "paypal.refundId", headerName: "PayPal refund", width: 170, cellClass: "mono" },
      {
        field: "webhookConfirmed",
        headerName: "Webhook",
        width: 100,
        cellRenderer: (p: ICellRendererParams<AuditEntry>) => (p.data?.paypal?.refundId ? (p.value ? "✓ confirmed" : "pending") : ""),
      },
      { field: "sample", headerName: "Sample", width: 95, filter: "agSetColumnFilter", hide: true, valueGetter: (p) => !!p.data?.sample },
      { field: "mode", headerName: "Guard", width: 105, valueFormatter: (p) => (p.value === "protected" ? "on" : "off (dry run)"), filter: "agSetColumnFilter" },
    ],
    [names],
  );

  const current = entries.find((e) => e.id === selected);

  return (
    <section className="panel">
      <h2>Audit log</h2>
      <p className="sub">
        Every money-moving call your agent made, what Paywarden decided, and why. Click a row for the evidence, or ask in plain English. Rows tagged{" "}
        <span className="sample-tag">sample</span> are 30 days of generated history so the chart and queries have something to work with; your own activity appears on top.
      </p>
      <AskGrid gridApi={gridApi} names={names} />
      <div className="audit-layout">
        <div className="grid-wrap">
          <AgGridReact<AuditEntry>
            theme={gridTheme}
            rowData={entries}
            columnDefs={columns}
            getRowId={(p) => p.data.id}
            defaultColDef={{ sortable: true, resizable: true, filter: true }}
            autoGroupColumnDef={{ minWidth: 180 }}
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
            onRowClicked={(e) => setSelected(e.data?.id)}
            onGridReady={(e) => setGridApi(e.api)}
            onFirstDataRendered={(e) => {
              // A cross-filter chart: clicking a slice filters the grid to that outcome.
              if (!chartRef.current || chartRef.current.childElementCount) return;
              e.api.createCrossFilterChart({
                chartType: "donut",
                cellRange: { columns: ["status", "effectiveAmount"] },
                aggFunc: "sum",
                chartContainer: chartRef.current,
                chartThemeOverrides: { common: { title: { enabled: true, text: "Money by outcome ($)" }, legend: { position: "bottom" } } },
              });
            }}
            enableCharts
            cellSelection
            animateRows
            tooltipShowDelay={300}
            overlayNoRowsTemplate="No money-moving calls yet. Run the attack or a genuine refund above."
          />
        </div>
        <div className="chart-box" ref={chartRef} aria-label="Money by outcome chart" />
      </div>
      {current && (current.hits.length > 0 || current.sources?.length) ? (
        <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
          <Evidence entry={current} />
        </div>
      ) : null}
    </section>
  );
}

const EXAMPLES = ["Only blocked or held refunds over $20", "Total refunded amount by customer", "Show what the guard stopped for Sam"];

/** AG Grid AI Toolkit: the grid describes itself, the model answers with a grid state. */
function AskGrid({ gridApi, names }: { gridApi?: GridApi<AuditEntry>; names: Record<string, string> }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const initial = useRef<GridState>(undefined);

  async function ask(q: string) {
    if (!gridApi || !q.trim() || busy) return;
    setBusy(true);
    setNote(undefined);
    initial.current ??= gridApi.getState();
    try {
      const schema = gridApi.getStructuredSchema({
        exclude: ["pivot", "columnSizing"],
        columns: {
          status: {
            description: "Outcome: executed = refunded automatically, approved = refunded after merchant approval, held = waiting for approval, blocked, rejected, failed, simulated = dry run with the guard off",
            includeSetValues: true,
          },
          customerId: { description: `Customer id. ${Object.entries(names).map(([id, n]) => `${id} = ${n}`).join(", ")}`, includeSetValues: true },
          sample: { description: "true for generated sample history, false for live activity in this visit" },
          effectiveAmount: { description: "Refund amount in US dollars" },
          decidedBy: { description: "Which check decided", includeSetValues: true },
          mode: { description: "protected = Paywarden on, unprotected = guard off (dry run)", includeSetValues: true },
        },
      });
      const r = await req<{ state: GridState; explanation: string }>("POST", "/api/grid/query", { schema, question: q });
      gridApi.setState({ ...initial.current, ...r.state });
      setNote({ ok: true, text: r.explanation });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    if (gridApi && initial.current) gridApi.setState(initial.current);
    setNote(undefined);
    setQuestion("");
  }

  return (
    <div className="ask-grid">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <input className="chat-input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask the audit log, e.g. “total refunded by customer”" maxLength={300} disabled={busy} aria-label="Ask the audit log" />
        <button className="btn primary" disabled={busy || !question.trim() || !gridApi}>
          {busy ? "Asking…" : "Ask"}
        </button>
        <button type="button" className="btn" onClick={reset} disabled={busy}>
          Reset view
        </button>
      </form>
      <div className="row" style={{ flexWrap: "wrap", marginTop: 6 }}>
        {EXAMPLES.map((q) => (
          <button key={q} type="button" className="chip" disabled={busy} onClick={() => (setQuestion(q), void ask(q))}>
            {q}
          </button>
        ))}
      </div>
      <div aria-live="polite" className="ask-note" style={{ color: note && !note.ok ? "var(--block)" : undefined }}>
        {busy ? "AG Grid sent its schema; the AI is choosing filters (free tier: up to ~30 s)…" : note?.text}
      </div>
    </div>
  );
}
