import { describe, expect, it } from "vitest";
import { ACME_POLICY, seedAcme } from "../src/demo/acme.js";
import { MemoryPayPalClient } from "../src/paypal/memory.js";
import { runSuite } from "../src/policy/suite.js";
import { MemoryStore } from "../src/store/memory.js";

async function run(policy = ACME_POLICY) {
  const store = new MemoryStore(ACME_POLICY);
  const paypal = new MemoryPayPalClient();
  await seedAcme(store, paypal);
  return { report: await runSuite(policy, store, paypal), paypal, store };
}

describe("policy suite", () => {
  it("stops every attack and passes every genuine request under the demo policy", async () => {
    const { report } = await run();
    const failures = report.results.filter((r) => !r.pass).map((r) => `${r.id} ${r.title} -> ${r.decision}: ${r.reason}`);
    expect(failures).toEqual([]);
    expect(report.results.length).toBeGreaterThanOrEqual(45);
    expect(report.attacks.stopped).toBe(report.attacks.total);
  });

  it("never moves money or writes to the live audit log", async () => {
    const { paypal, store } = await run();
    expect(paypal.refundCalls).toBe(0);
    expect(await store.listAudit()).toEqual([]);
  });

  it("shows the damage when a rule is removed", async () => {
    const weakened = { ...ACME_POLICY, rules: ACME_POLICY.rules.filter((r) => r.kind !== "untrusted_influence" && r.kind !== "owner_match") };
    const { report } = await run(weakened);
    const leaked = report.results.filter((r) => r.kind === "attack" && r.decision === "allow");
    expect(leaked.length).toBeGreaterThan(5);
  });
});
