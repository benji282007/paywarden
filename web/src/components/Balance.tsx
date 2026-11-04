import { useEffect, useState } from "react";
import { usd } from "../api";

/** Counts from `from` down to `to` once, so the money visibly leaves (or doesn't). */
function useCountdown(from: number, to: number) {
  const [v, setV] = useState(from);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return setV(to);
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / 1400);
      setV(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [from, to]);
  return v;
}

export function Lock() {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.6" fill="none" />
    </svg>
  );
}

/** The merchant's PayPal balance on one side of the comparison: draining, or locked. */
export function Balance({ start, moved, tone, note, consented }: { start: number; moved: number; tone: "off" | "on"; note: string; consented?: boolean }) {
  const value = useCountdown(start, start - moved);
  const state = consented ? "consented" : moved > 0 ? "draining" : "locked";
  return (
    <div className={`balance ${state} ${tone}`} aria-label={`Acme's PayPal balance: ${usd(start - moved)}`}>
      <div className="balance-label">Acme's PayPal balance</div>
      <div className="balance-row">
        <span className="balance-value">{usd(value)}</span>
        <span className="balance-delta">
          {moved > 0 ? (
            `−${usd(moved)}`
          ) : (
            <>
              <Lock /> $0 moved
            </>
          )}
        </span>
      </div>
      <div className="balance-note">{note}</div>
    </div>
  );
}
