// The hosted demo gives every visitor a private Acme Coffee (own rules, orders,
// approvals and audit log), so judges can't spend each other's refunds, weaken a
// shared policy, or approve someone else's held calls.

import { randomBytes } from "node:crypto";
import type { Guard } from "../guard/guard.js";
import type { ToolBackend } from "../mcp/backend.js";
import { SessionRegistry } from "../mcp/sessions.js";
import type { PayPalClient } from "../paypal/types.js";
import type { Store } from "../store/types.js";

export interface Workspace {
  id: string;
  store: Store;
  paypal: PayPalClient & { simulated?: boolean };
  guard: Guard;
  sessions: SessionRegistry;
  backend: ToolBackend;
  lastSeen: number;
  /** Resolves once the demo shop is seeded. Never rejects: failures land in seedError. */
  ready: Promise<void>;
  seeding: boolean;
  seedError?: string;
}

export type WorkspaceFactory = (id: string) => Workspace;

export const newWorkspaceId = () => randomBytes(12).toString("base64url");

export class Workspaces {
  private items = new Map<string, Workspace>();
  readonly isSingle: boolean = false;

  constructor(
    private readonly make: WorkspaceFactory,
    private readonly opts: { max: number; idleMs: number } = { max: 60, idleMs: 2 * 60 * 60 * 1000 },
  ) {}

  /** For tests and local single-user runs: every id maps to the same workspace. */
  static single(ws: Omit<Workspace, "id" | "lastSeen" | "ready" | "seeding"> & Partial<Workspace>): Workspaces {
    return new SingleWorkspace({ id: "local", lastSeen: Date.now(), ready: Promise.resolve(), seeding: false, ...ws });
  }

  get(id: string): Workspace {
    let ws = this.items.get(id);
    if (!ws) {
      this.evict();
      ws = this.make(id);
      this.items.set(id, ws);
    }
    ws.lastSeen = Date.now();
    return ws;
  }

  peek(id: string): Workspace | undefined {
    return this.items.get(id);
  }

  all(): Workspace[] {
    return [...this.items.values()];
  }

  private evict() {
    const now = Date.now();
    for (const [id, ws] of this.items) if (now - ws.lastSeen > this.opts.idleMs) this.items.delete(id);
    while (this.items.size >= this.opts.max) {
      const oldest = [...this.items.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      this.items.delete(oldest.id);
    }
  }
}

class SingleWorkspace extends Workspaces {
  override readonly isSingle = true;
  constructor(private readonly fixed: Workspace) {
    super(() => fixed, { max: 1, idleMs: Infinity });
  }
  override get() {
    return this.fixed;
  }
  override peek() {
    return this.fixed;
  }
  override all() {
    return [this.fixed];
  }
}
