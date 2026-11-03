import { describe, expect, it } from "vitest";
import { ACME_POLICY } from "../src/demo/acme.js";
import { seedSampleHistory } from "../src/demo/history.js";
import { backtest } from "../src/policy/backtest.js";
import type { Policy } from "../src/policy/types.js";
import { MemoryStore } from "../src/store/memory.js";

async function history() {
  const store = new MemoryStore(ACME_POLICY);
  await seedSampleHistory(store);
  return store.listAudit();
}
const withRule = (id: string, patch: Record<string, unknown>): Policy => ({ ...ACME_POLICY, rules: ACME_POLICY.rules.map((r) => (r.id === id ? ({ ...r, ...patch } as typeof r) : r)) });

describe("policy backtest", () => {
  it("replaying today's rules changes nothing", async () => {
    const r = backtest(ACME_POLICY, await history());
    expect(r.replayed).toBeGreaterThan(60);
    expect(r.changed).toEqual([]);
  });

  it("raising the approval cap shows which past holds would have gone straight out", async () => {
    const r = backtest(withRule("cap-50", { max: 150 }), await history());
    expect(r.newlyAllowed.count).toBeGreaterThan(0);
    expect(r.newlyStopped.count).toBe(0);
    expect(r.changed.every((c) => c.before === "hold" && c.after === "allow")).toBe(true);
  });

  it("tightening the cap shows which past refunds would now wait for approval", async () => {
    const r = backtest(withRule("cap-50", { max: 20 }), await history());
    expect(r.newlyStopped.count).toBeGreaterThan(0);
    expect(r.newlyStopped.amount).toBeGreaterThan(0);
    expect(r.changed.find((c) => c.after === "hold")!.reason).toMatch(/exceeds the \$20.00 limit/);
  });

  it("switching off the who-asked rule shows the attacks it was stopping", async () => {
    const r = backtest({ ...ACME_POLICY, rules: ACME_POLICY.rules.filter((x) => x.id !== "asked") }, await history());
    expect(r.newlyAllowed.count).toBeGreaterThan(0);
  });
});
