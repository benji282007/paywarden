import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { botTurn, forgetChat } from "./agent/bot.js";
import { seedAcme } from "./demo/acme.js";
import { SAMPLE_CUSTOMERS, seedSampleHistory } from "./demo/history.js";
import { runScenario, SCENARIOS, type ScenarioName } from "./demo/scenarios.js";
import { newWorkspaceId, Workspaces, type Workspace } from "./demo/workspaces.js";
import type { Guard, Session } from "./guard/guard.js";
import { askGrid } from "./grid/query.js";
import { allow } from "./http/ratelimit.js";
import type { LlmSet } from "./llm/index.js";
import { LlmError } from "./llm/gemini.js";
import type { ToolBackend } from "./mcp/backend.js";
import { mcpHandler } from "./mcp/proxy.js";
import type { SessionRegistry } from "./mcp/sessions.js";
import { compileRule } from "./policy/compile.js";
import { redTeam, rerunScenarios, type Scenario } from "./policy/redteam.js";
import { backtest } from "./policy/backtest.js";
import { backtestCsv } from "./policy/import.js";
import { isMoneyTool } from "./policy/evaluate.js";
import { buildSuite, runSuite } from "./policy/suite.js";
import type { Policy, ToolCall } from "./policy/types.js";
import { validPolicy } from "./policy/validate.js";
import type { PayPalClient } from "./paypal/types.js";
import type { AuditEntry, Store } from "./store/types.js";
import { handleWebhook, headersFrom } from "./webhooks/handle.js";

/** One fixed workspace: tests and single-user local runs. */
export interface SingleDeps {
  store: Store;
  paypal: PayPalClient & { simulated?: boolean };
  guard: Guard;
  sessions: SessionRegistry;
  backend: ToolBackend;
}

export interface AppOptions {
  webDist?: string;
  llms?: LlmSet;
  /** Enables /api/guard, which takes identity and provenance from the request body. Never on a public deploy. */
  devRoutes?: boolean;
  /** If set, the merchant API (/api/sessions*) requires `Authorization: Bearer <token>`. */
  merchantToken?: string;
}

// Held calls keep their context server-side for re-checks; the UI doesn't need it.
const publicEntry = ({ context: _context, ...rest }: AuditEntry) => rest;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const COOKIE = "pw_ws";

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function createApp(deps: ({ workspaces: Workspaces } | SingleDeps) & AppOptions) {
  const { webDist, llms = {}, merchantToken } = deps;
  const workspaces = "workspaces" in deps ? deps.workspaces : Workspaces.single(deps);
  const devRoutes = deps.devRoutes ?? !("workspaces" in deps);
  const app = express();
  app.set("trust proxy", 1); // Render terminates TLS in front of us; rate limits key on the real client IP.

  const ip = (req: Request) => req.ip ?? "unknown";
  const limit = (req: Request, bucket: string, max: number, windowMs: number) => {
    if (!allow(bucket, ip(req), max, windowMs)) throw new HttpError(429, "Slow down a little: this free demo limits how often that can run. Try again in a minute.");
  };

  /** The visitor's private demo shop, created (and seeded) on first visit. */
  async function workspace(req: Request, res: Response): Promise<Workspace> {
    if (workspaces.isSingle) return workspaces.get("local");
    let id = cookie(req, COOKIE);
    const valid = !!id && /^[A-Za-z0-9_-]{16,32}$/.test(id);
    if (!valid || !workspaces.peek(id!)) {
      limit(req, "workspace", 20, 60 * 60 * 1000);
      if (!valid) id = newWorkspaceId();
      res.cookie(COOKIE, id, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 24 * 60 * 60 * 1000, path: "/" });
    }
    const ws = workspaces.get(id!);
    await ws.ready;
    return ws;
  }

  // Webhook signatures are computed over the exact bytes, so this route takes the raw body.
  app.post(
    "/webhooks/paypal",
    express.text({ type: "*/*", limit: "256kb" }),
    wrap(async (req, res) => {
      const shared = workspaces.all()[0]?.paypal;
      if (!shared) return res.status(200).json({ ok: true, ignored: "no workspaces" });
      const outcome = await handleWebhook(
        async (refundId, captureId) => {
          for (const ws of workspaces.all()) {
            if ((refundId && (await ws.store.findAuditByRefundId(refundId))) || (captureId && (await ws.store.getLedger(captureId)))) return ws.store;
          }
          return undefined;
        },
        shared,
        headersFrom((n) => req.get(n)),
        req.body,
      );
      // 2xx even when unverified: a non-2xx makes PayPal retry for days.
      res.status(200).json(outcome);
    }),
  );

  // Backtest on the merchant's own PayPal activity export (CSV, up to ~5 MB).
  app.post(
    "/api/policy/backtest-csv",
    express.json({ limit: "6mb" }),
    wrap(async (req, res) => {
      limit(req, "backtest-csv", 10, 60_000);
      await workspace(req, res);
      const { policy, csv } = req.body as { policy?: Policy; csv?: string };
      if (!policy || !validPolicy(policy)) return res.status(400).json({ error: "Invalid policy" });
      if (typeof csv !== "string" || !csv.trim()) return res.status(400).json({ error: "Upload a PayPal activity export (CSV)." });
      try {
        res.json(backtestCsv(policy, csv));
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  app.use(express.json({ limit: "200kb" })); // the grid's structured schema can be ~50 kB

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get(
    "/api/status",
    wrap(async (req, res) => {
      const ws = await workspace(req, res);
      res.json({
        paypal: ws.paypal.simulated ? "offline-simulation" : "sandbox",
        tools: ws.backend.label,
        seedError: ws.seedError ?? null,
        ai: { reasoning: llms.reasoning?.model ?? null, chat: llms.chat?.model ?? null },
      });
    }),
  );

  app.get("/api/customers", wrap(async (req, res) => res.json(await (await workspace(req, res)).store.listCustomers())));
  app.get("/api/sample-customers", (_req, res) => {
    res.json(SAMPLE_CUSTOMERS);
  });
  app.get("/api/ledger", wrap(async (req, res) => res.json(await (await workspace(req, res)).store.listLedger())));
  app.get("/api/policy", wrap(async (req, res) => res.json(await (await workspace(req, res)).store.getPolicy())));
  // Policy CI. The suite is published so judges can read every case it runs.
  app.get("/api/policy/suite", wrap(async (req, res) => res.json(buildSuite(await (await workspace(req, res)).store.listLedger()))));
  app.post(
    "/api/policy/test",
    wrap(async (req, res) => {
      limit(req, "policy-test", 30, 60_000);
      const ws = await workspace(req, res);
      const draft = (req.body as { policy?: Policy }).policy;
      if (draft && !validPolicy(draft)) return res.status(400).json({ error: "Invalid policy" });
      res.json(await runSuite(draft ?? (await ws.store.getPolicy()), ws.store, ws.paypal));
    }),
  );
  app.post(
    "/api/policy/compile",
    wrap(async (req, res) => {
      if (!llms.reasoning) return res.status(503).json({ ok: false, explanation: "No AI key configured, so plain-English rules are unavailable." });
      limit(req, "compile", 6, 60_000);
      limit(req, "compile-day", 40, 24 * 60 * 60 * 1000);
      const ws = await workspace(req, res);
      const { english, existingIds } = req.body as { english?: string; existingIds?: string[] };
      res.json(await compileRule(llms.reasoning, String(english ?? ""), Array.isArray(existingIds) ? existingIds.map(String) : (await ws.store.getPolicy()).rules.map((r) => r.id)));
    }),
  );

  // "Attack my policy": AI-written attacks against the draft, run in a throwaway shop.
  app.post(
    "/api/policy/redteam",
    wrap(async (req, res) => {
      if (!llms.reasoning) return res.status(503).json({ error: "No AI key configured, so the AI red team is unavailable." });
      limit(req, "redteam", 3, 60_000);
      limit(req, "redteam-day", 20, 24 * 60 * 60 * 1000);
      const ws = await workspace(req, res);
      const draft = (req.body as { policy?: Policy }).policy;
      if (draft && !validPolicy(draft)) return res.status(400).json({ error: "Invalid policy" });
      res.json(await redTeam(llms.reasoning, draft ?? (await ws.store.getPolicy())));
    }),
  );
  // Backtest: replay this shop's past refund decisions under a draft policy.
  app.post(
    "/api/policy/backtest",
    wrap(async (req, res) => {
      limit(req, "backtest", 30, 60_000);
      const ws = await workspace(req, res);
      const draft = (req.body as { policy?: Policy }).policy;
      if (!draft || !validPolicy(draft)) return res.status(400).json({ error: "Invalid policy" });
      res.json(backtest(draft, await ws.store.listAudit()));
    }),
  );

  app.post(
    "/api/policy/redteam/rerun",
    wrap(async (req, res) => {
      limit(req, "redteam-rerun", 20, 60_000);
      const ws = await workspace(req, res);
      const { policy, scenarios } = req.body as { policy?: Policy; scenarios?: Scenario[] };
      if (policy && !validPolicy(policy)) return res.status(400).json({ error: "Invalid policy" });
      if (!Array.isArray(scenarios)) return res.status(400).json({ error: "Missing scenarios" });
      res.json({ scenarios: await rerunScenarios(policy ?? (await ws.store.getPolicy()), scenarios) });
    }),
  );

  app.put(
    "/api/policy",
    wrap(async (req, res) => {
      const ws = await workspace(req, res);
      const next = req.body as Policy;
      if (!validPolicy(next)) return res.status(400).json({ error: "Invalid policy" });
      const current = await ws.store.getPolicy();
      await ws.store.setPolicy({ version: current.version + 1, rules: next.rules });
      res.json(await ws.store.getPolicy());
    }),
  );

  app.get("/api/audit", wrap(async (req, res) => res.json((await (await workspace(req, res)).store.listAudit()).map(publicEntry))));
  app.get("/api/webhooks", wrap(async (req, res) => res.json(await (await workspace(req, res)).store.listWebhooks())));

  if (devRoutes) {
    // Tests and local debugging only: identity and provenance come from the request body here.
    app.post(
      "/api/guard",
      wrap(async (req, res) => {
        const ws = await workspace(req, res);
        const { call, session } = req.body as { call?: ToolCall; session?: Session };
        if (!call?.tool || typeof call.args !== "object" || !session?.customerId) {
          return res.status(400).json({ error: "Expected { call: {tool, args}, session: {customerId, ...} }" });
        }
        if (!isMoneyTool(call.tool)) return res.status(400).json({ error: `${call.tool} does not move money` });
        const entry = await ws.guard.handle(call, {
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
  }

  // Merchant API. A merchant's backend opens a session once it has authenticated the
  // customer, then points its agent at the returned MCP URL instead of PayPal's.
  const merchantOnly = (req: Request) => {
    if (merchantToken && req.get("authorization") !== `Bearer ${merchantToken}`) throw new HttpError(401, "Merchant token required");
  };
  app.post(
    "/api/sessions",
    wrap(async (req, res) => {
      merchantOnly(req);
      limit(req, "sessions", 30, 60 * 60 * 1000);
      const ws = await workspace(req, res);
      const { customerId, agentId, mode } = req.body as { customerId?: string; agentId?: string; mode?: "protected" | "unprotected" };
      if (!customerId || !(await ws.store.listCustomers()).some((c) => c.id === customerId)) return res.status(400).json({ error: "Unknown customerId" });
      const s = ws.sessions.create({ customerId, agentId, mode });
      res.json({ key: s.key, mode: s.mode, mcpPath: `/mcp/${ws.id}/${s.key}` });
    }),
  );
  app.post(
    "/api/sessions/:key/messages",
    wrap(async (req, res) => {
      merchantOnly(req);
      const ws = await workspace(req, res);
      const text = (req.body as { text?: unknown }).text;
      if (!ws.sessions.get(String(req.params.key)) || typeof text !== "string") return res.status(400).json({ error: "Expected a known session and { text }" });
      ws.sessions.addCustomerMessage(String(req.params.key), text);
      res.json({ ok: true });
    }),
  );

  // MCP clients don't carry the browser cookie, so the workspace is part of the URL.
  app.all(
    "/mcp/:ws/:key",
    wrap(async (req, res) => {
      const ws = workspaces.peek(String(req.params.ws));
      if (!ws) return res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unknown Paywarden session" }, id: null });
      await mcpHandler(ws.sessions, ws.guard, ws.backend, ws.store)(req, res);
    }),
  );

  app.post("/api/approvals/:id/approve", wrap(async (req, res) => {
    limit(req, "approve", 60, 60_000);
    res.json(publicEntry(await (await workspace(req, res)).guard.approve(String(req.params.id), "merchant")));
  }));
  app.post("/api/approvals/:id/reject", wrap(async (req, res) => {
    limit(req, "approve", 60, 60_000);
    res.json(publicEntry(await (await workspace(req, res)).guard.reject(String(req.params.id), "merchant")));
  }));

  // The AI support bot. Slow on Gemini's free tier (often 15-45 s per model step).
  app.post(
    "/api/chat",
    wrap(async (req, res) => {
      if (!llms.chat) return res.status(503).json({ error: "No AI key configured, so the support bot is unavailable." });
      limit(req, "chat-start", 30, 60 * 60 * 1000);
      const ws = await workspace(req, res);
      const { customerId, mode } = req.body as { customerId?: string; mode?: string };
      if (!customerId || !(await ws.store.listCustomers()).some((c) => c.id === customerId)) return res.status(400).json({ error: "Unknown customerId" });
      const s = ws.sessions.create({ customerId, mode: mode === "unprotected" ? "unprotected" : "protected" });
      res.json({ key: s.key, mode: s.mode, model: llms.chat.model });
    }),
  );
  app.post(
    "/api/chat/:key",
    wrap(async (req, res) => {
      if (!llms.chat) return res.status(503).json({ error: "No AI key configured" });
      limit(req, "chat", 6, 60_000);
      limit(req, "chat-day", 40, 24 * 60 * 60 * 1000);
      const ws = await workspace(req, res);
      const message = String((req.body as { message?: unknown }).message ?? "").trim().slice(0, 1000);
      if (!message) return res.status(400).json({ error: "Empty message" });
      res.json(await botTurn(llms.chat, ws, String(req.params.key), message));
    }),
  );

  // AG Grid AI Toolkit: plain-English question -> grid state.
  app.post(
    "/api/grid/query",
    wrap(async (req, res) => {
      if (!llms.reasoning) return res.status(503).json({ error: "No AI key configured, so plain-English questions are unavailable. Use the column filters." });
      limit(req, "grid-query", 8, 60_000);
      limit(req, "grid-query-day", 60, 24 * 60 * 60 * 1000);
      await workspace(req, res);
      const { schema, question } = req.body as { schema?: Record<string, unknown>; question?: string };
      if (!schema || typeof schema !== "object") return res.status(400).json({ error: "Missing grid schema" });
      res.json(await askGrid(llms.reasoning, schema, String(question ?? "")));
    }),
  );

  app.post(
    "/api/demo/scenario",
    wrap(async (req, res) => {
      limit(req, "scenario", 30, 60_000);
      const ws = await workspace(req, res);
      const { name, mode } = req.body as { name?: string; mode?: string };
      if (!name || !(name in SCENARIOS)) return res.status(400).json({ error: `Unknown scenario; try ${Object.keys(SCENARIOS).join(", ")}` });
      res.json({ steps: await runScenario(name as ScenarioName, mode === "unprotected" ? "unprotected" : "protected", ws) });
    }),
  );

  app.post(
    "/api/demo/reset",
    wrap(async (req, res) => {
      limit(req, "reset", 6, 60_000);
      const ws = await workspace(req, res);
      await seedAcme(ws.store, ws.paypal);
      if (ws.sampleHistory) await seedSampleHistory(ws.store);
      for (const key of ws.sessions.keys()) forgetChat(key);
      ws.sessions.clear();
      res.json({ ok: true });
    }),
  );

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // The built dashboard, when present (production and the hosted demo).
  if (webDist) {
    app.use("/assets", express.static(path.join(webDist, "assets"), { maxAge: "365d", immutable: true }));
    app.use(express.static(webDist));
    app.get(/^\/(?!api|mcp|webhooks|health).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (/^No held call/.test(err.message)) return res.status(404).json({ error: "That refund is no longer waiting for approval." });
    if (/^Unknown chat session/.test(err.message)) return res.status(404).json({ error: "This chat expired. Start a new one." });
    if (err instanceof LlmError) {
      console.error(`AI error: ${err.message.slice(0, 400)}`);
      const quota = err.status === 429 || /quota|exhaust|rate/i.test(err.message);
      return res.status(503).json({
        error: quota
          ? "The free AI tier is out of quota for now. The scripted agent and everything else still work."
          : "The free AI tier is slow or unavailable right now. Try again, or use the scripted agent.",
      });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong on our side." });
  });

  return app;
}
