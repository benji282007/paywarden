import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { usd, type AuditEntry, type Customer } from "../api";
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
  const protectedOnly = entries.filter((e) => e.mode === "protected");
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
        <div className="hint">no AI call on normal refunds</div>
      </div>
    </div>
  );
}

export function AuditLog({ entries, customers }: { entries: AuditEntry[]; customers: Customer[] }) {
  const [selected, setSelected] = useState<string>();
  const names = useMemo(() => Object.fromEntries(customers.map((c) => [c.id, c.name])), [customers]);

  const columns = useMemo<ColDef<AuditEntry>[]>(
    () => [
      {
        field: "at",
        headerName: "Time",
        width: 130,
        sort: "desc",
        valueFormatter: (p) => new Date(p.value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      },
      {
        field: "status",
        headerName: "Outcome",
        width: 120,
        cellRenderer: (p: ICellRendererParams<AuditEntry>) => <span className={`pill ${p.value}`}>{STATUS_LABEL[p.value as AuditEntry["status"]]}</span>,
        filter: "agSetColumnFilter",
      },
      { field: "customerId", headerName: "Customer", width: 130, valueFormatter: (p) => names[p.value] ?? p.value, filter: "agSetColumnFilter" },
      { field: "effectiveAmount", headerName: "Amount", width: 110, type: "rightAligned", valueFormatter: (p) => usd(p.value), filter: "agNumberColumnFilter" },
      {
        colId: "decidedBy",
        headerName: "Decided by",
        width: 140,
        valueGetter: (p) => (p.data?.mode === "unprotected" ? "no guard" : DECIDER[p.data!.decidedBy]),
        filter: "agSetColumnFilter",
      },
      {
        colId: "reason",
        headerName: "Reason",
        flex: 1,
        minWidth: 240,
        valueGetter: (p) => p.data?.hits.find((h) => h.action === p.data?.decision)?.reason ?? (p.data?.mode === "unprotected" ? "No guard: agent's call recorded, no money moved" : "Within policy"),
        tooltipValueGetter: (p) => p.value,
      },
      { field: "paypal.refundId", headerName: "PayPal refund", width: 170, cellClass: "mono" },
      {
        field: "webhookConfirmed",
        headerName: "Webhook",
        width: 100,
        cellRenderer: (p: ICellRendererParams<AuditEntry>) => (p.data?.paypal?.refundId ? (p.value ? "✓ confirmed" : "pending") : ""),
      },
      { field: "mode", headerName: "Guard", width: 105, valueFormatter: (p) => (p.value === "protected" ? "on" : "off (dry run)"), filter: "agSetColumnFilter" },
    ],
    [names],
  );

  const current = entries.find((e) => e.id === selected);

  return (
    <section className="panel">
      <h2>Audit log</h2>
      <p className="sub">Every money-moving call your agent made, what Paywarden decided, and why. Click a row for the evidence.</p>
      <div className="grid-wrap">
        <AgGridReact<AuditEntry>
          theme={gridTheme}
          rowData={entries}
          columnDefs={columns}
          getRowId={(p) => p.data.id}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
          onRowClicked={(e) => setSelected(e.data?.id)}
          enableCharts
          cellSelection
          animateRows
          tooltipShowDelay={300}
          overlayNoRowsTemplate="No money-moving calls yet. Try the attack or a genuine refund above."
        />
      </div>
      {current && (current.hits.length > 0 || current.sources?.length) ? (
        <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
          <Evidence entry={current} />
        </div>
      ) : null}
    </section>
  );
}
