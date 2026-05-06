import type {
  DecisionGate,
  DecisionGateRequest,
  DecisionResolution,
  DecisionWithdrawReason,
} from "./types.js";

/**
 * Per-thread tracker for live decision-gate Promises. Tools awaiting a gate
 * register a resolver here; engine.resolveDecision/withdraw/expire wakes the
 * matching tool execution.
 *
 * V1 contract: a tool that calls ctx.requestDecision(...) blocks until the
 * gate transitions out of `pending`. Resolution returns the `DecisionResolution`.
 * Withdrawal throws `DecisionGateWithdrawnError`. Expiry throws
 * `DecisionGateExpiredError`. Tools should let these errors propagate so the
 * agent loop ends the turn cleanly.
 *
 * Restart-safe re-entrancy is a follow-up: when SuspendedTurnState is reloaded
 * from a persistent store, the tool will be re-invoked from scratch with
 * ctx.suspendedDecision populated, and this manager's first call will short-
 * circuit to return the stored resolution. Not implemented yet.
 */
export class DecisionGateWithdrawnError extends Error {
  constructor(public readonly gateId: string, public readonly reason: DecisionWithdrawReason) {
    super(`decision gate ${gateId} withdrawn (${reason})`);
    this.name = "DecisionGateWithdrawnError";
  }
}

export class DecisionGateExpiredError extends Error {
  constructor(public readonly gateId: string) {
    super(`decision gate ${gateId} expired`);
    this.name = "DecisionGateExpiredError";
  }
}

export class DecisionGateConflictError extends Error {
  constructor(public readonly gateId: string, public readonly currentStatus: string) {
    super(`decision gate ${gateId} not pending (status=${currentStatus})`);
    this.name = "DecisionGateConflictError";
  }
}

interface PendingGate {
  gate: DecisionGate;
  resolve: (resolution: DecisionResolution) => void;
  reject: (err: Error) => void;
}

export class GateManager {
  private pending = new Map<string, PendingGate>();
  private timers = new Map<string, NodeJS.Timeout>();

  register(gate: DecisionGate, onExpire: (gateId: string) => void): Promise<DecisionResolution> {
    return new Promise((resolve, reject) => {
      this.pending.set(gate.id, { gate, resolve, reject });
      if (gate.expiresAt) {
        const ms = gate.expiresAt - Date.now();
        if (ms <= 0) {
          this.expire(gate.id);
          onExpire(gate.id);
          return;
        }
        const timer = setTimeout(() => {
          this.expire(gate.id);
          onExpire(gate.id);
        }, ms);
        // unref so the timer doesn't keep the process alive in tests
        const t = timer as { unref?: () => void };
        if (typeof t.unref === "function") t.unref();
        this.timers.set(gate.id, timer);
      }
    });
  }

  resolve(gateId: string, resolution: DecisionResolution): boolean {
    const p = this.pending.get(gateId);
    if (!p) return false;
    this.cleanup(gateId);
    this.pending.delete(gateId);
    p.resolve(resolution);
    return true;
  }

  withdraw(gateId: string, reason: DecisionWithdrawReason): boolean {
    const p = this.pending.get(gateId);
    if (!p) return false;
    this.cleanup(gateId);
    this.pending.delete(gateId);
    p.reject(new DecisionGateWithdrawnError(gateId, reason));
    return true;
  }

  expire(gateId: string): boolean {
    const p = this.pending.get(gateId);
    if (!p) return false;
    this.cleanup(gateId);
    this.pending.delete(gateId);
    p.reject(new DecisionGateExpiredError(gateId));
    return true;
  }

  isPending(gateId: string): boolean {
    return this.pending.has(gateId);
  }

  pendingForThread(threadId: string): DecisionGate[] {
    const result: DecisionGate[] = [];
    for (const p of this.pending.values()) {
      if (p.gate.threadId === threadId) result.push(p.gate);
    }
    return result;
  }

  private cleanup(gateId: string): void {
    const timer = this.timers.get(gateId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(gateId);
    }
  }
}

export function isDecisionGateWithdrawn(err: unknown): err is DecisionGateWithdrawnError {
  return err instanceof DecisionGateWithdrawnError;
}

export function isDecisionGateExpired(err: unknown): err is DecisionGateExpiredError {
  return err instanceof DecisionGateExpiredError;
}

export interface GateContext {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  resumeKey: string;
}

export function deterministicGateId(ctx: GateContext): string {
  return `gate:${ctx.sessionId}:${ctx.threadId}:${ctx.queueItemId}:${ctx.resumeKey}`;
}

/**
 * Returns whether the engine should short-circuit `requestDecision` and
 * return a stored resolution from a replayed tool execution.
 *
 * Pure function — kept testable in isolation from Thread/Agent timing.
 */
export function shouldShortCircuit(args: {
  ctx: GateContext;
  suspendedDecision: { gateId: string; resolution?: DecisionResolution } | undefined;
}): { match: true; resolution: DecisionResolution } | { match: false } {
  const { ctx, suspendedDecision } = args;
  if (!suspendedDecision) return { match: false };
  const expectedId = deterministicGateId(ctx);
  if (suspendedDecision.gateId !== expectedId) return { match: false };
  if (!suspendedDecision.resolution) return { match: false };
  return { match: true, resolution: suspendedDecision.resolution };
}

export function fromRequest(req: DecisionGateRequest, gateCtx: GateContext): DecisionGate {
  if (!req.resumeKey) {
    throw new Error(
      "DecisionGateRequest.resumeKey is required for restart-safe gates. " +
        "Tools must supply a stable key per suspension point.",
    );
  }
  const now = Date.now();
  return {
    id: deterministicGateId(gateCtx),
    sessionId: gateCtx.sessionId,
    threadId: gateCtx.threadId,
    type: req.type,
    title: req.title,
    body: req.body,
    actions:
      req.actions ??
      (req.type === "approval"
        ? [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "deny", label: "Deny", style: "danger" },
          ]
        : []),
    expiresAt: req.expiresAt,
    status: "pending",
    context: req.context,
    origin: req.origin,
    createdAt: now,
    updatedAt: now,
  };
}
