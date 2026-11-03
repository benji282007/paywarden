import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ACME_POLICY, seedAcme } from "../src/demo/acme.js";
import { Workspaces, type Workspace } from "../src/demo/workspaces.js";
import { Guard } from "../src/guard/guard.js";
import { resetRateLimits } from "../src/http/ratelimit.js";
import { SimBackend } from "../src/mcp/backend.js";
import { SessionRegistry } from "../src/mcp/sessions.js";
import { MemoryPayPalClient } from "../src/paypal/memory.js";
import { MemoryStore } from "../src/store/memory.js";

function makeWorkspace(id: string): Workspace {
  const store = new MemoryStore(ACME_POLICY);
  const paypal = new MemoryPayPalClient();
  const ws: Workspace = { id, store, paypal, guard: new Guard(store, paypal), sessions: new SessionRegistry(), backend: new SimBackend(store), lastSeen: Date.now(), seeding: true, ready: Promise.resolve() };
  ws.ready = seedAcme(store, paypal).finally(() => (ws.seeding = false));
  return ws;
}

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  resetRateLimits();
  app = createApp({ workspaces: new Workspaces(makeWorkspace) });
});

const visitor = async () => {
  const res = await request(app).get("/api/status");
  return res.headers["set-cookie"]![0].split(";")[0];
};

describe("per-visitor demo workspaces", () => {
  it("gives each visitor a private shop and keeps it across requests", async () => {
    const a = await visitor();
    const b = await visitor();
    expect(a).not.toBe(b);

    // A's held refund isn't visible to (or approvable by) B.
    await request(app).post("/api/demo/scenario").set("cookie", a).send({ name: "large" });
    const held = (await request(app).get("/api/audit").set("cookie", a)).body.find((e: { status: string }) => e.status === "held");
    expect(held).toBeTruthy();
    expect((await request(app).get("/api/audit").set("cookie", b)).body).toEqual([]);
    expect((await request(app).post(`/api/approvals/${held.id}/approve`).set("cookie", b)).status).toBe(404);

    // Visitor A weakens their own policy...
    const policy = (await request(app).get("/api/policy").set("cookie", a)).body;
    await request(app).put("/api/policy").set("cookie", a).send({ ...policy, rules: [] });
    expect((await request(app).get("/api/policy").set("cookie", a)).body.rules).toHaveLength(0);
    // ...which does nothing to visitor B.
    expect((await request(app).get("/api/policy").set("cookie", b)).body.rules.length).toBe(ACME_POLICY.rules.length);

  });

  it("doesn't expose the body-trusting /api/guard route in production mode", async () => {
    const res = await request(app).post("/api/guard").set("cookie", await visitor()).send({ call: { tool: "create_refund", args: {} }, session: { customerId: "sam" } });
    expect(res.status).toBe(404);
  });

  it("rate limits expensive endpoints with a friendly message", async () => {
    const c = await visitor();
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await request(app).post("/api/demo/reset").set("cookie", c)).status;
    const res = await request(app).post("/api/demo/reset").set("cookie", c);
    expect(last).toBe(429);
    expect(res.body.error).toMatch(/free demo limits/);
  });

  it("requires the merchant token for the merchant API when one is configured", async () => {
    const guarded = createApp({ workspaces: new Workspaces(makeWorkspace), merchantToken: "s3cret" });
    const c = (await request(guarded).get("/api/status")).headers["set-cookie"]![0].split(";")[0];
    expect((await request(guarded).post("/api/sessions").set("cookie", c).send({ customerId: "sam" })).status).toBe(401);
    expect((await request(guarded).post("/api/sessions").set("cookie", c).set("authorization", "Bearer s3cret").send({ customerId: "sam" })).status).toBe(200);
  });
});
