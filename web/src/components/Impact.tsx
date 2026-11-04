import { useState } from "react";

// Measured, not assumed: on the unseen held-out set v3, the deterministic guard let 19 of 20
// genuine refund requests straight through (README, "Measured, not assumed").
const MEASURED_PASS_RATE = 0.95;

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const money = (n: number) => `$${fmt(n)}`;

function Field({ label, value, onChange, step, suffix }: { label: string; value: number; onChange: (n: number) => void; step?: number; suffix?: string }) {
  return (
    <label className="calc-field">
      <span>{label}</span>
      <span className="calc-input">
        <input type="number" min={0} step={step ?? 1} value={value} onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))} />
        {suffix && <em>{suffix}</em>}
      </span>
    </label>
  );
}

/** What turning on agent refunds safely is worth to a shop, from its own numbers. */
export function Impact() {
  const [orders, setOrders] = useState(3000);
  const [rate, setRate] = useState(5);
  const [avg, setAvg] = useState(35);
  const [minutes, setMinutes] = useState(6);
  const [wage, setWage] = useState(25);

  const requests = orders * (rate / 100);
  const reviewedToday = requests; // the safe default without a guard: a person checks every agent refund
  const reviewedWith = requests * (1 - MEASURED_PASS_RATE);
  const hoursSaved = ((reviewedToday - reviewedWith) * minutes) / 60;
  const moneyMoved = requests * avg;

  return (
    <section className="panel impact">
      <h2>What it's worth to your shop</h2>
      <p className="sub">
        Without a guard, the only safe way to let an AI agent refund is to have a person check every refund. With Paywarden, genuine refunds go straight out
        and only the risky ones wait. Change the numbers to match your shop.
      </p>
      <div className="calc">
        <div className="calc-inputs">
          <Field label="Orders per month" value={orders} onChange={setOrders} step={100} />
          <Field label="Orders with a refund request" value={rate} onChange={setRate} step={0.5} suffix="%" />
          <Field label="Average refund" value={avg} onChange={setAvg} suffix="$" />
          <Field label="Minutes to review one refund" value={minutes} onChange={setMinutes} />
          <Field label="Cost of an hour of support time" value={wage} onChange={setWage} suffix="$" />
        </div>
        <div className="calc-out">
          <div className="kpi">
            <div className="label">Support hours saved each month</div>
            <div className="value">{fmt(hoursSaved)}</div>
            <div className="hint">{money(hoursSaved * wage)} of support time</div>
          </div>
          <div className="kpi">
            <div className="label">Refunds checked by a person</div>
            <div className="value">
              {fmt(reviewedWith)} <span className="of">instead of {fmt(reviewedToday)}</span>
            </div>
            <div className="hint">{Math.round(MEASURED_PASS_RATE * 100)}% of genuine requests pass automatically (measured on unseen test data)</div>
          </div>
          <div className="kpi">
            <div className="label">Money your agent moves each month</div>
            <div className="value">{money(moneyMoved)}</div>
            <div className="hint">every dollar checked: who asked, whose order, ledger, limits</div>
          </div>
        </div>
      </div>
    </section>
  );
}
