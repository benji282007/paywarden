import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { buildSuite, runSuite } from "./policy/suite.js";
import type { Policy } from "./policy/types.js";
import { validPolicy } from "./policy/validate.js";
import { compileRule } from "./policy/compile.js";
import type { LlmSet } from "./llm/index.js";
import { Guard, type Session } from "./guard/guard.js";
import { isMoneyTool } from "./policy/evaluate.js";
import type { ToolCall } from "./policy/types.js";
import type { PayPalClient } from "./paypal/types.js";
import type { AuditEntry, Store } from "./store/types.js";
import { handleWebhook, headersFrom } from "./webhooks/handle.js";
import { seedAcme } from "./demo/acme.js";
import { runScenario, SCENARIOS, type ScenarioName } from "./demo/scenarios.js";
import { botTurn, forgetChat } from "./agent/bot.js";
import type { ToolBackend } from "./mcp/backend.js";
import { mcpHandler } from "./mcp/proxy.js";
import type { SessionRegistry } from "./mcp/sessions.js";

export interface AppDeps {
  store: Store;
  paypal: PayPalClient & { simulated?: boolean };
  guard: Guard;
  sessions: SessionRegistry;
  backend: ToolBackend;
}

// Held calls keep their context server-side for re-checks; the UI doesn't need it.
const publicEntry = ({ context: _context, ...rest }: AuditEntry) => rest;

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function createApp({ store, paypal, guard, sessions, backend, webDist, llms = {} }: AppDeps & { webDist?: string; llms?: LlmSet }) {
  const app = express();

  // Webhook signatures are computed over the exact bytes, so this route takes the raw body.
  app.post(
    "/webhooks/paypal",
    express.text({ type: "*/*", limit: "1mb" }),
    wrap(async (req, res) => {
      const outcome = await handleWebhook(store, paypal, headersFrom((n) => req.get(n)), req.body);
      // 2xx even when unverified: a non-2xx makes PayPal retry for days.
      res.status(200).json(outcome);
    }),
  );

  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/status", (_req, res) => {
    res.json({
      paypal: paypal.simulated ? "offline-simulation" : "sandbox",
      tools: backend.label,
      ai: { reasoning: llms.reasoning?.model ?? null, chat: llms.chat?.model ?? null },
    });
  });

  app.get("/api/customers", wrap(async (_req, res) => res.json(await store.listCustomers())));
  app.get("/api/ledger", wrap(async (_req, res) => res.json(await store.listLedger())));
  app.get("/api/policy", wrap(async (_req, res) => res.json(await store.getPolicy())));
  // Policy CI. The suite is published so judges can read every case it runs.
  app.get("/api/policy/suite", wrap(async (_req, res) => res.json(buildSuite(await store.listLedger()))));
  app.post(
    "/api/policy/test",
    wrap(async (req, res) => {
      const draft = (req.body as { policy?: Policy }).policy;
      if (draft && !validPolicy(draft)) return res.status(400).json({ error: "Invalid policy" });
      res.json(await runSuite(draft ?? (await store.getPolicy()), store, paypal));
    }),
  );
  app.post(
    "/api/policy/compile",
    wrap(async (req, res) => {
      if (!llms.reasoning) return res.status(503).json({ ok: false, explanation: "No AI key configured, so plain-English rules are unavailable." });
      const { english, existingIds } = req.body as { english?: string; existingIds?: string[] };
      res.json(await compileRule(llms.reasoning, String(english ?? ""), Array.isArray(existingIds) ? existingIds : (await store.getPolicy()).rules.map((r) => r.id)));
    }),
  );

  app.put(
    "/api/policy",
    wrap(async (req, res) => {
      const next = req.body as Policy;
      if (!validPolicy(next)) return res.status(400).json({ error: "Invalid policy" });
      const current = await store.getPolicy();
      await store.setPolicy({ version: current.version + 1, rules: next.rules });
      res.json(await store.getPolicy());
    }),
  );

  app.get("/api/audit", wrap(async (_req, res) => res.json((await store.listAudit()).map(publicEntry))));
  app.get("/api/webhooks", wrap(async (_req, res) => res.json(await store.listWebhooks())));

  // Direct guard entry point for the dashboard and tests; agents go through the MCP proxy.
  app.post(
    "/api/guard",
    wrap(async (req, res) => {
      const { call, session } = req.body as { call?: ToolCall; session?: Session };
      if (!call?.tool || typeof call.args !== "object" || !session?.customerId) {
        return res.status(400).json({ error: "Expected { call: {tool, args}, session: {customerId, ...} }" });
      }
      if (!isMoneyTool(call.tool)) return res.status(400).json({ error: `${call.tool} does not move money` });
      const entry = await guard.handle(call, {
        mode: session.mode === "unprotected" ? "unprotected" : "protected",
        agentId: session.agentId ?? "acme-support",
        customerId: session.customerId,
        conversationId: session.conversationId,
        untrusted: session.untrusted ?? [],
        trusted: session.trusted ?? [],
      });
      res.json(publicEntry(entry));
    }),
  );

  // The merchant's app opens a session once it has authenticated the customer, then
  // points its agent at the returned MCP URL instead of PayPal's MCP server.
  app.post(
    "/api/sessions",
    wrap(async (req, res) => {
      const { customerId, agentId, mode } = req.body as { customerId?: string; agentId?: string; mode?: "protected" | "unprotected" };
      if (!customerId || !(await store.listCustomers()).some((c) => c.id === customerId)) {
        return res.status(400).json({ error: "Unknown customerId" });
      }
      const s = sessions.create({ customerId, agentId, mode });
      res.json({ key: s.key, mode: s.mode, mcpPath: `/mcp/${s.key}` });
    }),
  );

  app.post("/api/sessions/:key/messages", (req, res) => {
    const text = (req.body as { text?: unknown }).text;
    if (!sessions.get(String(req.params.key)) || typeof text !== "string") {
      res.status(400).json({ error: "Expected a known session and { text }" });
      return;
    }
    sessions.addCustomerMessage(String(req.params.key), text);
    res.json({ ok: true });
  });

  app.all("/mcp/:key", wrap(mcpHandler(sessions, guard, backend)));

  app.post("/api/approvals/:id/approve", wrap(async (req, res) => res.json(publicEntry(await guard.approve(String(req.params.id), "merchant")))));
  app.post("/api/approvals/:id/reject", wrap(async (req, res) => res.json(publicEntry(await guard.reject(String(req.params.id), "merchant")))));

  // The AI support bot. Slow on Gemini's free tier (often 15-45 s per model step).
  app.post(
    "/api/chat",
    wrap(async (req, res) => {
      if (!llms.chat) return res.status(503).json({ error: "No AI key configured, so the support bot is unavailable." });
      const { customerId, mode } = req.body as { customerId?: string; mode?: string };
      if (!customerId || !(await store.listCustomers()).some((c) => c.id === customerId)) return res.status(400).json({ error: "Unknown customerId" });
      const s = sessions.create({ customerId, mode: mode === "unprotected" ? "unprotected" : "protected" });
      res.json({ key: s.key, mode: s.mode, model: llms.chat.model });
    }),
  );
  app.post(
    "/api/chat/:key",
    wrap(async (req, res) => {
      if (!llms.chat) return res.status(503).json({ error: "No AI key configured" });
      const message = String((req.body as { message?: unknown }).message ?? "").trim().slice(0, 1000);
      if (!message) return res.status(400).json({ error: "Empty message" });
      res.json(await botTurn(llms.chat, { store, guard, backend, sessions }, String(req.params.key), message));
    }),
  );

  app.post(
    "/api/demo/scenario",
    wrap(async (req, res) => {
      const { name, mode } = req.body as { name?: string; mode?: string };
      if (!name || !(name in SCENARIOS)) return res.status(400).json({ error: `Unknown scenario; try ${Object.keys(SCENARIOS).join(", ")}` });
      const steps = await runScenario(name as ScenarioName, mode === "unprotected" ? "unprotected" : "protected", { store, guard, backend, sessions });
      res.json({ steps });
    }),
  );

  app.post(
    "/api/demo/reset",
    wrap(async (_req, res) => {
      await seedAcme(store, paypal);
      sessions.clear();
      forgetChat();
      res.json({ ok: true, ledger: await store.listLedger() });
    }),
  );

  // The built dashboard, when present (production and the hosted demo).
  if (webDist) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api|mcp|webhooks|health).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = /^No held call/.test(err.message) ? 404 : 500;
    res.status(status).json({ error: err.message });
  });

  return app;
}
