import { Thread, isItemDrivenInProcess, resolveModelId as resolveSessionModel } from "./thread.js";
import { builtinTools } from "./builtin-tools/index.js";
import { decideReconciliation, type ReconcileContext } from "./submission.js";
import { buildCommandRegistry, type CommandRegistry } from "./commands/registry.js";
import { dispatchCommand } from "./commands/dispatch.js";
import { parseCommandArgs } from "./commands/args.js";
import { executeBuiltin } from "./commands/builtins.js";
import { invokeAction, type InvokeActionResult } from "./plugin-catalog.js";
import {
  GateManager,
  fromRequest,
  isDecisionGateWithdrawn,
  persistTerminalGate,
} from "./decision-gate.js";
import type {
  CommandDef,
  CommandSource,
  ResolvedCommand,
} from "./commands/types.js";
import type { SandboxAttachment, AttachmentStatus } from "./sandbox/attachment.js";
import type { PolicySandbox } from "./sandbox/policy.js";
import { NoCredentialsError, StaleAttemptError, ValidationError } from "./errors.js";
import {
  isReasoningLevel,
  parseReasoningLevel,
  REASONING_LEVELS,
  THREAD_REASONING_DISABLED,
  type ReasoningLevel,
} from "./reasoning.js";
import { detachedFromTrace, withSpan } from "./tracing.js";
import { recordCredentialRead } from "./metrics.js";
import { encodeToolOutput } from "./tool-output.js";
import type { Model } from "@earendil-works/pi-ai/compat";
import type {
  BusEvent,
  ChannelTarget,
  CommandResultEntry,
  MessageEntry,
  CreateSessionOptions,
  CredentialOwner,
  CredentialProvider,
  DecisionGate,
  DecisionGateRequest,
  DecisionResolution,
  DecisionWithdrawReason,
  EngineEvent,
  MessageQuery,
  Principal,
  PromptAuthor,
  PromptContent,
  PromptOptions,
  PromptReceipt,
  ProviderBundle,
  QueueItem,
  RepoInstructions,
  RoleSpec,
  Sandbox,
  SessionData,
  SessionEntry,
  SessionStartRef,
  SkillSource,
  StoredCredential,
  ThreadData,
  ToolContext,
  ToolDef,
  WriteFence,
} from "./types.js";
import { credentialSecret } from "./types.js";

let nextId = 1;
function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

function submissionsByThread(items: readonly QueueItem[]): Map<string, QueueItem[]> {
  const grouped = new Map<string, QueueItem[]>();
  for (const item of items) {
    const threadItems = grouped.get(item.threadId) ?? [];
    threadItems.push(item);
    grouped.set(item.threadId, threadItems);
  }
  return grouped;
}

/**
 * Extract the plain leading text of a prompt for slash-command detection.
 * String content is itself; object content uses its `text`; a `SignalContent`
 * (kind: "signal") never carries a slash command, so it returns undefined.
 */
function commandText(content: PromptContent): string | undefined {
  if (typeof content === "string") return content;
  if ("kind" in content) return undefined;
  return content.text;
}

/**
 * Replace the leading text of a prompt with `text`, preserving attachments.
 * Only reached for string/object content (a signal never expands).
 */
function withText(content: PromptContent, text: string): PromptContent {
  if (typeof content === "string") return text;
  if ("kind" in content) return content;
  return { ...content, text };
}

/**
 * Render an {@link InvokeActionResult} into the `{ ok, output }` shape a
 * `command_result` entry carries. Error variants name the corrective action,
 * per the repo's user-facing-error rule.
 */
function formatPluginOutcome(
  outcome: InvokeActionResult,
  actionId: string,
): { ok: boolean; output: string } {
  switch (outcome.kind) {
    case "ok": {
      const { result } = outcome;
      if (!result.success) {
        return { ok: false, output: `Action failed. ${result.error ?? "Unknown error."}` };
      }
      if (result.data === undefined) return { ok: true, output: "Done." };
      return {
        ok: true,
        output:
          typeof result.data === "string"
            ? result.data
            : `\`\`\`toon\n${encodeToolOutput(result.data)}\n\`\`\``,
      };
    }
    case "unknown":
      return {
        ok: false,
        output: `Unknown action "${actionId}". The plugin command points at an action that is not loaded.`,
      };
    case "resolve-failed":
      return {
        ok: false,
        output: `Could not load ${outcome.service} actions. ${outcome.message}`,
      };
    case "denied-policy":
      return {
        ok: false,
        output: "This action is blocked by org policy. Ask an administrator to allow it.",
      };
    case "denied-approval":
      return {
        ok: false,
        output: "Approval was denied. Adjust action policies in Settings to allow this action.",
      };
    case "expired-approval":
      return {
        ok: false,
        output: "Approval expired before anyone resolved it. Send the command again to retry.",
      };
    case "pending-approval":
      return {
        ok: false,
        output: "Approval is pending. Resolve it from the approvals panel.",
      };
    case "invalid-args":
      return { ok: false, output: `Invalid arguments. ${outcome.error}` };
    case "missing-credential":
      return {
        ok: false,
        output: `Connect ${outcome.service} on the Integrations page (/integrations). After connecting, call list_tools (service: "${outcome.service}") to confirm — actions appear when the connection worked; otherwise this warning returns with the reason.`,
      };
    case "service-unavailable":
      return {
        ok: false,
        output: `${outcome.service} is unavailable. ${outcome.reason}${outcome.fix ? ` ${outcome.fix}` : ""}`,
      };
    case "error":
      return { ok: false, output: `Action failed. ${outcome.message}` };
  }
}

/** Options for {@link Session.emit}. */
export interface EmitOptions {
  /**
   * Idempotency key for the durable append; defaults to `uid("ev")`.
   * Re-runnable paths (settlement, gate lifecycle) pass a deterministic key so
   * a double-emission across restart/reconcile paths dedupes to a single row.
   */
  eventKey?: string;
  /**
   * Submission linkage for retention. Threads pass their running/settling item
   * id so retention can truncate a session's log per submission.
   */
  queueItemId?: string;
  /**
   * Decision 12: attempt fence for live-execution events emitted inside a
   * claimed turn. When present, a superseded/zombie attempt's append is
   * rejected with StaleAttemptError — which `emit` rethrows (unlike every
   * other append failure) so the caller's in-flight turn stops. Fence-less
   * emits remain best-effort unless they explicitly opt into
   * `throwOnAppendError` below.
   */
  fence?: WriteFence;
  /**
   * Surface a non-stale durable append failure to the caller. The default is
   * false so existing wakeup/UX events remain best-effort; correctness-critical
   * state publications opt in and decide how to recover.
   */
  throwOnAppendError?: boolean;
}

/** Settings pinned when an API caller creates a new thread. */
export interface ThreadInitialSettings {
  model?: string;
  reasoning?: ReasoningLevel | null;
}

export class Session {
  readonly id: string;
  readonly providers: ProviderBundle;
  readonly options: CreateSessionOptions;
  readonly sandbox: Sandbox;
  readonly attachment: SandboxAttachment;
  readonly builtinTools: ToolDef[];
  /**
   * Opaque per-instance owner id for lease ownership. Claims taken by this
   * running Session carry it; `renewLeases` extends only leases we still own,
   * and a replaced attempt (reconciliation, Task 5) changes the owner so our
   * heartbeat stops touching it.
   */
  readonly ownerId = uid("owner");
  /**
   * Who this session belongs to (Phase 4 decision 8). Defaults from
   * `options.owner`, falling back to `{ type: 'user', id: options.userId }`.
   * Mutable (not derived fresh from `options` on every read) so
   * `rehydrate` can restore a persisted owner the host's restore-time
   * options didn't re-supply, without that persisted value being stomped
   * back to the default on the session's next `toData()`/save.
   */
  private principal: Principal;
  /**
   * Parent session id (Phase 4 decision 11/16), mirrored from
   * `options.parentSessionId`. Mutable for the same reason `principal` is:
   * `rehydrate` restores it from persisted `SessionData` when the host's
   * restore-time options don't re-supply it (hosts route ordinary restores
   * through generic `{ userId, orgId, workspace }` options — see
   * `EngineHost.sessionFor` — so a child session's linkage would otherwise
   * be lost on the very first restart). This is what makes the app-layer
   * signal edge ACL (`packages/api/src/orchestrator/signals.ts`) able to
   * trust `SessionStore.getSession(id).parentSessionId` as durable truth.
   */
  private parentSessionId: string | undefined;
  /**
   * Parent thread id (Phase 4 decision 11/16), mirrored from
   * `options.parentThreadId`. Mutable for the same reason `parentSessionId`
   * is: `rehydrate` restores it from persisted `SessionData` when the
   * host's restore-time options don't re-supply it, so a child session's
   * thread linkage isn't stomped back to undefined on the next
   * `toData()`/save after a generic restore.
   */
  private parentThreadId: string | undefined;
  /** Indexed copies of options.roles / options.skills for fast lookup. */
  readonly roles = new Map<string, RoleSpec>();
  readonly skills = new Map<string, SkillSource>();
  private threads = new Map<string, Thread>();
  private threadsByKey = new Map<string, Thread>();
  private creatingThreads = new Map<string, Promise<Thread>>();
  /** Lazily-built slash-command registry; invalidated by refreshCommandRegistry(). */
  private commandRegistryCache: CommandRegistry | null = null;
  /**
   * Gates opened by approval-requiring plugin commands. Session-level, not
   * thread-level: a command is not a claimed turn, so its gate never
   * suspends a turn. Resolved through the same `resolveDecision` surface
   * the turn gates use. Pending command gates do not survive a process
   * restart — the durable gate row stays pending, and the user re-runs the
   * command.
   */
  private commandGates = new GateManager();
  /** Cached workspace skills from options.workspaceSkillsProvider; null === not
   * yet loaded. */
  private workspaceSkillsCache: SkillSource[] | null = null;
  /**
   * Repo AGENTS.md instructions from options.repoInstructionsProvider. One
   * immutable reference, replaced atomically by `refreshRepoInstructions()`
   * and never mutated — the per-turn overlay snapshots it once at turn start
   * (agents-md spec, decision 4's concurrency contract). `null` === none
   * loaded (not yet read, or the workspace has none).
   */
  private repoInstructionsRef: RepoInstructions | null = null;
  /**
   * Whether `refreshRepoInstructions()` has completed at least once. Guards
   * `ensureRepoInstructions()` so a workspace with NO instructions (a legal
   * `null` result) doesn't re-exec the scan on every turn.
   */
  private repoInstructionsLoaded = false;
  private destroyed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight: Promise<void> | undefined;
  private heartbeatInFlight: Promise<void> | undefined;
  /**
   * The `PolicySandbox` wrapper when the session's sandbox was constructed via
   * the engine's normal materialization path. `null` when the session was
   * created with a pre-provisioned concrete `Sandbox` (e.g. in tests that pass
   * a bare VirtualSandbox). Used by the run-start reconcile window (spec
   * decision 4) to query pending exec-job count.
   */
  private readonly policySandbox: PolicySandbox | null;

  constructor(
    id: string,
    options: CreateSessionOptions,
    providers: ProviderBundle,
    sandbox: Sandbox,
    attachment: SandboxAttachment,
    policySandbox?: PolicySandbox,
  ) {
    this.id = id;
    this.options = options;
    this.providers = providers;
    this.sandbox = sandbox;
    this.attachment = attachment;
    this.policySandbox = policySandbox ?? null;
    this.builtinTools = options.builtinTools ?? builtinTools;
    this.principal = options.owner ?? { type: "user", id: options.userId };
    this.parentSessionId = options.parentSessionId;
    this.parentThreadId = options.parentThreadId;
    for (const role of options.roles ?? []) this.roles.set(role.name, role);
    for (const skill of options.skills ?? []) this.skills.set(skill.name, skill);
    // sandbox_status emissions (spec decision 8): deterministic eventKey so
    // re-provision loops / re-emits dedupe to a single durable row per
    // epoch+state. Emit failures must never throw into the attachment —
    // Session.emit already log-and-continues, and onStatus listeners are
    // isolated by the attachment itself.
    this.attachment.onStatus((status: AttachmentStatus) => {
      // "detached" is never actually emitted by SandboxAttachment (its
      // status callbacks only fire from doProvision/destroy), but the type
      // includes it — narrow it away so the assignment to EngineEvent's
      // (slightly different) state union type-checks.
      if (status.state === "detached") return;
      // Wake-tag the eventKey so a suspend/resume cycle's re-emitted
      // `provisioning`/`ready` (SAME epoch — a clean wake is not a re-provision)
      // don't collide with the cold-boot status events and get dropped by
      // append's key-dedup (leaving the stale `suspended` as the last durable
      // status on a live sandbox). wake 0 stays byte-identical to the original
      // key for never-suspended sandboxes.
      const wake = status.wake ?? 0;
      const eventKey =
        wake > 0
          ? `sandbox:${status.epoch}:w${wake}:${status.state}`
          : `sandbox:${status.epoch}:${status.state}`;
      void this.emit(
        {
          type: "sandbox_status",
          sandboxId: status.sandboxId,
          state: status.state,
          epoch: status.epoch,
          estimateMs: status.estimateMs,
        },
        { eventKey },
      );
    });
  }

  // ── durable-execution timers ────────────────────────────────────

  /**
   * Lazily start the heartbeat (10s lease renewal) and sweep (5s claim retry)
   * intervals. Called by a thread on its first successful claim so idle
   * sessions carry no timers. Both intervals are `unref()`d so they never keep
   * the process alive, and are cleared in `destroy()`.
   */
  ensureTimers(): void {
    if (this.destroyed) return;
    if (this.heartbeatTimer === null) {
      this.heartbeatTimer = setInterval(() => {
        // A transient store error inside the tick must not become an
        // unhandled rejection that kills the process — log and let the next
        // interval retry. Same idiom as the emit-append failure path.
        // detachedFromTrace: interval callbacks inherit whatever trace
        // context was active when ensureTimers armed them (a request or
        // turn) — every tick would otherwise attach spans to that long-dead
        // trace forever.
        detachedFromTrace(() =>
          this.heartbeatOnce().catch((err) => {
            console.error(
              `[engine] heartbeat failed (session=${this.id}):`,
              err instanceof Error ? err.message : String(err),
            );
          }),
        );
      }, 10_000);
      this.heartbeatTimer.unref?.();
    }
    if (this.sweepTimer === null) {
      this.sweepTimer = setInterval(() => {
        // sweepOnce grew store reads + fenced gate writes (sweepExpiredGates);
        // a SQLITE_BUSY on a 5s tick must not crash the process. Swallow +
        // log so the next sweep still runs. detachedFromTrace: same
        // stale-context reasoning as the heartbeat above.
        detachedFromTrace(() =>
          this.sweepOnce().catch((err) => {
            console.error(
              `[engine] sweep failed (session=${this.id}):`,
              err instanceof Error ? err.message : String(err),
            );
          }),
        );
      }, 5_000);
      this.sweepTimer.unref?.();
    }
  }

  /**
   * Clear the heartbeat and sweep intervals without tearing anything else
   * down — for host-side cache eviction only. A host that keeps a `Session`
   * instance in an in-process cache and later evicts it (e.g. to force a
   * rebuild on the next `sessionFor` after an identity/config change) must
   * not leave this instance's timers running: `ensureTimers` unref()s them,
   * but unref() only stops them from keeping the *process* alive — it does
   * nothing to stop them from keeping *this object* alive (each closure
   * captures `this`) or from continuing to hit the store every 5-10s.
   * Mirrors exactly what `destroy()` does to the two timer fields, without
   * `destroy()`'s store deletion or thread aborts — this instance's
   * transcript and store rows must survive.
   *
   * The object must not be reused after this without a fresh claim: no
   * caller should hold a reference across an eviction. If one somehow does,
   * `ensureTimers` will restart the timers lazily on the next claim (it
   * checks `this.destroyed`, which `suspendTimers` does not set), so this
   * is not a poison-pill — just an idle instance.
   */
  suspendTimers(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Renew leases for every submission this instance is currently running. */
  heartbeatOnce(): Promise<void> {
    if (this.heartbeatInFlight) return this.heartbeatInFlight;
    this.heartbeatInFlight = this.renewRunningLeases().finally(() => {
      this.heartbeatInFlight = undefined;
    });
    return this.heartbeatInFlight;
  }

  private async renewRunningLeases(): Promise<void> {
    const ids = this.runningItemIds();
    if (ids.length === 0) return;
    await this.providers.store.renewLeases(this.ownerId, ids);
  }

  /**
   * One sweep pass: flush any collect window whose deadline has already
   * passed (safety net for a missed/never-armed in-process timer), then
   * re-kick every thread so missed wakeups can't strand queued work.
   */
  sweepOnce(): Promise<void> {
    if (this.sweepInFlight) return this.sweepInFlight;
    this.sweepInFlight = this.sweepThreads().finally(() => {
      this.sweepInFlight = undefined;
    });
    return this.sweepInFlight;
  }

  private async sweepThreads(): Promise<void> {
    // Reclaim expired leases: any running/blocked item of this session whose
    // lease has lapsed is reconciled through the tree (Task 5 lease-expiry
    // reclaim). QueueItem carries no sessionId, so we scan this session's own
    // unsettled items and filter on the lease rather than the global
    // listExpiredSubmissions scan — equivalent for one session, and avoids
    // touching other sessions' work.
    const now = Date.now();
    let mine = await this.providers.store.listUnsettledSubmissions(this.id);
    let reconciled = false;
    for (const item of mine) {
      const claimed = item.status === "running" || item.status === "blocked_on_decision_gate";
      const leaseExpired = item.leaseExpiresAt !== undefined && item.leaseExpiresAt < now;
      if (claimed && leaseExpired) {
        await this.reconcileItem(item);
        reconciled = true;
      }
    }
    if (reconciled) mine = await this.providers.store.listUnsettledSubmissions(this.id);
    // Share one snapshot across threads. Idle history needs no per-thread reads.
    const byThread = submissionsByThread(mine);
    const gatesByThread = new Map<string, DecisionGate[]>();
    for (const gate of await this.providers.store.listDecisionGates(this.id, undefined, "pending")) {
      const gates = gatesByThread.get(gate.threadId) ?? [];
      gates.push(gate);
      gatesByThread.set(gate.threadId, gates);
    }
    for (const threadId of new Set([...byThread.keys(), ...gatesByThread.keys()])) {
      const t = this.threads.get(threadId);
      if (!t) continue;
      // Durable expiry backstop for pending decision gates whose in-process
      // timer was lost (e.g. across restart). Runs before the kick so an
      // expired gate terminalizes and unblocks the thread's queued work.
      await t.sweepExpiredGates(gatesByThread.get(threadId) ?? []);
      const items = byThread.get(threadId) ?? [];
      await t.checkCollectDeadline(items);
      await t.repairOverheardDigests(items);
      // A drive can wait for a model or approval. It must not hold the
      // sweep open and prevent the next pass from repairing other threads.
      void t.kick();
    }
  }

  private runningItemIds(): string[] {
    const ids: string[] = [];
    for (const t of this.threads.values()) {
      const id = t.runningItemId();
      if (id) ids.push(id);
    }
    return ids;
  }

  /**
   * Rebuild a Session from persisted state. Called by Engine.restoreSession.
   * The caller re-supplies tools/sandbox/model in options.
   */
  static async rehydrate(
    data: SessionData,
    options: CreateSessionOptions,
    providers: ProviderBundle,
    sandbox: Sandbox,
    attachment: SandboxAttachment,
    policySandbox?: PolicySandbox,
  ): Promise<Session> {
    const session = new Session(data.id, options, providers, sandbox, attachment, policySandbox);
    // The host's restore-time options usually don't re-supply `owner` (it's
    // not something callers round-trip through CreateSessionOptions on
    // every restart) — preserve the persisted value in that case rather
    // than falling back to the user-owned default computed in the
    // constructor. An explicit options.owner (host re-asserting ownership)
    // still wins.
    if (options.owner === undefined) session.principal = data.owner;
    if (options.parentSessionId === undefined) session.parentSessionId = data.parentSessionId;
    if (options.parentThreadId === undefined) session.parentThreadId = data.parentThreadId;
    // Preserve the persisted start-ref across generic restores (hosts don't
    // round-trip it through options) so the next `toData()` save can't stomp
    // it back to undefined — and so `setStartRef`'s single-shot guard sees it.
    if (options.startRef === undefined) options.startRef = data.startRef;
    // Preserve the persisted purpose the same way (TKAI-319): purpose is
    // behavior-bearing now — it selects turn retry and cache retention — and
    // a child session that loses it across an api restart would stop riding
    // out the very outage that restarted the api.
    if (options.purpose === undefined) options.purpose = data.purpose;
    // Same no-clobber rule for the session-default reasoning level: a host
    // that does not re-supply `sampling.reasoning` keeps the persisted
    // level, so the next `toData()` save cannot stomp it back to NULL. An
    // explicit level from the host still wins. An unreadable token degrades
    // to "unset" rather than failing the restore.
    if (options.sampling?.reasoning === undefined) {
      const persisted = parseReasoningLevel(data.reasoning);
      if (persisted !== undefined) options.sampling = { ...options.sampling, reasoning: persisted };
    }
    const threadDatas = await providers.store.listThreads(data.id);
    for (const td of threadDatas) {
      const thread = new Thread(session, td, { restoreTranscript: true });
      session.attachThread(thread);
    }
    // Startup reconciliation (Task 5): every unsettled submission passes through
    // the normative decision tree. Awaited so callers can rely on gate re-arming
    // (and settlement of finished/aborted/superseded/exhausted work) having been
    // applied before they resolve gates or read queue state. The actual
    // gate-replay / resume drive kicked off here is asynchronous — reconcile
    // claims the work and KICKS the drive, never waits for the resumed turn
    // (see resumeInterrupted's doc comment for the deadlock this prevents).
    // One knock-on exception to "applied before resolve": on the dead-gate
    // fall-through (gate expired/withdrawn while the engine was down), the
    // blocked→running flip lands inside the background drive, so queue state
    // can read blocked_on_decision_gate for a moment after restore resolves
    // even though no pending gate exists; resolving a missing gate is a safe
    // 404.
    await session.reconcile();
    return session;
  }

  /**
   * Reconcile every unsettled submission of this session through the normative
   * decision tree (spec §Reconciliation). Called only from `restoreSession`
   * (the sweep goes through `reconcileItem` directly, never this method), so
   * the end-of-reconcile kick below runs once per rehydrate. Idempotent —
   * re-running is safe.
   */
  async reconcile(): Promise<void> {
    const items = await this.providers.store.listUnsettledSubmissions(this.id);
    for (const item of items) {
      // startup: this instance is the definitive new owner (restoreSession's
      // single-owner contract), so an unexpired prior lease is not evidence of a
      // live attempt — reclaim eagerly. Fencing (fresh attemptId) makes a slow
      // zombie's late writes fail, so eager takeover stays safe.
      await this.reconcileItem(item, { startup: true });
    }
    // Durable wakeup for still-queued heads. A `queued` item carries no
    // attempt id (admission never sets one; a credential release explicitly
    // clears it), so the decision tree's `resume` action short-circuits in
    // `resumeInterrupted` — and right after a restart no sweep timer is armed
    // yet (`ensureTimers` runs on the first claim). Without this kick a
    // released credential-less item — or any queued-at-crash item — would sit
    // queued forever until an unrelated external prompt. Fire-and-forget: the
    // drive is asynchronous (same contract as submitPrompt's kick); the kick
    // itself arms the timers on claim, so the 5s sweep takes over as the
    // retry backoff.
    // Settle a crashed coalesce's leftover constituents BEFORE the kick below
    // can claim one (see Thread.repairOverheardDigests).
    const repairItems = await this.providers.store.listUnsettledSubmissions(this.id);
    for (const [threadId, threadItems] of submissionsByThread(repairItems)) {
      await this.threads.get(threadId)?.repairOverheardDigests(threadItems);
    }
    const remaining = await this.providers.store.listUnsettledSubmissions(this.id);
    const queuedThreadIds = new Set(
      remaining
        .filter((i) => i.status === "queued" && !i.supersededByItemId)
        .map((i) => i.threadId),
    );
    for (const t of this.threads.values()) {
      if (queuedThreadIds.has(t.id)) void t.kick();
    }
  }

  /**
   * Gather the ReconcileContext from the store, consult the pure decision
   * function, and apply the resulting action via the owning Thread. Also
   * observes the stuck-head condition for the attention signal.
   */
  private async reconcileItem(item: QueueItem, opts?: { startup?: boolean }): Promise<void> {
    if (item.status === "settled") return;
    const thread = this.threads.get(item.threadId);
    if (!thread) return; // thread not hydrated — nothing to drive it with

    const store = this.providers.store;

    // A live in-process turn owns this item (we're actively running it): never
    // yank it out from under ourselves via reconciliation.
    if (thread.runningItemId() === item.id) return;

    // Terminalizing: the outcome is already durably reserved — re-run the
    // finalize half on the item's stored current attempt (never a fresh one).
    if (item.status === "terminalizing") {
      await thread.retryFinalize(item);
      return;
    }

    const now = Date.now();
    const entries = await store.getEntries(this.id, item.threadId);
    const hasTerminalAssistantEntry = entries.some(
      (e) =>
        e.type === "message" &&
        e.role === "assistant" &&
        e.queueItemId === item.id &&
        e.stopReason === "end_turn",
    );
    const markerLive = item.attemptId
      ? await store.hasAttemptMarker(item.id, item.attemptId)
      : false;
    // On startup the prior owner is gone by contract, so its lease never counts
    // as "live". On the sweep only already-expired-lease items reach here, so
    // this is false there too — the guard's live-attempt branch is exercised by
    // the pure tests, defensive here.
    const leaseUnexpired =
      !opts?.startup && item.leaseExpiresAt !== undefined && item.leaseExpiresAt > now;
    // The startup override's "prior owner is gone" premise is FALSE when the
    // owner is this same process: a host cache-evict + rebuild restores a
    // second Session while the first one's background drive (resume, replay)
    // is still running here. Stealing that live attempt runs the same turn's
    // tools twice in one sandbox, so a drive registered in-process counts as
    // live regardless of lease state. Known gap: an in-process turn driven by
    // a normal prompt kick (kickLoop) is not registered — that steal predates
    // the background-drive work and is tracked separately.
    const drivenInProcess = isItemDrivenInProcess(item.id);
    const suspended = await store.getSuspendedTurn(this.id, item.threadId);
    let gateStatus: ReconcileContext["gateStatus"] = null;
    if (suspended) {
      const gate = await store.getDecisionGate(this.id, suspended.gateId);
      gateStatus = gate?.status ?? null;
    }
    const ctx: ReconcileContext = {
      now,
      hasTerminalAssistantEntry,
      attemptLive: (markerLive && leaseUnexpired) || drivenInProcess,
      suspended,
      gateStatus,
    };

    const action = decideReconciliation(item, ctx);
    // Stuck-head observation only for items reconciliation actually acts on —
    // a `wait` item is owned by a live attempt or a collect window, not a
    // wedged head.
    if (action.kind !== "wait") {
      this.maybeEmitStuck(item, now);
    }
    switch (action.kind) {
      case "wait":
        return;
      case "settle":
        await thread.settleReconciled(item, action.outcome, suspended);
        return;
      case "rearm_gate":
        if (suspended) await thread.reconcileGate(item, suspended, "rearm");
        return;
      case "replay_gate":
        if (suspended) await thread.reconcileGate(item, suspended, "replay");
        return;
      case "resume": {
        // A running item whose attempt never reached the model — NO assistant
        // entry carries its queueItemId (a crashed pre-stream attempt has at
        // most a user entry, e.g. a store throw inside the credential-release
        // path or a settle throw after the cap append) — must not be resumed:
        // `resumeInterrupted` continues the transcript, which is the PREVIOUS
        // turn's, and the prompt would never actually run. Re-queue it for a
        // fresh from-scratch run instead (fenced release, no credential
        // counters — this is not a credential cycle; the idempotent
        // user-entry append means no duplicates); the post-reconcile kick
        // (startup) / sweep kick picks it up. A genuine mid-stream crash HAS
        // assistant entries and still resumes; gate-suspended items are
        // excluded by the `running` status check.
        const hasAssistantEntry = entries.some(
          (e) => e.type === "message" && e.role === "assistant" && e.queueItemId === item.id,
        );
        if (item.status === "running" && item.attemptId !== undefined && !hasAssistantEntry) {
          const released = await store.releaseSubmission(this.id, item.threadId, item.id, {
            itemId: item.id,
            attemptId: item.attemptId,
          });
          if (released) return;
          // CAS refused (superseded / successor) — fall through to resume,
          // whose own fencing resolves ownership safely.
        }
        await thread.resumeInterrupted(item);
        return;
      }
    }
  }

  /**
   * Emit the stuck-head attention event (spec §Reconciliation) when an unsettled
   * submission crosses the retry threshold or wall-clock bound. Gate-blocked
   * items are excluded (their bound is the gate's own expiry). Once per
   * observation pass — no dedup in Phase 1.
   */
  private maybeEmitStuck(item: QueueItem, now: number): void {
    if (item.status === "blocked_on_decision_gate") return;
    const ageMs = now - item.createdAt;
    const stuck = item.attemptCount >= 3 || ageMs > 15 * 60_000;
    if (!stuck) return;
    void this.emit({
      type: "submission_stuck",
      sessionId: this.id,
      threadId: item.threadId,
      queueItemId: item.id,
      attemptCount: item.attemptCount,
      ageMs,
    });
  }

  private attachThread(thread: Thread): void {
    this.threads.set(thread.id, thread);
    this.threadsByKey.set(thread.key, thread);
  }

  async ensureDefaultThread(): Promise<Thread> {
    return this.thread("web:default");
  }

  private buildThreadData(key: string, initial?: ThreadInitialSettings): ThreadData {
    return {
      id: uid("th"),
      sessionId: this.id,
      key,
      status: "active",
      queueMode: this.options.queueMode ?? "followup",
      // Pin the session's effective model at creation (TKAI-201): one chat
      // keeps the model it started with, and a later session-default change
      // affects only future threads. This is the single creation seam —
      // default/channel/workflow threads all funnel through here; rehydrate
      // constructs Thread from persisted data and never re-stamps.
      model: initial?.model ?? this.options.modelSpec ?? this.options.model.id,
      reasoning:
        initial?.reasoning === null ? THREAD_REASONING_DISABLED : initial?.reasoning,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  thread(key?: string): Thread {
    const k = key ?? "web:default";
    const existing = this.threadsByKey.get(k);
    if (existing) return existing;
    const data = this.buildThreadData(k);
    const thread = new Thread(this, data);
    this.attachThread(thread);
    void this.providers.store.saveThread(this.id, data);
    return thread;
  }

  /** Persist a new thread before it becomes visible in this session. */
  async createThread(key: string, initial?: ThreadInitialSettings): Promise<Thread> {
    const existing = this.threadsByKey.get(key);
    if (existing) return existing;
    const pending = this.creatingThreads.get(key);
    if (pending) return pending;
    const creating = this.createKeyedThread(key, initial);
    this.creatingThreads.set(key, creating);
    try {
      return await creating;
    } finally {
      this.creatingThreads.delete(key);
    }
  }

  private async createKeyedThread(key: string, initial?: ThreadInitialSettings): Promise<Thread> {
    let data = this.buildThreadData(key, initial);
    try {
      await this.providers.store.saveThread(this.id, data);
    } catch (error) {
      // A different host can win the durable (session_id, key) constraint.
      // Recover only when that winner exists; preserve unrelated failures.
      const winner = (await this.providers.store.listThreads(this.id)).find(thread => thread.key === key);
      if (!winner) throw error;
      data = winner;
    }
    const thread = new Thread(this, data);
    this.attachThread(thread);
    return thread;
  }

  threadById(id: string): Thread | null {
    return this.threads.get(id) ?? null;
  }

  async threadByKey(key: string): Promise<Thread | null> {
    return this.threadsByKey.get(key) ?? null;
  }

  listThreads(): Thread[] {
    return [...this.threads.values()];
  }

  /**
   * Returns true when any thread OTHER than `excludeThreadId` currently has
   * an active run (i.e. is mid-turn). Used by the run-start reconcile window
   * (spec decision 4) to determine whether the session is idle enough for
   * sandbox convergence.
   */
  hasOtherActiveRuns(excludeThreadId: string): boolean {
    for (const t of this.threads.values()) {
      if (t.id !== excludeThreadId && t.hasActiveRun) return true;
    }
    return false;
  }

  /**
   * Number of exec jobs that have been vended to the PolicySandbox but have
   * not yet reached a terminal poll status. Returns 0 when the session was
   * constructed without a PolicySandbox (bare-sandbox test harnesses).
   * Used by the run-start reconcile window (spec decision 4).
   */
  pendingJobCount(): number {
    return this.policySandbox?.pendingJobCount() ?? 0;
  }

  // ── public API ──────────────────────────────────────────────────

  async prompt(content: PromptContent, opts: PromptOptions = {}): Promise<PromptReceipt> {
    const thread = this.resolveTargetThread(opts.threadId);
    const text = commandText(content);
    if (text?.startsWith("/")) {
      const outcome = dispatchCommand(text, this.commandRegistry());
      if (outcome.kind === "expand") {
        // Stamp the skill identity onto the submission so the persisted
        // entry (and its wire projection) can render the expansion as a
        // skill card without re-parsing the text.
        const opts2 = outcome.skill
          ? {
              ...opts,
              metadata: { ...opts.metadata, skill: outcome.skill.source.name, skillArgs: outcome.skill.args },
              skillInvocation: { skill: outcome.skill.source, path: outcome.skill.path },
            }
          : opts;
        return thread.submitPrompt(withText(content, outcome.text), opts2);
      }
      if (outcome.kind === "execute") {
        return this.executeCommand(thread, outcome.resolved, outcome.args, text, opts.author, opts.channel);
      }
      if (outcome.kind === "pass" && outcome.nearMiss !== undefined) {
        const receipt = await thread.submitPrompt(content, opts);
        return { ...receipt, nearMiss: outcome.nearMiss };
      }
    }
    return thread.submitPrompt(content, opts);
  }

  /** Resolve `PromptOptions.threadId` to a thread, or the session default. */
  private resolveTargetThread(threadId?: string): Thread {
    if (threadId === undefined) return this.thread();
    const thread = this.threadById(threadId);
    if (!thread) throw new Error(`prompt: thread ${threadId} not found in session ${this.id}`);
    return thread;
  }

  /**
   * Run a resolved built-in or plugin command against `thread`, persist a
   * `command_result` entry, emit `command_result`, and return a
   * command-shaped receipt. Never touches queue admission — a command runs
   * even while a turn streams.
   *
   * `PromptOptions` other than `threadId` (resolved by the caller),
   * `author`, and `channel` are intentionally not forwarded: they shape
   * queue submissions (queueMode, model, ...) and a command takes no queue
   * item. `author` IS forwarded, onto the echo entry — the echo is a
   * persisted user message, and on a shared session an authorless echo
   * renders as "You" in every member's view. `channel` IS forwarded, onto
   * the echo and the result entry — the outbound channel path posts a
   * command result to a bound channel only when the command came from that
   * surface (TKAI-323). If another option must reach the command path, add
   * a parameter here so the dependency is explicit.
   */
  private async executeCommand(
    thread: Thread,
    resolved: ResolvedCommand,
    args: string[],
    raw: string,
    author?: PromptAuthor,
    channel?: ChannelTarget,
  ): Promise<PromptReceipt> {
    // Echo the typed command as a persisted user message BEFORE the result.
    // A command takes no queue item, so nothing else persists the user's
    // text — without this echo, clients reorder the result above the
    // command on refetch, and a reload loses the command entirely. Written
    // first (not raced with the plugin grace window) so the echo always
    // precedes its result.
    const echoAt = Date.now();
    const echo: MessageEntry = {
      id: uid("e"),
      sessionId: this.id,
      threadId: thread.id,
      parentId: null,
      type: "message",
      role: "user",
      content: raw,
      author,
      channel,
      createdAt: echoAt,
    };
    await thread.appendEntry(echo);
    let source: CommandSource;
    let name: string;
    let result: { ok: boolean; output: string };
    if (resolved.source === "builtin") {
      source = "builtin";
      name = resolved.name;
      // Same failure contract as the plugin path below: a throwing builtin
      // (e.g. /compact when the summarizer provider errors) must persist an
      // ok:false command_result next to the already-persisted echo entry,
      // not reject the whole submission into a raw HTTP 500 (TKAI-306).
      try {
        result = await executeBuiltin(name, args, this, this.options.commandContext, thread);
      } catch (err) {
        result = {
          ok: false,
          output: err instanceof Error ? err.message : String(err),
        };
      }
    } else if (resolved.source === "plugin") {
      source = "plugin";
      name = `${resolved.pluginName}:${resolved.def.name}`;
      // An approval-requiring command can wait minutes on its gate. Do not
      // hold the caller (an HTTP request) for that: give the action a short
      // grace window, then let it complete in the background — the
      // command_result entry lands via the same persist+emit path either way.
      const pending = this.executePluginCommand(thread, resolved.pluginName, resolved.def, raw);
      const grace = new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), 500) as { unref?: () => void };
        if (typeof t.unref === "function") t.unref();
      });
      const fast = await Promise.race([pending, grace]);
      if (fast === null) {
        const bgName = name;
        void pending
          .then((r) => this.persistCommandResult(thread, bgName, "plugin", r, echoAt, channel))
          .catch((err: unknown) =>
            this.persistCommandResult(
              thread,
              bgName,
              "plugin",
              { ok: false, output: err instanceof Error ? err.message : String(err) },
              echoAt,
              channel,
            ),
          );
        return {
          sessionId: this.id,
          threadId: thread.id,
          queueItemId: "",
          status: "queued",
          command: { name, source },
        };
      }
      result = fast;
    } else {
      // dispatchCommand only yields execute for builtin/plugin sources.
      throw new Error(`executeCommand: unexpected source ${resolved.source}`);
    }

    await this.persistCommandResult(thread, name, source, result, echoAt, channel);

    return {
      sessionId: this.id,
      threadId: thread.id,
      queueItemId: "",
      status: "queued",
      command: { name, source },
    };
  }

  /**
   * Persist a command_result entry and emit its live event. `notBefore` is
   * the echo entry's timestamp; the result is stamped strictly after it so
   * `created_at` alone orders the pair on reload — the REST read
   * (`getEntries`) has no reliable id tiebreaker (uid counters are
   * variable-length base36, so lexical id order is not insertion order).
   */
  private async persistCommandResult(
    thread: Thread,
    name: string,
    source: CommandSource,
    result: { ok: boolean; output: string },
    notBefore: number,
    channel?: ChannelTarget,
  ): Promise<void> {
    const entry: CommandResultEntry = {
      id: uid("e"),
      sessionId: this.id,
      threadId: thread.id,
      parentId: null,
      type: "command_result",
      command: `/${name}`,
      source,
      ok: result.ok,
      output: result.output,
      channel,
      createdAt: Math.max(Date.now(), notBefore + 1),
    };
    await thread.appendEntry(entry);
    await this.emit({ type: "command_result", threadId: thread.id, entry });
  }

  /**
   * Run an action-backed plugin command. Maps the raw arg string through the
   * command's `mapArgs`, then invokes the backing action against the shared
   * plugin catalog via `invokeAction` — the SAME approval + validation core
   * the LLM `call_tool` path uses. Renders the outcome as markdown for a
   * `command_result` entry. A command is not a claimed turn, so approvals
   * route through the host `commandRequestDecision` hook, not the turn gate.
   */
  private async executePluginCommand(
    thread: Thread,
    pluginName: string,
    def: CommandDef,
    raw: string,
  ): Promise<{ ok: boolean; output: string }> {
    const catalog = this.options.pluginCatalog;
    if (!catalog) {
      return {
        ok: false,
        output:
          "Plugin commands are not available in this deployment. No plugin catalog is configured.",
      };
    }
    const mapped = def.mapArgs(parseCommandArgs(raw), raw);
    const ctx = this.buildCommandToolContext(thread);
    const summary = `/${pluginName}:${def.name}${raw ? ` ${raw}` : ""}`;
    try {
      const outcome = await invokeAction(catalog, def.action, mapped, ctx, summary);
      return formatPluginOutcome(outcome, def.action);
    } catch (err) {
      // Expiry never reaches here: invokeAction converts it to the
      // `expired-approval` outcome, which formatPluginOutcome renders.
      if (isDecisionGateWithdrawn(err)) {
        return {
          ok: false,
          output: "Approval was withdrawn before the command ran. Send the command again to retry.",
        };
      }
      throw err;
    }
  }

  /**
   * Build a command-scoped {@link ToolContext} for a plugin command. Unlike
   * the Thread's turn-scoped context it never suspends a turn: `requestDecision`
   * delegates to the host `commandRequestDecision` hook (or denies when none is
   * set), and there is no fence/DAG bookkeeping. Credentials, sandbox, and
   * thread reads mirror the turn context so a plugin action behaves the same
   * whether reached from a slash command or from `call_tool`.
   */
  private buildCommandToolContext(thread: Thread): ToolContext {
    const requestDecision = this.options.commandRequestDecision;
    return {
      userId: this.options.userId,
      orgId: this.options.orgId,
      sessionId: this.id,
      threadId: thread.id,
      sessionPurpose: this.options.purpose,
      cwd: this.options.workspace,
      credentials: this.credentialProvider(),
      sandbox: this.sandbox,
      config: this.options.toolConfig,
      owner: this.principal,
      // The SAME policy port the turn context threads (plugin-catalog's
      // invokeAction consults it) — a plugin action reached from a slash
      // command gets identical policy resolution, gating, and audit to a
      // call_tool invocation. Commands run outside the queue, so there is
      // no queueItemId; gated command audits key on (resumeKey, ordinal)
      // with an empty turn scope, matching their gate-ordinal scoping.
      policyResolver: this.options.policyResolver,
      signal: new AbortController().signal,
      requestDecision: async (req: DecisionGateRequest): Promise<DecisionResolution> => {
        if (requestDecision) return requestDecision(req);
        // No host hook: open a real decision gate on the default thread.
        // The gate persists as a decision_gate entry and emits the same
        // events turn gates do, so the web approvals UI and channel
        // approve/deny buttons render it. Resolution arrives through
        // `resolveDecision`, same as every other gate.
        return this.awaitCommandGate(thread, req);
      },
      threadRead: (key, opts) => this.readEntries(key, opts),
      listThreads: async () => {
        const datas = await this.providers.store.listThreads(this.id);
        return datas.map((d) => ({
          id: d.id,
          key: d.key,
          status: d.status,
          model: d.model,
          summary: d.summary,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        }));
      },
      // A plugin action reached from a slash command the USER typed, so this
      // counts as a user switch and persists. The agent's own path is the
      // Thread's turn context, which stamps a `tool:` reason and gets the
      // turn-scoped escalation instead (TKAI-338). Passed explicitly rather
      // than defaulted — the reason string now selects the writer.
      setModel: (args) => thread.setModel(args.model, "slash_command"),
    };
  }

  /**
   * Lazily-built slash-command registry for this session. Cached across calls
   * within a session; `refreshCommandRegistry()` invalidates it (the host
   * calls that after workspace prep and whenever skills change).
   */
  commandRegistry(): CommandRegistry {
    if (this.commandRegistryCache) return this.commandRegistryCache;
    const registry = buildCommandRegistry({
      skills: [...(this.workspaceSkillsCache ?? []), ...this.skills.values()],
      pluginCommands: this.options.pluginCommands ?? [],
      bareSkillNames: this.options.bareSkillNames ?? false,
    });
    this.commandRegistryCache = registry;
    return registry;
  }

  /**
   * Invalidate the cached command registry, refresh workspace skills from
   * the host `workspaceSkillsProvider` (if any), and refresh the session's
   * skill map from the host `skillsProvider` (if any). Call after workspace
   * prep and on any event that may change the reachable skill set. Idempotent.
   */
  async refreshCommandRegistry(): Promise<void> {
    const workspaceProvider = this.options.workspaceSkillsProvider;
    const skillsProvider = this.options.skillsProvider;
    // Load first, invalidate after: when a provider throws, the previous
    // registry (and its skill list) keeps serving — a stale list beats an
    // empty one mid-session. The rejection still reaches the caller.
    //
    // The refresh is atomic across BOTH providers on purpose: Promise.all
    // fails fast, so one provider's rejection discards the other's result
    // and keeps both previous sets serving. Applying a half-refresh would
    // let the two skill views drift apart mid-session; the caller retries
    // on the next refresh event either way.
    const [workspaceSkills, managedSkills] = await Promise.all([
      workspaceProvider ? workspaceProvider() : Promise.resolve([]),
      skillsProvider ? skillsProvider() : Promise.resolve(null),
    ]);
    this.workspaceSkillsCache = workspaceSkills;
    if (managedSkills !== null) {
      // Replace, not merge: the provider returns the full merged set (plugin
      // + stored). A deleted or renamed stored skill must drop out here, and
      // `skill`-tool lookups (thread.ts) read this same map, so both surfaces
      // stay consistent.
      this.skills.clear();
      for (const skill of managedSkills) this.skills.set(skill.name, skill);
    }
    this.commandRegistryCache = null;
  }

  /**
   * The current repo AGENTS.md instructions, or `null` when none are loaded.
   * The returned object is immutable — callers snapshot the reference once
   * (the per-turn overlay does this at turn start) and never see a
   * mid-flight mutation.
   */
  repoInstructions(): RepoInstructions | null {
    return this.repoInstructionsRef;
  }

  /**
   * Re-read repo instructions through `options.repoInstructionsProvider`.
   * No provider === no-op. The stored value is replaced in a single
   * assignment after the provider resolves; a provider rejection propagates
   * to the caller and leaves the previous value serving (same load-first
   * idiom as `refreshCommandRegistry`). The host calls this on every
   * attachment `ready` transition.
   */
  async refreshRepoInstructions(): Promise<void> {
    const provider = this.options.repoInstructionsProvider;
    if (!provider) return;
    this.repoInstructionsRef = await provider();
    this.repoInstructionsLoaded = true;
  }

  /**
   * First-load seam for the run-start path: refresh once the attachment is
   * `ready`, unless a refresh already completed. Closes the race where the
   * first turn's ready transition fires but the (async, unawaited) host-hook
   * refresh hasn't landed before the turn's overlay snapshots — the thread
   * awaits this after the run-start reconcile window. Idempotent and cheap
   * after the first successful load; a provider failure leaves the loaded
   * flag unset so the next turn retries.
   */
  async ensureRepoInstructions(): Promise<void> {
    if (this.repoInstructionsLoaded) return;
    if (!this.options.repoInstructionsProvider) return;
    if (this.attachment.state !== "ready") return;
    await this.refreshRepoInstructions();
  }

  /**
   * Settle every never-claimed (queued/collecting) item of a thread as
   * aborted and return how many were removed. Used by `/clear`.
   */
  async clearQueue(threadId: string): Promise<number> {
    const store = this.providers.store;
    const items = await store.listUnsettledSubmissions(this.id);
    let removed = 0;
    for (const it of items) {
      if (it.threadId !== threadId) continue;
      if (it.status === "queued" || it.status === "collecting") {
        const ok = await store.settleUnclaimed(this.id, threadId, it.id, {
          outcome: "aborted",
        });
        if (ok) removed++;
      }
    }
    return removed;
  }

  /**
   * Create and switch to a fresh thread. Returns the new thread. Used by
   * `/new-thread`; mints a unique key so it never re-adopts an existing one.
   */
  async newThread(): Promise<Thread> {
    const key = `web:${uid("t")}`;
    return this.createThread(key);
  }

  async resolveDecision(gateId: string, resolution: DecisionResolution): Promise<void> {
    // Command gates first — they are session-level, not owned by any thread.
    if (this.commandGates.isPending(gateId)) {
      const existing = await this.providers.store.getDecisionGate(this.id, gateId);
      this.commandGates.resolve(gateId, resolution);
      if (existing) {
        await persistTerminalGate(this.providers.store, this.id, existing.threadId, existing, {
          status: "resolved",
          resolution,
        });
        await this.emit(
          { type: "decision_gate_resolved", threadId: existing.threadId, gateId, resolution },
          { eventKey: `gate:${gateId}:resolved` },
        );
      }
      return;
    }
    for (const t of this.threads.values()) {
      if (t.isPendingGate(gateId)) {
        t.resolveDecision(gateId, resolution);
        return;
      }
    }
    // Orphan repair (TKAI-238): a pending row with no in-memory waiter can
    // never resolve through the paths above — the row survives every refresh
    // as an unresolvable approval card. Such rows exist in deployed databases
    // (gate opens that failed partway on older builds) and can still appear
    // in the crash window between gate persist and waiter registration, so
    // this user-initiated repair terminalizes them on the next click.
    await this.terminalizeOrphanedGate(gateId, { resolution });
  }

  /**
   * Open a durable decision gate for an approval-requiring plugin command
   * and wait for its resolution. Rejects with DecisionGateExpiredError when
   * the gate's expiry lapses first.
   */
  private async awaitCommandGate(
    thread: Thread,
    req: DecisionGateRequest,
  ): Promise<DecisionResolution> {
    // queueItemId is a fresh nonce: command gates never join an earlier
    // gate the way retried tool calls do — every invocation asks again.
    const gate = fromRequest(req, {
      sessionId: this.id,
      threadId: thread.id,
      queueItemId: uid("cmd"),
      resumeKey: req.resumeKey ?? "command",
      ordinal: 0,
    });
    await this.providers.store.saveDecisionGate(this.id, thread.id, gate);
    const gateEntry: SessionEntry = {
      id: uid("e"),
      sessionId: this.id,
      threadId: thread.id,
      parentId: null,
      type: "decision_gate",
      gate,
      createdAt: Date.now(),
    };
    await thread.appendEntry(gateEntry);
    await this.emit(
      { type: "decision_gate", threadId: thread.id, gate },
      { eventKey: `gate:${gate.id}:pending` },
    );
    return this.commandGates.register(gate, async (gateId) => {
      // Terminalize the ROW as well as the DAG entry — an entry-only update
      // leaves the row pending forever, and the thread sweep would later
      // report it as an unowned orphan.
      await persistTerminalGate(this.providers.store, this.id, thread.id, gate, {
        status: "expired",
      });
      await this.emit(
        { type: "decision_gate_expired", threadId: thread.id, gateId },
        { eventKey: `gate:${gateId}:expired` },
      );
    });
  }

  /**
   * True when a session-level command-gate waiter is armed for `gateId`.
   * Command gates persist rows on a thread but are owned here — the thread
   * expiry sweep consults this so it never expires a row whose waiter is
   * live (mirrors the commandGates-first branch in resolve/withdraw).
   */
  isCommandGatePending(gateId: string): boolean {
    return this.commandGates.isPending(gateId);
  }

  async withdrawDecision(gateId: string, reason: DecisionWithdrawReason): Promise<void> {
    // Command gates first — session-level, not owned by any thread (mirrors
    // resolveDecision). Command gates never write a suspended-turn
    // checkpoint, so without this branch the orphan repair below would
    // terminalize a LIVE command gate's row while its waiter stays armed.
    if (this.commandGates.isPending(gateId)) {
      const existing = await this.providers.store.getDecisionGate(this.id, gateId);
      this.commandGates.withdraw(gateId, reason);
      if (existing) {
        await persistTerminalGate(this.providers.store, this.id, existing.threadId, existing, {
          status: "withdrawn",
          reason,
        });
        await this.emit(
          { type: "decision_gate_withdrawn", threadId: existing.threadId, gateId, reason },
          { eventKey: `gate:${gateId}:withdrawn` },
        );
      }
      return;
    }
    for (const t of this.threads.values()) {
      if (t.isPendingGate(gateId)) {
        t.withdrawDecision(gateId, reason);
        return;
      }
    }
    // Orphan repair — see resolveDecision.
    await this.terminalizeOrphanedGate(gateId, { withdrawReason: reason });
  }

  /**
   * Terminalize a pending gate row that has no registered waiter. Guard: a
   * gate referenced by its thread's suspended-turn checkpoint is NOT an
   * orphan — reconciliation re-arms it for replay after a restart — so it is
   * left alone. Persists the terminal status, updates the DAG entry, and
   * emits the matching event so live clients drop the card.
   */
  private async terminalizeOrphanedGate(
    gateId: string,
    outcome: { resolution: DecisionResolution } | { withdrawReason: DecisionWithdrawReason },
  ): Promise<void> {
    const store = this.providers.store;
    const existing = await store.getDecisionGate(this.id, gateId);
    if (!existing || existing.status !== "pending") return;
    const suspended = await store.getSuspendedTurn(this.id, existing.threadId);
    if (suspended?.gateId === gateId) return;
    console.warn(
      `[engine] terminalizing orphaned decision gate ${gateId} (pending row, no registered waiter)`,
    );
    if ("resolution" in outcome) {
      // Stamp the gate's ordinal like every other resolve path, so the
      // persisted record and event stay self-describing for consumers that
      // distinguish replay double-fires from fresh repeats by ordinal.
      const resolution: DecisionResolution = {
        ...outcome.resolution,
        gateOrdinal: existing.ordinal,
      };
      await persistTerminalGate(store, this.id, existing.threadId, existing, {
        status: "resolved",
        resolution,
      });
      await this.emit(
        {
          type: "decision_gate_resolved",
          threadId: existing.threadId,
          gateId,
          resolution,
        },
        { eventKey: `gate:${gateId}:resolved` },
      );
      return;
    }
    await persistTerminalGate(store, this.id, existing.threadId, existing, {
      status: "withdrawn",
      reason: outcome.withdrawReason,
    });
    await this.emit(
      {
        type: "decision_gate_withdrawn",
        threadId: existing.threadId,
        gateId,
        reason: outcome.withdrawReason,
      },
      { eventKey: `gate:${gateId}:withdrawn` },
    );
  }

  async abort(opts: { threadId?: string } = {}): Promise<void> {
    if (opts.threadId) {
      await this.threads.get(opts.threadId)?.abort();
      return;
    }
    await Promise.all([...this.threads.values()].map((t) => t.abort()));
  }

  async pause(opts: { threadId?: string } = {}): Promise<void> {
    if (opts.threadId) {
      await this.threads.get(opts.threadId)?.pause();
      return;
    }
    await Promise.all([...this.threads.values()].map((t) => t.pause()));
  }

  async resume(opts: { threadId?: string } = {}): Promise<void> {
    if (opts.threadId) {
      await this.threads.get(opts.threadId)?.resume();
      return;
    }
    await Promise.all([...this.threads.values()].map((t) => t.resume()));
  }

  /** Required host cleanup runs after execution stops and before durable history is deleted. */
  async destroy(beforeStoreDelete?: () => Promise<void>): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    try {
      await Promise.all([...this.threads.values()].map((t) => t.abort()));
      await this.attachment.destroy();
      await beforeStoreDelete?.();
      await this.providers.store.deleteSession(this.id);
    } catch (err) {
      // A partial destroy must stay retryable. The delete routes call
      // destroy twice on purpose (the wake-race cover); a latched flag
      // turned the retry into a silent no-op, and the engine row plus
      // sandbox then outlived the delete with no owner left to reclaim
      // them (observed live on agents-dev).
      this.destroyed = false;
      throw err;
    }
  }

  async pendingDecisionGates(): Promise<DecisionGate[]> {
    return this.providers.store.listDecisionGates(this.id);
  }

  async readEntries(threadKey: string, opts?: MessageQuery): Promise<SessionEntry[]> {
    const t = await this.threadByKey(threadKey);
    if (!t) return [];
    return t.readEntries(opts);
  }

  /** Owning principal (Phase 4 decision 8). See `principal` field doc. */
  get owner(): Principal {
    return this.principal;
  }

  async toData(): Promise<SessionData> {
    return {
      id: this.id,
      owner: this.principal,
      userId: this.options.userId,
      orgId: this.options.orgId,
      workspace: this.options.workspace,
      purpose: this.options.purpose ?? "interactive",
      status: "running",
      sandboxId: this.attachment.sandboxId,
      parentSessionId: this.parentSessionId,
      parentThreadId: this.parentThreadId,
      // The canonical spec, not the wire id — `modelSpec` differs from
      // `model.id` whenever the host resolver returned a wire-ready model
      // for a namespaced spec (see `ResolvedModel.canonicalId`).
      model: this.options.modelSpec ?? this.options.model.id,
      reasoning: this.options.sampling?.reasoning,
      startRef: this.options.startRef,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Record the workspace start-ref (engine traces spec, change 2) — host
   * pattern (B), for hosts whose clone happens inside `prepareSandbox`.
   * Idempotent, single-shot: a repeat call with an identical ref is a no-op;
   * a call with a DIFFERENT ref throws `ValidationError` — a session's start
   * conditions are immutable by definition, so divergence indicates a host
   * bug, not a legitimate state change.
   */
  async setStartRef(ref: SessionStartRef): Promise<void> {
    const existing = this.options.startRef;
    if (existing) {
      const same =
        existing.repoUrl === ref.repoUrl &&
        existing.commitSha === ref.commitSha &&
        (existing.branch ?? undefined) === (ref.branch ?? undefined);
      if (same) return;
      throw new ValidationError(
        `session ${this.id} already has a start-ref (${existing.repoUrl}@${existing.commitSha}); refusing to overwrite with ${ref.repoUrl}@${ref.commitSha}`,
      );
    }
    this.options.startRef = ref;
    await this.providers.store.saveSession(await this.toData());
  }

  /**
   * Set this session's default model. Threads without their own override
   * pick this up on their next turn. Persists via `store.saveSession` and
   * emits `model_switched` (threadId omitted to indicate session scope).
   *
   * Pass a model id like "claude-opus-4-7" or "anthropic/claude-haiku-4-5".
   * Throws if the id can't be resolved.
   */
  async setModel(
    modelId: string,
    reason: string = "set_via_api",
  ): Promise<{ fromModel: string; toModel: string }> {
    const before = this.options.modelSpec ?? this.options.model.id;
    // With a host resolver present, validate through it (null → same "unknown
    // model id" surface as the internal resolver's undefined). Absent → today's
    // internal `resolveModelId` path, unchanged. NoCredentialsError means the
    // spec IS valid (the model resolved) but no key exists yet — accept it via
    // the attached model: a user must be able to select a model before
    // configuring its key.
    const resolver = this.options.resolveModel;
    let next: Model<any> | undefined;
    try {
      next = resolver ? (await resolver(modelId))?.model : resolveSessionModel(modelId);
    } catch (err) {
      if (!(err instanceof NoCredentialsError)) throw err;
      next = err.model;
    }
    if (!next) throw new Error(`unknown model id: ${modelId}`);
    this.options.model = next;
    // The caller's spec — NOT `next.id` — is the identity the session
    // persists and re-resolves (wire id may differ; ResolvedModel.canonicalId).
    this.options.modelSpec = modelId;
    await this.providers.store.saveSession(await this.toData());
    if (before !== modelId) {
      await this.emit({
        type: "model_switched",
        // session scope — no threadId. Bridge / wire types treat the
        // missing threadId as "session-level switch".
        threadId: undefined,
        fromModel: before,
        toModel: modelId,
        reason,
      });
    }
    return { fromModel: before, toModel: modelId };
  }

  /**
   * Set this session's default reasoning level. Threads without their own
   * pin pick it up on their next LLM call. Persists via `store.saveSession`
   * (SessionData.reasoning).
   *
   * Pass one of `REASONING_LEVELS`, or `null` to clear the default and let
   * the provider decide. Throws `ValidationError` on an unknown token; the
   * clamp to a model's supported levels happens at stream time, not here.
   */
  async setReasoning(level: string | null): Promise<void> {
    if (level === null) {
      if (this.options.sampling) this.options.sampling.reasoning = undefined;
    } else {
      // Validate before assigning so a bad token leaves the default intact.
      if (!isReasoningLevel(level)) {
        throw new ValidationError(
          `unknown reasoning level: ${level}. Valid levels: ${REASONING_LEVELS.join(", ")}.`,
        );
      }
      this.options.sampling = { ...this.options.sampling, reasoning: level };
    }
    await this.providers.store.saveSession(await this.toData());
  }

  async emit(event: EngineEvent, opts?: EmitOptions): Promise<void> {
    const busEvent: BusEvent = {
      sessionId: this.id,
      threadId: "threadId" in event ? (event.threadId as string | undefined) : undefined,
      queueItemId: opts?.queueItemId,
      userId: this.options.userId,
      event,
      timestamp: Date.now(),
    };
    // text_delta / tool_call_update are the high-frequency streaming plane —
    // never durable.
    if (event.type === "text_delta" || event.type === "tool_call_update") {
      this.providers.stream.publishEphemeral(busEvent);
      return;
    }
    // Events are the wakeup/UX plane; the store is truth. A durable append
    // failure on a non-critical path must not kill the turn — log and continue.
    // EXCEPTION (decision 12): a fenced append that rejects with
    // StaleAttemptError means a superseded/zombie attempt tried to land a
    // live-execution event — that's the attempt's stop signal, so it
    // rethrows. Every other failure (including a fenced append that fails
    // for some other reason) stays log-and-continue unless the caller marks
    // this append correctness-critical with `throwOnAppendError`.
    try {
      await this.providers.stream.append(busEvent, opts?.eventKey ?? uid("ev"), opts?.fence);
    } catch (err) {
      if (err instanceof StaleAttemptError || opts?.throwOnAppendError) throw err;
      console.error(
        `[engine] event append failed (session=${this.id}, type=${event.type}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ── credential provider for tools ───────────────────────────────

  credentialProvider(): CredentialProvider {
    // The session owner is the credential owner. A user session stays
    // `{ type: "user", id: userId }` because that is the default principal.
    // A team session must not read as the synthetic `team:{id}` actor.
    const owner: CredentialOwner = { type: this.principal.type, id: this.principal.id };
    const credStore = this.providers.credentials;
    // Host-provided resolver (Task 10 fix): when present it REPLACES the raw
    // store read for EVERY service — the host is the single decision point
    // (e.g. resolve `github` through the token service, delegate the rest to
    // the store itself). A resolver return of `null` yields `null`; there is
    // NO store fallback behind a resolver. Absent === byte-identical raw read.
    const resolver = this.options.credentialResolver;
    // Traced (distributed tracing): every credential access — host resolver
    // or raw store read — is one `credentials.get` span, nesting under the
    // running tool/turn span via the active context. Values never land on
    // the span; only the service name and hit/miss.
    const read = (service: string): Promise<StoredCredential | null> =>
      withSpan(
        "credentials.get",
        { "valet.credential.service": service, "valet.credential.via_resolver": !!resolver },
        async (span) => {
          const stored = resolver
            ? await resolver(owner, service)
            : credStore
              ? await credStore.get(owner, service)
              : null;
          span.setAttribute("valet.credential.hit", stored !== null);
          recordCredentialRead(service, stored !== null);
          return stored;
        },
      );
    return {
      async get(service?: string) {
        if (!resolver && !credStore) return null;
        if (!service) return null; // session-level provider has no default service
        const stored = await read(service);
        if (!stored) return null;
        return {
          accessToken: credentialSecret(stored) ?? "",
          refreshToken: stored.refreshToken,
          expiresAt: stored.expiresAt,
          scopes: stored.scopes,
          metadata: stored.metadata,
        };
      },
      async request(service: string, reason: string) {
        // V1 prototype: credential request is a decision gate too — but the
        // ToolContext.requestDecision in Thread is the canonical mechanism.
        // Here we only attempt to read; if missing, we throw.
        if (!resolver && !credStore) throw new Error(`credential ${service} not available (no store)`);
        const stored = await read(service);
        if (!stored) throw new Error(`credential ${service} not connected: ${reason}`);
        return {
          accessToken: credentialSecret(stored) ?? "",
          refreshToken: stored.refreshToken,
          expiresAt: stored.expiresAt,
          scopes: stored.scopes,
          metadata: stored.metadata,
        };
      },
    };
  }
}
