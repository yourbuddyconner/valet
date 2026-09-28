/**
 * The `WorkflowEngineDeps` port (Phase 5 plan decision 15) — the sliver of
 * `@valet/engine`'s Workflow Caller Contract the interpreter and node
 * executors are allowed to touch. Interface only this task; implemented
 * over `EngineHost` in `packages/api/src/workflows/engine-deps.ts` (Task
 * 10) and stubbed for unit tests here.
 *
 * Deliberately narrower than the engine's own `CreateSessionOptions` /
 * `PromptOptions` — workflow nodes never need workspace wiring, channel
 * targets, or queue-mode steering beyond what the session/wait/approval
 * executors (Tasks 5, 7) require.
 */

import type { QueueMode, SessionPurpose, SubmissionResult } from '@valet/engine';
import type { TSchema } from 'typebox';
import type { ToolCredentialMode } from './dag/nodes.js';

export interface WorkflowCreateSessionOptions {
  id: string;
  title?: string;
  purpose: SessionPurpose;
}

export interface WorkflowPromptOptions {
  /** Idempotent admission key: `workflow:{runId}:{nodeId}[:{iteration}][:repair]`. */
  dispatchId: string;
  model?: string;
  queueMode?: QueueMode;
}

export interface WorkflowPromptReceipt {
  threadId: string;
  queueItemId: string;
}

export interface WorkflowAwaitResultOptions {
  resultSchema?: TSchema;
}

export interface WorkflowLlmCompleteRequest {
  /** Identifies the run whose org model catalog resolves the model spec. */
  runId: string;
  model: string;
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * Portable, provider-agnostic shape — deliberately not pi-ai's own `Usage`
 * type (this package depends only on `@valet/engine` and `@sinclair/
 * typebox`; the API-side implementation maps whatever the real provider
 * SDK returns into this). Required, not optional, on the result it lives
 * in: an `llmComplete` implementation that can't fill this in is a real
 * gap, and making it required means the type system catches a silently-
 * dropped-usage regression at compile time instead of an unnoticed cost
 * dimension that goes missing until someone asks where the money went.
 */
export interface WorkflowLlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface WorkflowLlmCompleteResult {
  text: string;
  usage: WorkflowLlmUsage;
}

export interface WorkflowPromptOrchestratorOptions {
  /** Idempotent admission key: `workflow:{runId}:{nodeId}[:{iteration}][:repair]`. */
  dispatchId: string;
  /**
   * Always `'followup'` — internal workflow signals must never steer-abort
   * the orchestrator's live turn (Phase 4 rule). The field is still
   * threaded through explicitly (rather than hardcoded by the
   * implementation) so callers can see the invariant at the call site.
   */
  queueMode: 'followup';
  ownerHint: { ownerType: string; ownerId: string };
}

export interface WorkflowPromptOrchestratorResult {
  sessionId: string;
  threadId: string;
  queueItemId: string;
}

export interface WorkflowInvokeActionRequest {
  service: string;
  action: string;
  params: Record<string, unknown>;
  /** Idempotency key. Deterministic per the tool executor's dispatch (decision 6: `workflow:{runId}:{nodeId}[:{iteration}]`). */
  invocationId: string;
  /**
   * `ToolNode.credential`, forwarded unchanged. Absent means the node
   * selected no identity, and the implementation keeps its default
   * precedence. An implementation that receives `'app'` MUST resolve the
   * installed application's identity or fail the invocation — a fallback to
   * a person's credential would make the action act as that person.
   */
  credential?: ToolCredentialMode;
  /** Host-internal single-invocation authorization (spec §1). Set by the
   * tool executor only when it holds an approved, unconsumed resolution
   * signal for exactly this invocation. Never crosses an HTTP boundary. */
  approval?: { resolvedBy: string; note?: string };
}

export type WorkflowInvokeActionResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string }
  | { ok: false; requiresApproval: true; riskLevel?: string; provenance?: string };

/**
 * Engine surface available to node executors and the interpreter's cancel
 * path. All calls are idempotent by the ids the caller supplies (session
 * id, dispatchId) — re-issuing after a crash-between-dispatch-and-checkpoint
 * must return the original effect, never a duplicate or an error.
 */
export interface WorkflowEngineDeps {
  /** Idempotent by `opts.id`: creating an already-existing session returns it unchanged. */
  createSession(opts: WorkflowCreateSessionOptions): Promise<{ id: string }>;

  /** Idempotent by `opts.dispatchId`: a duplicate dispatch returns the original receipt. */
  prompt(sessionId: string, text: string, opts: WorkflowPromptOptions): Promise<WorkflowPromptReceipt>;

  /** Resumable: returns immediately for an already-settled submission. */
  awaitResult(
    sessionId: string,
    threadId: string,
    queueItemId: string,
    opts?: WorkflowAwaitResultOptions,
  ): Promise<SubmissionResult>;

  /** Withdraws in-flight engine work for a run being cancelled. */
  abort(sessionId: string, threadId: string, queueItemId?: string): Promise<void>;

  /** Non-blocking settlement check, used by the lost-wake sweep (Task 8). */
  isSettled(sessionId: string, queueItemId: string): Promise<boolean>;

  /**
   * The `llm` node's (Task 3) sole external call — a single, non-durable
   * completion over pi-ai's `getModel` + `completeSimple`. No receiver
   * handle to dedup against (unlike `prompt`'s `dispatchId`), so this is
   * at-least-once per the run-host spec: the executor's intent checkpoint
   * narrows the duplicate window, and one duplicate billed call on a
   * crash-after-dispatch is the accepted cost. Implementations MAY throw on
   * model/transport errors (pi-ai's `completeSimple` does) — the `llm`
   * executor treats a throw as a node failure, so callers need no separate
   * error variant on the result.
   */
  llmComplete(req: WorkflowLlmCompleteRequest): Promise<WorkflowLlmCompleteResult>;

  /**
   * The `thread` node's (Task 5) dispatch primitive — resolves
   * `opts.ownerHint`'s orchestrator session and submits `prompt` as a
   * followup (internal signals must never steer-abort the assistant's live
   * turn). Idempotent by `opts.dispatchId`, exactly like `prompt`: a
   * duplicate dispatch after a crash-before-receipt-persisted must return
   * the original receipt. `awaitResult`/`abort`/`isSettled` are reused
   * unchanged for the resulting submission — they're session-agnostic.
   */
  promptOrchestrator(prompt: string, opts: WorkflowPromptOrchestratorOptions): Promise<WorkflowPromptOrchestratorResult>;

  /**
   * The `tool` node's (Task 4) dispatch primitive. This phase's
   * implementation is a stub (decision 3: no integrations are connected
   * until the Phase 6 plugin system lands) — but the contract below binds
   * the Phase 6 implementer: `invocationId` is deterministic (the tool
   * executor derives it from `runId`/`nodeId`/`iteration`, decision 6), and
   * a dedup-capable receiver MUST return the *original* result for a
   * duplicate `invocationId` rather than re-invoking the action or
   * erroring — the same at-most-once-effect contract `prompt`'s
   * `dispatchId` gives the session executor.
   */
  invokeAction(req: WorkflowInvokeActionRequest): Promise<WorkflowInvokeActionResult>;

  /**
   * The `workflow` node's definition lookup (batch-fanout design decision
   * 1). Resolves `workflowId` to its current definition snapshot ONLY when
   * the workflow belongs to `owner` — an id belonging to someone else
   * resolves `null`, indistinguishable from a missing one. Optional
   * because definition storage lives host-side: a host that does not wire
   * it gets a loud per-node failure from the executor, never a silent
   * skip. Starting the child run needs no engine method — the executor
   * enqueues durably through the `WorkflowStore` itself.
   */
  resolveWorkflow?(
    workflowId: string,
    owner: { ownerType: string; ownerId: string } | undefined,
  ): Promise<{ definition: unknown; definitionVersionId: string } | null>;
}
