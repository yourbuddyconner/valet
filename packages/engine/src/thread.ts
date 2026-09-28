import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { isContextOverflow, streamSimple } from "@earendil-works/pi-ai/compat";
// Root import (not /compat): the transient classifier lives in pi-ai's
// utils and is only re-exported from the package root. It carries the
// provider-maintained retryable/permanent taxonomy (incl. the quota
// blacklist) — a hand-rolled copy would drift on every pi-ai upgrade.
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { classifyCacheBreak, type CacheTurnSnapshot } from "./cache-telemetry.js";
import { bundledModel } from "./model-catalog.js";
import { appendRuntimeModelContext } from "./model-context.js";
import { recordCacheBreak } from "./metrics.js";
import type { Api, ImageContent, JsonObject, Message, Model, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai/compat";

type PiModel = Model<Api>;
import type { Session, EmitOptions } from "./session.js";
import { toAgentTool } from "./tool-bridge.js";
import {
  DecisionGateExpiredError,
  DecisionGateWithdrawnError,
  findStickyTerminalGate,
  fromRequest,
  GateManager,
  isDecisionGateExpired,
  isDecisionGateWithdrawn,
  latestGateForResume,
  persistTerminalGate,
  shouldShortCircuit,
  type GateContext,
} from "./decision-gate.js";
import { renderTemplate } from "./roles-skills/index.js";
import {
  buildOverheardDigest,
  deriveQueueState,
  formatSenderLine,
  isOverheardDigestMeta,
  isSignalContent,
  MAX_PENDING_PER_THREAD,
  namespaceInternalDispatchId,
  overheardCoalesceKey,
  renderSignalEnvelope,
  resolvePartialSubmissionText,
  resolveSubmissionText,
  SIGNAL_HOP_BUDGET,
  validateSignalAttributeKeys,
  validateSignalTagName,
} from "./submission.js";
import { NoCredentialsError, NotFoundError, StaleAttemptError, TimeoutError, ValidationError } from "./errors.js";
import {
  isReasoningLevel,
  parseReasoningLevel,
  REASONING_LEVELS,
  resolveReasoningLevel,
  THREAD_REASONING_DISABLED,
  type ReasoningLevel,
} from "./reasoning.js";
import { extractStructuredOutput } from "./result-schema.js";
import { buildRepoInstructionsFragment } from "./repo-instructions.js";
import { formatFileAttachmentsNote } from "./file-attachment-formatter.js";
import { capturePatch } from "./patch-capture.js";
import {
  recordCompactionCoverageGap,
  recordGateUnownedExpired,
  recordSettlement,
  recordTurn,
} from "./metrics.js";
import {
  TRACEPARENT_METADATA_KEY,
  activeTraceparent,
  attrTruncate,
  engineTracer,
  linkFromTraceparent,
  markSpanError,
  withSpan,
} from "./tracing.js";
import { context as otelContext, trace as otelTrace, type Span } from "@opentelemetry/api";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import {
  applyPrune,
  estimateLiveContextTokens,
  estimateTokens,
  estimateSummaryEntryTokens,
  estimateTotalTokens,
  extractFileContext,
  inputSpillThreshold,
  planPrune,
  selectCutPoint,
  summarize,
  SummarizeOverflowError,
  usableTokens,
  walkTranscriptDag,
  selectSummaryCheckpointTail,
  type PruneResult,
  type SummarizeResult,
} from "./compaction.js";
import type {
  ActiveModelState,
  AwaitResultOptions,
  CompactionEntry,
  DecisionGate,
  DecisionGateRequest,
  DecisionResolution,
  DecisionWithdrawReason,
  EngineEvent,
  EngineEventStatus,
  MessageCost,
  MessagePart,
  MessageEntry,
  MessageQuery,
  MessageUsage,
  Principal,
  PromptAuthor,
  PromptContent,
  PromptOptions,
  PromptReceipt,
  QueueItem,
  QueueMode,
  QueueState,
  ResolvedModel,
  SessionEntry,
  SignalContent,
  SkillContextAttributionFact,
  SkillInvocationFact,
  SkillInvocationPath,
  SkillInvokeOptions,
  SkillSource,
  SettlePatchRef,
  SubmissionOutcome,
  SubmissionResult,
  SuspendedTurnState,
  ThreadData,
  ToolContext,
  ToolDef,
  WriteFence,
} from "./types.js";

/** Bound on `awaitResult`'s merged-constituent delegation chain (Task 6). */
const MAX_MERGE_DELEGATION_DEPTH = 5;

/**
 * Credential-less claim attempts before settling `failed` (2 releases + 1
 * terminal). Each attempt that hits the host resolver's `NoCredentialsError`
 * releases the claim back to `queued` until this cap; the capping attempt
 * settles the submission `failed` with the host's own error message. Keeps a
 * racing abort inside its window (the abort settles the item well inside the
 * first cycle) while bounding retries for a session whose LLM key is
 * genuinely missing. Tracked per-Thread in `credentialAttempts` (NOT the
 * store's `attemptCount`, which is shared with lease-expiry reconciliation —
 * a lease recycle must not burn the credential budget).
 */
const MAX_CREDENTIAL_ATTEMPTS = 3;

/**
 * Minimum spacing between COUNTED credential-release cycles. External kicks
 * (submitPrompt, resume, submitDecision, abort) fire `void this.kick()`
 * unconditionally, so without a floor a burst of user actions would burn all
 * MAX_CREDENTIAL_ATTEMPTS in milliseconds — the "5s sweep is the backoff"
 * intent would never be enforced. Releases landing inside this window still
 * release (the claim never sticks) but count as the SAME cycle: the budget
 * then meaningfully spans ~3 sweep cycles. Kept just under the sweep interval
 * so each 5s sweep tick counts. Tests override via
 * `CreateSessionOptions.credentialReleaseBackoffMs`.
 */
const CREDENTIAL_RELEASE_BACKOFF_MS = 4_000;

const AUTO_CONTINUE_PROMPT =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";

/** Turn-local guidance for manual-delivery Slack messages. `reply: "manual"`
 * prevents automatic posting but does not decide whether content is addressed.
 * A two-participant follow-up remains addressed by the channel convention.
 * Durable thread muting needs state in the followed-thread model, so this
 * instruction does not claim to provide it. */
const SLACK_OVERHEARD_REPLY_GUIDANCE = `## Slack overheard delivery

This Slack turn has manual delivery. Manual delivery prevents automatic posting. It does not by itself mean the message is unaddressed. Default to silence for overheard content. Never reply merely because the content is relevant, general, or solicits an update. Reply only to an explicit @mention, a direct request, or a follow-up from the only other participant in the thread. When the conversation context shows you are the only other participant, treat that person's follow-up as addressed and use reply_to_origin. If someone explicitly tells you to stop, remain silent in this thread until a fresh explicit request.`;

/** Proactive compaction stops retrying after this many consecutive failures (TKAI-306). */
const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3;

/**
 * Transport-level retry policy for turn LLM calls (TKAI-319). pi-ai's
 * retryProviderRequest honors Retry-After with abortable sleeps; delays the
 * server requests beyond the cap fail immediately so the turn-level layer
 * (or the user) decides with visibility.
 */
// 2 transport retries (SDK-default parity), not more: the turn-level layer
// above adds its own attempts, and the two multiply — 5 transport tries
// times 3 turn attempts held one queue item for 10+ minutes.
const TURN_STREAM_MAX_RETRIES = 2;
const TURN_STREAM_MAX_RETRY_DELAY_MS = 30_000;
const TURN_STREAM_TIMEOUT_MS = 600_000;

/**
 * Turn-level retry defaults for transient provider errors (TKAI-319),
 * applied only to unattended sessions (orchestrator, workflow, child). The
 * last backoff entry repeats when maxAttempts exceeds the list.
 */
const UNATTENDED_TURN_RETRY_ATTEMPTS = 2;
const UNATTENDED_TURN_RETRY_BACKOFF_MS = [10_000, 30_000];

/**
 * In-process background-drive registry: queue item ids whose turn is being
 * driven fire-and-forget by a Thread in THIS process (resume-after-restart
 * drives and gate replays — see `kickBackgroundDrive`).
 *
 * Why it exists: startup reconciliation's eager attempt takeover
 * (`decideReconciliation` step 0, `attemptLive`) is justified by "the
 * previous owner is gone by contract" — a restart replaced the process. A
 * same-process rebuild (the host's `evictCache` + `sessionFor`, or an
 * assistant build's epoch retry) breaks that premise: the previous owner's
 * drive is STILL RUNNING here, and stealing its attempt runs the same turn's
 * tools twice in one sandbox. `Session.reconcileItem` consults this registry
 * and treats a registered item as live (wait) regardless of lease state.
 *
 * Module-level deliberately: the registry must span Engine instances (each
 * rebuild constructs a fresh Engine over the same store). A pnpm-forked
 * duplicate copy of @valet/engine would split the map — the failure mode is
 * the pre-registry behavior (eager steal), never anything new.
 *
 * Refcounted so overlapping registrations of one item can never drop each
 * other's liveness early.
 */
const liveBackgroundDrives = new Map<string, number>();

function registerBackgroundDrive(itemId: string): void {
  liveBackgroundDrives.set(itemId, (liveBackgroundDrives.get(itemId) ?? 0) + 1);
}

function unregisterBackgroundDrive(itemId: string): void {
  const count = (liveBackgroundDrives.get(itemId) ?? 1) - 1;
  if (count <= 0) liveBackgroundDrives.delete(itemId);
  else liveBackgroundDrives.set(itemId, count);
}

/** True when a Thread in this process is currently driving `itemId`'s turn
 * in the background. Consulted by `Session.reconcileItem`. */
export function isItemDrivenInProcess(itemId: string): boolean {
  return liveBackgroundDrives.has(itemId);
}

/**
 * What a compaction pass achieved. "compacted" = a summary was persisted;
 * "pruned" = tool-output elision only; "noop" = the pass found nothing to
 * reclaim. Two outcomes mean compaction cannot help this thread as it
 * stands, for different reasons and with different fixes:
 *
 * - "insufficient": the newest turn alone exceeds the usable window, so
 *   summarizing older turns cannot bring the prompt under the limit. The fix
 *   is to shorten that turn (`context_overflow_unrecoverable`).
 * - "coverage_gap": the history the checkpoint must replace carries no text
 *   the summarizer can read, so a checkpoint over it would describe nothing.
 *   Shortening the newest turn cannot help. The fix is a fresh thread
 *   (`compaction_coverage_gap`).
 *
 * They are separate values because `/compact` prints one diagnosis per
 * outcome, and one message cannot name both fixes. Both emit their own
 * actionable error inside compactThreadInner, and neither changes between
 * attempts on the same transcript. Proactive callers treat "noop" and both
 * blocked outcomes as breaker-worthy: the trigger fired but compaction
 * cannot help, so retrying every turn is futile. The reactive caller treats
 * both as "do not retry": the overflow response already stands and a retry
 * would just overflow again. Add a blocked outcome here only with its own
 * user-facing message.
 */
export type CompactionOutcome =
  | "compacted"
  | "pruned"
  | "noop"
  | "insufficient"
  | "coverage_gap";

/**
 * Metadata key stamped on a user entry whose oversized text was spilled to a
 * sandbox file. Its value is the file path. Presence flags the entry so a
 * replayed turn returns the pointer, not the original paste.
 */
const SPILLED_INPUT_PATH_KEY = "valetSpilledInputPath";

/**
 * Build the in-context pointer that replaces an oversized inbound message
 * after its full text is spilled to `path` in the sandbox. The model reads
 * this instead of the raw paste and pages the file in slices.
 */
export function buildSpilledInputMarker(args: {
  path: string;
  tokens: number;
  chars: number;
}): string {
  return (
    `[Large input saved to a file]\n` +
    `Your message was about ${args.tokens} tokens (${args.chars} characters), too large to place in the context window directly. ` +
    `The full text is saved in the sandbox at:\n` +
    `  ${args.path}\n` +
    `Read it in slices, not all at once. For example: \`sed -n '1,400p' ${args.path}\`. ` +
    `Do not read the whole file in one call; that overflows the context again.`
  );
}

/**
 * The summarize call itself can overflow the summarizer model. Each retry
 * drops the oldest half of the head entries fed to the summarizer (the
 * CompactionEntry still covers the full head — the previous summary anchors
 * what the truncated input loses). Bounded like Claude Code's
 * prompt-too-long retry (TKAI-306).
 */
const MAX_SUMMARIZE_OVERFLOW_RETRIES = 3;
const SUMMARY_CHECKPOINT_TAIL_MAX_TOKENS = 8_000;
const SUMMARY_INPUT_MAX_TOKENS = 64_000;

/**
 * Build the user-facing text for a `turn_transient_retry` event (TKAI-325).
 * The old text embedded the raw provider error blob and read as an internal
 * Valet judgment. This version names the upstream cause, tells the reader
 * what to do if retries fail, and keeps the raw JSON out — the request ID
 * (when the error carries one) is enough for a support escalation. Exported
 * so tests can pin the copy without spinning up a whole retry loop.
 */
export function formatTransientRetryMessage(args: {
  provider: string;
  errorMessage: string | undefined;
  waitMs: number;
  attempt: number;
  maxAttempts: number;
}): string {
  const providerLabel = args.provider
    ? args.provider.charAt(0).toUpperCase() + args.provider.slice(1)
    : "The upstream provider";
  const requestId = args.errorMessage?.match(/request_id["':\s]+"?([A-Za-z0-9_-]+)"?/)?.[1];
  const seconds = Math.round(args.waitMs / 1000);
  const primary = `${providerLabel}'s API is unavailable or overloaded. The turn will retry automatically in ${seconds}s (attempt ${args.attempt}/${args.maxAttempts}).`;
  const detail = requestId
    ? ` If retries fail, switch to a different model or contact support (request ID: ${requestId}).`
    : " If retries fail, switch to a different model.";
  return primary + detail;
}

let nextId = 1;
function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

/** Plain unref'd sleep for retry backoff — abort is re-checked after it. */
function delay(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms) as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  });
}

function concreteModelId(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

/**
 * One Thread per (session, key). Owns its own pi-agent-core Agent instance,
 * its own queue, its own active leaf in the DAG, and its own GateManager.
 *
 * The queue is implemented at the engine level (not via pi-agent-core's
 * steeringQueue/followUpQueue): we want to control queueing across the
 * entire prompt lifecycle, including suspended states.
 */
export class Thread {
  readonly id: string;
  readonly key: string;
  private readonly session: Session;
  private agent: Agent;
  /** Persisted pause flag — the only stored piece of queue state. */
  private paused = false;
  private blockedGateId: string | undefined;
  /**
   * The most recent `status` event this instance emitted. In-memory only —
   * feeds `currentAgentStatus` so a client that connects mid-turn can seed
   * its status view without waiting for the next transition event.
   */
  private lastEmittedStatus: EngineEventStatus = "idle";
  /**
   * The submission currently being run by this instance (claimed → settled).
   * Set by the claim loop, held across the whole turn (including a gate block),
   * cleared when the turn settles. Replaces the old in-memory `activeItem`.
   */
  private runningItem: QueueItem | null = null;
  /** Handshake-visible active model state. This state is not persisted. */
  private committedModelState: ActiveModelState | null = null;
  /** Settling item whose idle model-state delivery still needs a retry. */
  private pendingModelStateClearQueueItemId: string | null = null;
  /** Serializes model-state appends and reconnect snapshots. */
  private modelStateTransitionTail: Promise<void> = Promise.resolve();
  /** Write fence for the claimed turn — `{ itemId, attemptId }`. Every store write during the turn carries it. */
  private fence: WriteFence | undefined;
  /**
   * Set when a fenced write throws StaleAttemptError mid-turn: a successor owns
   * the item, so the turn aborts and skips settlement (zombie self-fencing).
   */
  private staleFenceDetected = false;
  /** Serializes the claim loop; a second `kick()` while one is running joins the in-flight tail. */
  private kicking = false;
  private kickTail: Promise<void> = Promise.resolve();
  /** Tail of every background drive kicked via `kickBackgroundDrive` (resume
   * drives, gate replays). `abort()` joins it the same way it joins
   * `kickTail`, so teardown never proceeds under a still-writing turn. */
  private backgroundDriveTail: Promise<void> = Promise.resolve();
  /** In-process collect-window flush timer; armed by the first item of a window. */
  private collectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against the in-process timer and the session sweep both flushing the same window. */
  private flushingCollect = false;
  /** Serializes overheard-digest scans; concurrent admissions coalesce one at a time (TKAI-297). */
  private overheardCoalesceChain: Promise<QueueItem | null> = Promise.resolve(null);
  private gates = new GateManager();
  /**
   * Serializes gate open/wait cycles for this thread. pi-agent-core runs a
   * block's tool calls in parallel, so two gated calls race the strict
   * running↔blocked_on_decision_gate toggle and the single suspended-turn
   * checkpoint slot; the loser's gate persists as a pending row with no
   * waiter — an approval card no resolve can clear (TKAI-238).
   */
  private gateCycleTail: Promise<void> = Promise.resolve();
  private mode: QueueMode;
  private aborted = false;
  /**
   * Set by `runItem` when the host resolver threw `NoCredentialsError` at
   * turn start (the turn never appended a user entry or reached the model).
   * The claim loop reads it (`credentialError !== undefined`) to release the
   * claim back to `queued` rather than settling the submission `failed` — so
   * it stays abortable and re-runs once credentials resolve; the cap-path
   * settlement surfaces this exact HOST message, never a fabricated generic
   * one. Set ONLY by that explicit throw; reset at the start of every turn.
   * The bounded budget itself is DURABLE on the queue item
   * (`credentialAttempts`/`lastCredentialReleaseAt`), not Thread state.
   */
  private credentialError: NoCredentialsError | undefined;
  /**
   * The agent-run throw for the current turn, recorded independently of the
   * transcript: a stream that fails before its first `message_start` leaves
   * NO assistant message for this turn, and decideTurnOutcome deliberately
   * ignores stale trailing messages — without this field such a failure
   * would settle `completed`. Reset at the start of every turn; the claim
   * loop folds it into the turn failure after runItem returns.
   */
  private turnAgentError: unknown;
  private currentAssistantMessageId: string | undefined;
  private currentAssistantParts: MessagePart[] = [];
  private currentToolCalls = new Map<string, MessagePart>();
  /**
   * The persisted assistant entry for the current turn. Held so we can
   * `updateEntry` after each tool completes — without this, tool_call parts
   * stay frozen at status="running" in the store and reload shows them
   * stuck mid-execution.
   */
  private currentAssistantEntry: MessageEntry | undefined;
  private toolCtxOverlay: { gateId?: string } = {};
  private suspendedDecisionForReplay:
    | { gateId: string; ordinal: number; resolution?: DecisionResolution }
    | undefined;
  /** Token usage from the most recent assistant message, captured at turn_end. */
  private lastAssistantUsage:
    | { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
    | undefined;
  /** Wall clock at claim/resume — feeds `turn_end`'s `turnDurationMs`. */
  private turnStartedAt: number | undefined;
  /**
   * Live `submission.run` span for the currently-claimed item (distributed
   * tracing): started at claim, ended when the claim clears. Children
   * (`agent.turn`, `submission.settle`) parent under it via
   * `inSubmissionContext`. No-op Span when no SDK is registered.
   */
  private submissionSpan: Span | undefined;
  /** The running turn's `agent.turn` span — turn_end stamps usage/cost onto it. */
  private turnSpan: Span | undefined;
  /**
   * Live `llm.generate` span for the current assistant round (distributed
   * tracing). The engine doesn't own pi-ai's HTTP call, so the span is
   * synthesized from the agent's message lifecycle: started at
   * `message_start` with `llmRoundStartedAt` as the start time (pinned to
   * when the previous round's work finished, so request setup +
   * time-to-first-token are inside the span), ended at `message_end`.
   */
  private llmSpan: Span | undefined;
  /** When the current LLM round's request effectively began (turn start, or
   * the previous message/tool completion). */
  private llmRoundStartedAt: number | undefined;
  /** Tool calls across ALL rounds of the running turn (currentToolCalls is
   * per-round — it clears on each assistant message_start). */
  private turnToolCallCount = 0;
  /** True while a reactive (overflow) compaction is rerunning the failed turn. */
  private overflowRetryInProgress = false;
  /**
   * Set when a compaction pass in this turn reported an outcome that no
   * second pass can change: the newest turn is too large, or the head holds
   * no summarizer-readable text. The reactive path already emitted the
   * actionable error and counted the failure, so the post-turn proactive
   * check must not run the same pass again over the same context. Without
   * this the user saw one failure reported twice in one turn. Cleared at the
   * start of every turn.
   */
  private turnCompactionBlocked = false;
  /**
   * Consecutive proactive-compaction failures (TKAI-306). At
   * MAX_CONSECUTIVE_COMPACTION_FAILURES the proactive trigger opens the
   * circuit and stops retrying; any successful compaction (manual /compact
   * included) resets it. Claude Code's telemetry motivated the cap: sessions
   * with irrecoverably oversized context retried a doomed summarizer call on
   * every turn.
   */
  private consecutiveCompactionFailures = 0;
  /**
   * Content hashes from the model's file reads, backing the
   * read-before-write staleness gate (TKAI-318). In-memory only: after a
   * restart the model must re-read before writing, which is the
   * conservative behavior we want — the sandbox may have been rebuilt.
   */
  private readonly fileReadHashes = new Map<string, string>();
  /** Skill bodies that remain in this thread's live LLM context. */
  private readonly activeSkillInvocations = new Map<string, SkillInvocationFact>();
  /** Previous turn's cache snapshot for break classification (TKAI-320). */
  private prevCacheSnapshot: CacheTurnSnapshot | undefined;
  /**
   * True when a transcript was rehydrated from persisted entries (spec
   * decision 5). The next `runItemInner` consumes it: a pre-turn proactive
   * check protects the first post-restart turn — the regular check only
   * runs post-turn, so without this the first turn after a restart would
   * hit the model with an over-budget context.
   */
  private rehydratedCheckPending = false;
  /**
   * Per-thread model override (id string, e.g. "claude-opus-4-7"). When set,
   * overlays the session-default at turn start and is restored after.
   * Persisted via toThreadData → store.saveThread.
   */
  private modelOverride?: string;
  /**
   * Per-thread reasoning-level pin. When set, it outranks the session
   * default on every LLM call of this thread. Persisted via toThreadData →
   * store.saveThread. Clamped to the turn's model at stream time, never
   * here — see `resolveReasoningLevel`.
   */
  private reasoningOverride?: ReasoningLevel;
  /** True when this thread explicitly bypasses the session reasoning default. */
  private reasoningDisabled = false;
  /**
   * Agent-initiated escalation, scoped to the CURRENT turn (TKAI-338).
   *
   * `switch_model` exists so the agent can move to a stronger model when the
   * work turns out to be harder than it looked. That is a property of the
   * turn, not an edit to the user's setting, so it lives here rather than in
   * `modelOverride`, and is cleared when the turn settles.
   *
   * What actually carries the switch through the rest of the turn is
   * `agent.state.model` plus the `prepareNextTurn` hook, NOT this field: a
   * live decision gate blocks inside the agent loop and never unwinds
   * `runItem`, so the loop resumes on the model it was retargeted to. This
   * field is what makes the switch visible to `turnModelSpec` /
   * `resolveTurnModel` if any future path re-derives the spec mid-turn.
   * Today no such path runs with a live escalation — the two
   * `applyResolvedKeyForResume` callers are post-restart reconcile paths,
   * where this was never persisted and is always undefined.
   *
   * Deliberately NOT persisted. An api restart mid-turn resumes on the
   * user's model — the safe direction, and never a thread stranded on an
   * expensive model with nobody who chose it.
   */
  private agentModelSwitch?: string;
  /** Snapshot at turn resolution: a user can change the next turn's pin while this one runs. */
  private assignedModelSpec?: string;
  /** Set only after a role model resolves and is applied. Never persisted. */
  private roleModelSpec?: string;
  /**
   * Per-turn API key from the host `resolveModel` seam. Resolved at turn start
   * (fresh turns and resume/replay), read by the Agent's `getApiKey`, cleared
   * at turn end. Never cached across turns — key rotation applies next turn.
   * Always undefined when the session has no resolver (the Agent has no
   * `getApiKey` in that case, so this is never read).
   */
  private turnApiKey?: string;
  private readonly threadCreatedAt: number;
  /** Durable leaf used to link each new entry into the active transcript path. */
  private activeLeafEntryId: string | undefined;

  private entryAppendTail: Promise<void> = Promise.resolve();
  private transcriptPending: boolean;
  private transcriptLoad?: Promise<void>;

  constructor(session: Session, data: ThreadData, opts: { restoreTranscript?: boolean } = {}) {
    this.transcriptPending = opts.restoreTranscript ?? false;
    this.session = session;
    this.id = data.id;
    this.key = data.key;
    this.mode = data.queueMode;
    this.modelOverride = data.model;
    // An unrecognized persisted token degrades to "no pin" instead of
    // killing the rehydrate (parseReasoningLevel).
    this.reasoningOverride = parseReasoningLevel(data.reasoning);
    this.reasoningDisabled = data.reasoning === THREAD_REASONING_DISABLED;
    this.paused = data.paused ?? false;
    this.threadCreatedAt = data.createdAt || Date.now();
    this.activeLeafEntryId = data.activeLeafEntryId;
    this.agent = this.buildAgent();
  }

  /** Currently configured model id for this thread (or undefined to use session default). */
  modelId(): string | undefined {
    return this.modelOverride;
  }

  /** This thread's reasoning-level pin (or undefined to use the session default). */
  reasoning(): string | undefined {
    return this.reasoningOverride;
  }

  // ── public API ──────────────────────────────────────────────────

  pendingDecisionGates(): DecisionGate[] {
    return this.gates.pendingForThread(this.id);
  }

  isPendingGate(gateId: string): boolean {
    return this.gates.isPending(gateId);
  }

  resolveDecision(gateId: string, resolution: DecisionResolution): boolean {
    const ok = this.gates.resolve(gateId, resolution);
    if (ok) {
      // Persist the resolved status + DAG entry update. Both the live and
      // replay code paths short-circuit before the requestDecision
      // continuation; doing it here means the store is consistent for both.
      void this.persistGateResolution(gateId, resolution);
      void this.session.emit(
        {
          type: "decision_gate_resolved",
          threadId: this.id,
          gateId,
          resolution,
        },
        { eventKey: `gate:${gateId}:resolved` },
      );
    }
    return ok;
  }

  private async persistGateResolution(
    gateId: string,
    resolution: DecisionResolution,
  ): Promise<void> {
    const store = this.session.providers.store;
    const existing = await store.getDecisionGate(this.session.id, gateId);
    if (!existing) return;
    await persistTerminalGate(store, this.session.id, this.id, existing, {
      status: "resolved",
      resolution,
    });
  }

  withdrawDecision(gateId: string, reason: DecisionWithdrawReason): boolean {
    const ok = this.gates.withdraw(gateId, reason);
    if (ok) {
      void this.session.emit(
        {
          type: "decision_gate_withdrawn",
          threadId: this.id,
          gateId,
          reason,
        },
        { eventKey: `gate:${gateId}:withdrawn` },
      );
    }
    return ok;
  }

  async submitPrompt(content: PromptContent, opts: PromptOptions): Promise<PromptReceipt> {
    if (opts.promoteItemId) {
      throw new ValidationError(
        "submitPrompt does not accept promoteItemId. Call Thread.promoteQueuedItem to promote a queued item.",
      );
    }
    const effectiveMode: QueueMode = opts.queueMode ?? this.mode;

    // Validate a per-item model pin at admission, the same way setModel
    // validates a thread pin: an unknown spec is rejected here with the
    // submitter still on the line, instead of settling the turn `failed`
    // later.
    if (opts.model) {
      await this.validateModelSpec(opts.model);
    }

    if (effectiveMode === "collect") {
      return this.submitCollect(content, opts);
    }

    const skillFact = opts.skillInvocation
      ? this.buildSkillInvocationFact(
          opts.skillInvocation.skill,
          opts.skillInvocation.path,
          promptText(content),
          opts.author?.id ?? null,
        )
      : undefined;
    const prepared = this.prepareSubmissionContent(content, {
      ...opts,
      metadata: skillFact
        ? { ...opts.metadata, skillInvocation: skillFact }
        : opts.metadata,
    });

    const item = this.buildQueueItem(prepared.content, {
      dispatchId: prepared.dispatchId,
      author: opts.author,
      channel: opts.channel,
      replyTarget: opts.replyTarget,
      model: opts.model,
      role: opts.role,
      metadata: prepared.metadata,
    });

    // Steer admissions are exempt from the pending cap: the same atomic
    // `admitSubmission({ steer: true })` call supersedes every prior
    // unsettled item on the thread in the same transaction, so the count
    // they'd leave behind is always ~0-1 regardless of how many were pending
    // beforehand. For every other mode, the cap is enforced by the store
    // INSIDE the admission transaction (opts.maxPending) rather than via a
    // separate pre-check, so concurrent admissions can't race past it.
    const store = this.session.providers.store;
    const cap = this.session.options.maxPendingPerThread ?? MAX_PENDING_PER_THREAD;
    const { item: admitted, admitted: wasAdmitted, supersededItemIds } = await store.admitSubmission(
      this.session.id,
      this.id,
      item,
      effectiveMode === "steer" ? { steer: true } : { maxPending: cap },
    );
    if (skillFact && wasAdmitted) await this.persistSkillInvocation(skillFact);
    if (supersededItemIds.length > 0) {
      await this.handleSteerSupersession(supersededItemIds);
    }
    // Overheard-digest coalescing (TKAI-297): a freshly admitted overheard
    // signal merges with any other queued overheard items of its origin
    // thread. Skipped on a dispatchId dedup replay (wasAdmitted false) so a
    // channel redelivery cannot re-digest content it already delivered.
    // Scans are chained, not concurrent: two webhook deliveries admitting
    // in parallel would otherwise each scan before the other's digest
    // lands and produce two overlapping digests.
    let receiptItem = admitted;
    if (wasAdmitted && effectiveMode === "followup") {
      const coalesceKey = overheardCoalesceKey(prepared.content);
      if (coalesceKey !== undefined) {
        const run = this.overheardCoalesceChain.then(() =>
          this.coalesceQueuedOverheard(coalesceKey, item.author?.id),
        );
        this.overheardCoalesceChain = run.catch(() => null);
        receiptItem = (await run) ?? admitted;
      }
    }
    await this.emitQueueState();
    void this.kick();
    return {
      sessionId: this.session.id,
      threadId: this.id,
      queueItemId: receiptItem.id,
      status: receiptStatus(receiptItem.status),
    };
  }

  /**
   * Overheard-digest coalescing (TKAI-297): merge every queued overheard
   * item of one origin thread into a single digest item, so a busy thread
   * drains one "here is what you missed" turn instead of N stale catch-up
   * turns (and the model never answers a question a later message already
   * resolved). Same merge shape as the collect-window flush: admit the
   * digest, then settle each constituent `merged` pointing at it.
   * Constituents are never claimed, so they write no user entries; a
   * redelivery of a constituent's dispatchId still dedups against its
   * settled row. A constituent claimed between the list and the CAS settle
   * keeps running — its line then also appears in the digest, which is
   * duplicated ambient context on an optional-reply turn, not a lost or
   * doubled submission. Returns the digest item, or null when there was
   * nothing to merge with.
   */
  private async coalesceQueuedOverheard(coalesceKey: string, actorId?: string): Promise<QueueItem | null> {
    const store = this.session.providers.store;
    const items = await store.listUnsettledSubmissions(this.session.id);
    const coalescible = items
      .filter(
        (i) =>
          i.threadId === this.id &&
          i.status === "queued" &&
          i.supersededByItemId === undefined &&
          i.abortRequestedAt === undefined &&
          i.author?.id === actorId &&
          overheardCoalesceKey(i.content) === coalesceKey,
      )
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (coalescible.length < 2) return null;
    const { content, digest } = buildOverheardDigest(coalescible);
    const newest = coalescible[coalescible.length - 1];
    const merged = this.buildQueueItem(content, {
      channel: newest.channel,
      replyTarget: newest.replyTarget,
      model: newest.model,
      role: newest.role,
      author: newest.author,
      metadata: { overheardDigest: digest },
    });
    const { item: admittedMerged } = await store.admitSubmission(this.session.id, this.id, merged);
    for (const constituent of coalescible) {
      const settled = await store.settleUnclaimed(
        this.session.id,
        this.id,
        constituent.id,
        { outcome: "merged" },
        { mergedIntoItemId: admittedMerged.id },
      );
      if (settled) await this.emitSettled(constituent.id, { outcome: "merged" });
    }
    return admittedMerged;
  }

  /**
   * Crash repair for overheard digests (TKAI-297). `coalesceQueuedOverheard`
   * admits the digest first and settles constituents after — a crash between
   * the two leaves the digest AND its constituents queued, so the thread
   * would deliver the same messages twice. This repair exists for that crash
   * window (the sanctioned auto-repair exception: violations expected across
   * crashes): for every queued digest, re-settle its still-queued
   * constituents `merged`. The settleUnclaimed CAS makes it idempotent, and
   * a constituent that was claimed in the meantime is left alone. Called
   * from the session sweep and from restore-time reconcile, both before
   * their kicks, so a repairable constituent settles before it can be
   * claimed.
   */
  async repairOverheardDigests(snapshot?: readonly QueueItem[]): Promise<void> {
    const store = this.session.providers.store;
    const items = snapshot ?? await store.listUnsettledSubmissions(this.session.id);
    const mine = items.filter((i) => i.threadId === this.id);
    for (const digest of mine) {
      if (digest.status !== "queued" || digest.supersededByItemId !== undefined) continue;
      const meta = digest.metadata?.overheardDigest;
      if (!isOverheardDigestMeta(meta)) continue;
      for (const constituentId of meta.constituentIds) {
        const constituent = mine.find((i) => i.id === constituentId && i.status === "queued");
        if (!constituent) continue;
        const settled = await store.settleUnclaimed(
          this.session.id,
          this.id,
          constituentId,
          { outcome: "merged" },
          { mergedIntoItemId: digest.id },
        );
        if (settled) await this.emitSettled(constituentId, { outcome: "merged" });
      }
    }
  }

  /**
   * Promote a queued followup into a steer. The promotion-specific steer
   * scope supersedes the running turn and original queued source while
   * preserving queued siblings. The successor is atomically placed at the
   * runnable head. The original item is never claimed, so it does not write
   * a second user entry. The caller remaps the optimistic bubble onto the
   * returned `queueItemId`.
   */
  async promoteQueuedItem(itemId: string): Promise<PromptReceipt> {
    const store = this.session.providers.store;
    const existing = await store.getQueueItem(this.session.id, itemId);
    if (!existing || existing.threadId !== this.id) {
      throw new NotFoundError("queue item", itemId);
    }
    if (existing.status !== "queued" || existing.supersededByItemId) {
      throw new ValidationError(
        "That message is no longer queued. Send a new message, or wait for the current turn to finish.",
      );
    }
    const item = this.buildQueueItem(existing.content, {
      author: existing.author,
      channel: existing.channel,
      replyTarget: existing.replyTarget,
      model: existing.model,
      role: existing.role,
      metadata: { ...(existing.metadata ?? {}), promotedFromItemId: existing.id },
    });
    const { item: admitted, supersededItemIds } = await store.admitSubmission(
      this.session.id,
      this.id,
      item,
      {
        steer: true,
        steerScope: "active-and-source",
        promoteFromItemId: existing.id,
      },
    );
    if (supersededItemIds.length > 0) {
      await this.handleSteerSupersession(supersededItemIds);
    }
    await this.emitQueueState();
    void this.kick();
    return {
      sessionId: this.session.id,
      threadId: this.id,
      queueItemId: admitted.id,
      status: receiptStatus(admitted.status),
    };
  }

  /**
   * Steer supersession (Task 4, design decision 3): the durable supersession
   * stamp already landed atomically inside `admitSubmission({ steer: true })`
   * before this runs — so a gate-resolution race against a superseded item is
   * always a no-op by the time it could matter. Here we (1) withdraw any
   * pending gate owned by this thread (only the running turn can have one),
   * (2) settle every superseded item that never had a live attempt via
   * `settleUnclaimed` (a no-op / false for the currently-running item, which
   * settles through its own attempt's interrupted-handler / decideTurnOutcome
   * precedence instead), then (3) if the running item was superseded, abort
   * the live agent run so its turn unblocks and settles. The claim loop
   * (`kickLoop`'s `while (true)`) picks up the new head — the steer item —
   * once the running turn's settlement completes; no separate claim step is
   * needed here.
   */
  private async handleSteerSupersession(supersededItemIds: string[]): Promise<void> {
    const store = this.session.providers.store;
    const runningId = this.runningItem?.id;
    const runningSuperseded = runningId !== undefined && supersededItemIds.includes(runningId);
    // Abort synchronously, before any awaited I/O below, so a tool blocked on
    // a decision gate sees the signal already set once its withdrawal
    // propagates — otherwise the awaits in the settleUnclaimed loop give the
    // agent loop's tool-error follow-up call a chance to race ahead.
    // `Agent.abort()`/`waitForIdle()` are safe no-ops when nothing is running.
    if (runningSuperseded) {
      this.agent.abort();
    }
    for (const g of this.pendingDecisionGates()) {
      this.withdrawDecision(g.id, "steer");
    }
    for (const id of supersededItemIds) {
      await store.settleUnclaimed(this.session.id, this.id, id, { outcome: "superseded" });
      await this.emitSettled(id, { outcome: "superseded" });
    }
    if (runningSuperseded) {
      await this.agent.waitForIdle();
    }
  }

  /**
   * Collect-mode admission (Task 4): admits with status "collecting" and a
   * durable `metadata.collectDeadline`. dispatchId dedup applies at admission
   * via the same `admitSubmission` idempotency the other modes use. Arms an
   * in-process flush timer for the window; `Session.sweepOnce` additionally
   * flushes any window whose deadline has already passed (covers a deadline
   * elapsing while the process was down between the timer arming and firing).
   */
  private async submitCollect(content: PromptContent, opts: PromptOptions): Promise<PromptReceipt> {
    const store = this.session.providers.store;
    const windowMs = this.session.options.collectWindowMs ?? 5000;
    const base = this.buildQueueItem(content, {
      dispatchId: opts.dispatchId,
      author: opts.author,
      channel: opts.channel,
      replyTarget: opts.replyTarget,
      model: opts.model,
      role: opts.role,
      metadata: opts.metadata,
    });
    const deadline = base.createdAt + windowMs;
    const item: QueueItem = {
      ...base,
      status: "collecting",
      metadata: { ...(base.metadata ?? {}), collectDeadline: deadline },
    };
    const { item: admittedItem, admitted: wasAdmitted } = await store.admitSubmission(
      this.session.id,
      this.id,
      item,
    );
    await this.emitQueueState();
    if (wasAdmitted) {
      this.armCollectTimer(
        typeof admittedItem.metadata?.collectDeadline === "number"
          ? admittedItem.metadata.collectDeadline
          : deadline,
      );
    }
    return {
      sessionId: this.session.id,
      threadId: this.id,
      queueItemId: admittedItem.id,
      status: receiptStatus(admittedItem.status),
    };
  }

  private armCollectTimer(deadline: number): void {
    if (this.collectTimer) return; // window already open; flush reads all live constituents when it fires
    const delay = Math.max(0, deadline - Date.now());
    const timer = setTimeout(() => {
      this.collectTimer = null;
      void this.flushCollectWindow();
    }, delay);
    timer.unref?.();
    this.collectTimer = timer;
  }

  /**
   * Session-sweep hook (Task 4 design point 2): flush a collect window whose
   * deadline has already passed even if no in-process timer is live for it
   * (e.g. the timer never got armed this process, or restart — reconciliation
   * proper is Task 5, this is just the safety net the sweep owns).
   */
  async checkCollectDeadline(snapshot?: readonly QueueItem[]): Promise<void> {
    const store = this.session.providers.store;
    const items = snapshot ?? await store.listUnsettledSubmissions(this.session.id);
    const collecting = items.filter((i) => i.threadId === this.id && i.status === "collecting");
    if (collecting.length === 0) return;
    const now = Date.now();
    const earliestDeadline = Math.min(
      ...collecting.map((i) =>
        typeof i.metadata?.collectDeadline === "number" ? i.metadata.collectDeadline : now,
      ),
    );
    if (earliestDeadline <= now) {
      await this.flushCollectWindow();
    }
  }

  /**
   * Flush the collect window: merge every currently-collecting item of this
   * thread (oldest-first, numbered-concatenation content — the same merge
   * shape the legacy in-memory `flushCollectBuffer` used) into one durable
   * item, settle each constituent `merged` pointing at it, then kick. Guarded
   * against the in-process timer and the session sweep both firing for the
   * same window (only the synchronous prefix before the first await runs
   * unconditionally, so the flag correctly serializes the two triggers).
   */
  private async flushCollectWindow(): Promise<void> {
    if (this.flushingCollect) return;
    this.flushingCollect = true;
    try {
      if (this.collectTimer) {
        clearTimeout(this.collectTimer);
        this.collectTimer = null;
      }
      const store = this.session.providers.store;
      const items = await store.listUnsettledSubmissions(this.session.id);
      const collecting = items
        .filter((i) => i.threadId === this.id && i.status === "collecting")
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (collecting.length === 0) return;

      const mergedContent = collecting
        .map((it, i) => `[${i + 1}] ${promptText(it.content)}`)
        .join("\n\n");
      const merged = this.buildQueueItem(mergedContent, {
        // Collect mode has no v2 producer today (REST rejects it; no
        // session sets it). If one lands, a multi-author window needs
        // per-constituent authors — this first-item stamp would credit
        // every constituent's text to one sender in the transcript and UI.
        author: collecting[0].author,
        channel: collecting[0].channel,
        replyTarget: collecting[0].replyTarget,
        model: collecting[0].model,
        metadata: { collect: { constituentIds: collecting.map((i) => i.id) } },
      });
      const { item: admittedMerged } = await store.admitSubmission(this.session.id, this.id, merged);
      for (const constituent of collecting) {
        await store.settleUnclaimed(
          this.session.id,
          this.id,
          constituent.id,
          { outcome: "merged" },
          { mergedIntoItemId: admittedMerged.id },
        );
        await this.emitSettled(constituent.id, { outcome: "merged" });
      }
      await this.emitQueueState();
      void this.kick();
    } finally {
      this.flushingCollect = false;
    }
  }

  /**
   * Validates + stamps a signal admission (plan decision 2/4). Non-signal
   * content passes through untouched. For signal content: defaults/validates
   * `tagName`, and — when `opts.internalSender` is set — enforces the hop
   * budget, requires `dispatchId`, namespaces it by the sender session id,
   * and stashes the stamped identity in `metadata.signalStamp` so `runItem`
   * can carry it onto the persisted `MessageEntry.signal` (QueueItem has no
   * dedicated field for it; `metadata` already flows through to the entry).
   * Throws `ValidationError` on any admission-time violation.
   */
  private prepareSubmissionContent(
    content: PromptContent,
    opts: PromptOptions,
  ): { content: PromptContent; dispatchId?: string; metadata?: Record<string, unknown> } {
    if (!isSignalContent(content)) {
      if (opts.internalSender) {
        throw new ValidationError("internalSender is only valid for signal content");
      }
      return { content, dispatchId: opts.dispatchId, metadata: opts.metadata };
    }

    const tagName = content.tagName ?? "signal";
    validateSignalTagName(tagName);
    validateSignalAttributeKeys(content.attributes);
    const normalized: SignalContent = { ...content, tagName };

    if (!opts.internalSender) {
      return { content: normalized, dispatchId: opts.dispatchId, metadata: opts.metadata };
    }

    if (!opts.dispatchId) {
      throw new ValidationError("internal signal admission requires opts.dispatchId");
    }
    const budget = this.session.options.signalHopBudget ?? SIGNAL_HOP_BUDGET;
    const hopCount = (opts.internalSender.hopCount ?? 0) + 1;
    if (hopCount > budget) {
      throw new ValidationError(
        `signal hop budget exceeded: hopCount ${hopCount} > budget ${budget}`,
      );
    }
    const stamp: SignalStamp = {
      senderSessionId: opts.internalSender.sessionId,
      senderOwner: opts.internalSender.owner,
      hopCount,
    };
    return {
      content: normalized,
      dispatchId: namespaceInternalDispatchId(opts.internalSender.sessionId, opts.dispatchId),
      metadata: { ...(opts.metadata ?? {}), signalStamp: stamp },
    };
  }

  private buildQueueItem(
    content: PromptContent,
    fields: {
      dispatchId?: string;
      author?: PromptAuthor;
      channel?: QueueItem["channel"];
      replyTarget?: QueueItem["replyTarget"];
      model?: string;
      role?: string;
      metadata?: Record<string, unknown>;
    },
  ): QueueItem {
    const now = Date.now();
    // Distributed tracing: stamp the admitting request's traceparent so the
    // eventual `submission.run` span can LINK back to it (the admission span
    // ends long before the turn runs, so a link — not a parent — is correct).
    const traceparent = activeTraceparent();
    const metadata = traceparent
      ? { ...(fields.metadata ?? {}), [TRACEPARENT_METADATA_KEY]: traceparent }
      : fields.metadata;
    return {
      id: uid("q"),
      threadId: this.id,
      dispatchId: fields.dispatchId,
      content,
      author: fields.author,
      channel: fields.channel,
      replyTarget: fields.replyTarget,
      model: fields.model,
      role: fields.role,
      metadata,
      status: "queued",
      attemptCount: 0,
      maxAttempts: 10,
      timeoutAt: now + 3_600_000,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Invoke a registered skill. Looks up the skill by name in
   * session.skills, validates args against the skill's argsSchema (if
   * present) via TypeBox's runtime checker, renders the skill content
   * with `{{var}}` interpolation, and submits the result as a normal
   * prompt with optional model/role/resultSchema overrides forwarded.
   */
  async skill(name: string, opts: SkillInvokeOptions = {}): Promise<PromptReceipt> {
    const skill = this.session.skills.get(name);
    if (!skill) {
      throw new Error(
        `skill "${name}" not registered on this session. Known: ${[...this.session.skills.keys()].join(", ") || "(none)"}`,
      );
    }
    const args = opts.args ?? {};
    if (skill.argsSchema) {
      const validator = Compile(skill.argsSchema as TSchema);
      if (!validator.Check(args)) {
        const errors = [...validator.Errors(args)]
          .map((e) => `  - ${e.instancePath || "(root)"}: ${e.message}`)
          .join("\n");
        throw new Error(`skill "${name}" args failed validation:\n${errors}`);
      }
    }
    const rendered = renderTemplate(skill.content, args);
    return this.submitPrompt(rendered, {
      author: opts.author,
      channel: opts.channel,
      model: opts.model,
      role: undefined, // role not currently part of SkillInvokeOptions; see types.ts
      resultSchema: opts.resultSchema,
      metadata: { skill: name, syntheticFrom: "skill" },
      skillInvocation: { skill, path: "host_thread_skill" },
    });
  }

  private replaceActiveSkillInvocations(entries: readonly SessionEntry[]): void {
    this.activeSkillInvocations.clear();
    for (const fact of skillInvocationsInContext(entries, this.activeLeafEntryId)) {
      this.activeSkillInvocations.set(fact.id, fact);
    }
  }

  private buildSkillInvocationFact(
    skill: SkillSource,
    path: SkillInvocationPath,
    injectedText: string,
    invokerUserId: string | null,
    id = uid("ski"),
  ): SkillInvocationFact {
    return {
      id,
      createdAt: Date.now(),
      sessionId: this.session.id,
      threadId: this.id,
      invokerUserId,
      invocationEntryId: null,
      path,
      skillKey: skill.key ?? `${skill.source ?? "repo"}:${skill.name}`,
      skillName: skill.name,
      storedSkillId: skill.storedSkillId ?? null,
      pluginName: skill.pluginName ?? null,
      origin: skill.origin ?? (skill.source === "plugin" ? "plugin" : skill.source === "repo" ? "repo" : "local"),
      contentSha: skill.contentSha ?? `unversioned:${skill.content.length}`,
      injectedCharacters: injectedText.length,
      estimatedBodyTokens: estimateTokens(injectedText),
    };
  }

  private async persistSkillInvocation(fact: SkillInvocationFact): Promise<void> {
    try {
      await this.session.options.skillTelemetry?.recordInvocation(fact);
    } catch (err) {
      console.error("skill invocation telemetry write failed:", err);
    }
  }

  private async recordModelToolSkillInvocation(
    skill: SkillSource,
    path: "model_tool",
    injectedText: string,
    toolCallId: string,
  ): Promise<SkillInvocationFact> {
    const fact = this.buildSkillInvocationFact(
      skill,
      path,
      injectedText,
      this.runningItem?.author?.id ?? null,
      `ski:${this.session.id}:${this.id}:${toolCallId}`,
    );
    await this.persistSkillInvocation(fact);
    this.activeSkillInvocations.set(fact.id, fact);
    return fact;
  }

  private async persistSkillContextAttributions(): Promise<void> {
    const sink = this.session.options.skillTelemetry;
    if (!sink || this.activeSkillInvocations.size === 0) return;
    const requestId = uid("llm");
    const createdAt = Date.now();
    const facts: SkillContextAttributionFact[] = [...this.activeSkillInvocations.values()].map(
      (invocation) => ({
        skillInvocationId: invocation.id,
        llmRequestId: requestId,
        sessionId: this.session.id,
        threadId: this.id,
        createdAt,
        estimatedSkillTokens: invocation.estimatedBodyTokens,
      }),
    );
    try {
      await sink.recordContextAttributions(facts);
    } catch (err) {
      console.error("skill context attribution telemetry write failed:", err);
    }
  }

  /** Interrupt one active submission and preserve queued work on this thread. */
  async interrupt(targetItemId: string): Promise<void> {
    if (this.runningItem?.id === targetItemId) {
      await this.abortSubmission(targetItemId);
      return;
    }
    // The durable claim can precede this.runningItem during claim and restore.
    // Match the gesture target atomically so a successor cannot inherit a retry.
    const active = await this.session.providers.store.requestAbortActiveSubmission(
      this.session.id,
      this.id,
      targetItemId,
    );
    if (active) {
      await this.abortSubmission(active.id);
      return;
    }
    void this.kick();
  }

  /** Cancel one submission without aborting other work on this thread. */
  async abortSubmission(queueItemId: string): Promise<void> {
    const store = this.session.providers.store;
    // Mark the live item before I/O so a stale store read cannot start it.
    if (this.runningItem?.id === queueItemId) this.runningItem.abortRequestedAt ??= Date.now();
    await store.requestAbort(this.session.id, this.id, queueItemId);
    const running = this.runningItem?.id === queueItemId;
    if (running && this.runningItem) {
      this.runningItem.abortRequestedAt ??= Date.now();
      this.agent.abort();
    }
    for (const gate of this.pendingDecisionGates()) {
      if (gate.queueItemId === queueItemId) this.withdrawDecision(gate.id, "abort");
    }
    const settled = await store.settleUnclaimed(this.session.id, this.id, queueItemId, { outcome: "aborted" });
    if (settled) await this.emitSettled(queueItemId, { outcome: "aborted" });
    if (running) await this.agent.waitForIdle();
    await this.emitQueueState();
    void this.kick();
  }

  async abort(): Promise<void> {
    this.aborted = true;
    if (this.collectTimer) {
      clearTimeout(this.collectTimer);
      this.collectTimer = null;
    }
    const store = this.session.providers.store;
    // Durable intent first: stamps abortRequestedAt on unsettled items so the
    // in-flight turn's settlement records `aborted`, and so a crash mid-abort
    // still reconciles to aborted.
    await store.requestAbort(this.session.id, this.id);
    // Withdraw any pending gates owned by this thread.
    for (const g of this.pendingDecisionGates()) {
      this.withdrawDecision(g.id, "abort");
    }
    // Interrupt the in-flight turn (if any) and let the claim loop drain — its
    // settlement path records the running item `aborted`.
    if (this.agent.state.isStreaming) {
      this.agent.abort();
      await this.agent.waitForIdle();
    }
    await this.kickTail;
    // Join background drives (resume-after-restart, gate replays) the same
    // way: the pending-gate withdrawal above already unparked any drive
    // waiting on a gate, and requestAbort's stamp makes its settlement record
    // `aborted`. Without this join, Session.destroy tears down rows and
    // sandbox under a still-writing resumed turn.
    await this.backgroundDriveTail;
    // Settle any never-claimed (queued/collecting) items `aborted`.
    const unsettled = await store.listUnsettledSubmissions(this.session.id);
    for (const it of unsettled) {
      if (it.threadId !== this.id) continue;
      if (it.status === "queued" || it.status === "collecting") {
        await store.settleUnclaimed(this.session.id, this.id, it.id, { outcome: "aborted" });
        await this.emitSettled(it.id, { outcome: "aborted" });
      }
    }
    await this.emitQueueState();
  }

  async pause(): Promise<void> {
    this.paused = true;
    await this.session.providers.store.saveThread(this.session.id, this.toThreadData());
    await this.emitQueueState();
  }

  async resume(): Promise<void> {
    if (this.paused) {
      this.paused = false;
      await this.session.providers.store.saveThread(this.session.id, this.toThreadData());
      await this.emitQueueState();
    }
    // Resume is also the explicit recovery control for a durable queued item
    // with no local claim (for example, after credential release).
    void this.kick();
  }

  /**
   * Used by Engine.restoreSession to seed replay state before re-running a
   * blocked tool. When the tool calls requestDecision with a matching
   * resumeKey, the engine returns the stored resolution immediately.
   */
  setReplayContext(
    ctx: { gateId: string; ordinal: number; resolution?: DecisionResolution } | undefined,
  ): void {
    this.suspendedDecisionForReplay = ctx;
  }

  /**
   * Re-run a suspended tool with seeded suspendedDecision, push its result onto
   * the agent transcript, continue the agent loop, then settle the resumed turn.
   * Driven by `reconcileGate` (directly for a resolved gate, or via
   * `armPendingGateForRestart` once a re-armed pending gate resolves). Runs
   * under the fresh fenced attempt `reconcileGate` installed.
   */
  async replayBlocked(args: {
    suspended: SuspendedTurnState;
    resolution: DecisionResolution;
  }): Promise<void> {
    const { suspended, resolution } = args;
    const tools = this.buildTools();
    const tool = tools.find((t) => t.name === suspended.toolName);
    if (!tool) {
      this.emitError(
        "replay_tool_missing",
        `cannot replay: tool ${suspended.toolName} not registered`,
      );
      return;
    }
    this.setReplayContext({ gateId: suspended.gateId, ordinal: suspended.ordinal, resolution });
    // The deterministic gate ID is derived from
    // (sessionId, threadId, queueItemId, resumeKey, ordinal). During replay,
    // the tool's requestDecision call recomputes this from the active queue
    // item — so we must mirror the original queueItemId here, otherwise
    // the short-circuit won't match and the tool will try to open a
    // brand-new gate.
    const priorActive = this.runningItem;
    this.runningItem = {
      id: suspended.queueItemId,
      threadId: this.id,
      content: "",
      status: "running",
      attemptCount: 0,
      maxAttempts: 10,
      timeoutAt: suspended.createdAt + 3_600_000,
      createdAt: suspended.createdAt,
      updatedAt: Date.now(),
    };
    const fakeAbort = new AbortController();
    let toolResult;
    try {
      toolResult = await tool.execute(
        suspended.toolCallId,
        suspended.toolArgs,
        fakeAbort.signal,
      );
    } catch (err) {
      this.runningItem = priorActive;
      this.emitError(
        "replay_tool_failed",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    this.runningItem = priorActive;
    this.agent.state.messages = [
      ...this.agent.state.messages,
      {
        role: "toolResult",
        toolCallId: suspended.toolCallId,
        toolName: suspended.toolName,
        content: toolResult.content,
        details: toolResult.details,
        isError: false,
        timestamp: Date.now(),
      },
    ];
    // Persist the replayed tool_call part as completed so terminalization's
    // rest-state repair doesn't later rewrite it to an interrupted-error: the
    // tool DID run to completion on replay (its result was pushed above), it
    // just didn't flow through the agent loop's tool_execution_end.
    await this.persistReplayedToolResult(suspended.toolCallId, toolResult);
    await this.session.providers.store.clearSuspendedTurn(this.session.id, this.id, this.fence);
    this.blockedGateId = undefined;
    // Drive the continuation, recording any failure for settlement — a
    // keyless resume (applyResolvedKeyForResume rethrows NoCredentialsError
    // rather than continuing on pi-ai's ambient env fallback) and a
    // continuation stream failure both settle the turn `failed` instead of
    // wedging or mislabeling it.
    let continueError: unknown;
    const baselineModel = this.agent.state.model;
    try {
      // Host resolver (if any) delivers this resumed turn's per-turn key
      // before the continuation LLM call; no-op when absent.
      await this.applyResolvedKeyForResume(this.runningItem ?? undefined);
      const runningItem = this.runningItem;
      if (
        runningItem &&
        await this.publishActiveModelState(runningItem.id, this.agent.state.model)
      ) {
        await this.agent.continue();
        await this.agent.waitForIdle();
      }
    } catch (err) {
      continueError = err;
      this.emitError(
        "replay_continue_failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.agent.state.model = baselineModel;
      this.turnApiKey = undefined;
    }
    // Settle the resumed turn (reconciliation owns a fresh fenced attempt via
    // reconcileGate). Flip the durable block back to running first so
    // settleTurn's terminal transition is legal, then settle normally.
    if (this.fence && this.runningItem) {
      const store = this.session.providers.store;
      const fence = this.fence;
      const settleItem = this.runningItem;
      try {
        const current = await store.getQueueItem(this.session.id, settleItem.id);
        if (current?.status === "blocked_on_decision_gate") {
          await this.fencedWrite(() =>
            store.setSubmissionBlocked(this.session.id, this.id, settleItem.id, false, fence),
          );
        }
        try {
          await this.settleTurn(
            settleItem,
            continueError !== undefined ? { error: continueError } : undefined,
          );
        } catch (err) {
          this.emitError("settlement_failed", err instanceof Error ? err.message : String(err));
        }
      } finally {
        await this.clearActiveModelState(settleItem.id, { finalizeLocal: true });
        if (this.staleFenceDetected) {
          try {
            await store.deleteAttemptMarker(settleItem.id, fence.attemptId);
          } catch (err) {
            this.emitError(
              "stale_marker_cleanup_failed",
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        this.runningItem = null;
        this.fence = undefined;
        // The escalation dies with the turn that requested it — including a
        // turn that finished on the gate-resume path rather than the claim loop.
        this.agentModelSwitch = undefined;
        void this.kick();
      }
    }
    await this.emitQueueState();
  }

  /**
   * Mark the persisted assistant tool_call part matching `toolCallId` as
   * completed with the replayed result — a fenced in-place update mirroring the
   * live tool_execution_end path.
   */
  private async persistReplayedToolResult(
    toolCallId: string,
    result: { content?: unknown; details?: unknown },
  ): Promise<void> {
    const store = this.session.providers.store;
    const entries = await store.getEntries(this.session.id, this.id);
    for (const e of entries) {
      if (e.type !== "message" || e.role !== "assistant" || !e.parts) continue;
      const part = e.parts.find(
        (p) => p.type === "tool_call" && p.callId === toolCallId,
      );
      if (part && part.type === "tool_call") {
        part.status = "completed";
        const structured =
          result && typeof result === "object" ? (result as Record<string, unknown>) : {};
        part.result = { ...structured, text: renderToolResult(result) };
        await this.fencedWrite(() =>
          store.updateEntry(this.session.id, this.id, e, this.fence),
        );
        return;
      }
    }
  }

  /**
   * Re-arm the GateManager for a still-pending gate after restart, so a
   * future resolveDecision triggers replay.
   */
  armPendingGateForRestart(gate: DecisionGate, suspended: SuspendedTurnState): void {
    this.blockedGateId = gate.id;
    this.gates
      .register(gate, () => {
        // Terminalization is driven off the promise rejection below (which the
        // GateManager fires alongside this callback), so this stays a no-op.
      })
      .then((resolution) => {
        this.kickBackgroundDrive("replay_drive_rejected", suspended.queueItemId, undefined, () =>
          this.replayBlocked({ suspended, resolution }),
        );
      })
      .catch((err) => {
        // Expiry / withdrawal of a re-armed gate must reach the SAME terminal
        // state as the live path: persist the gate's terminal status, flip the
        // durable block back to running, clear the suspended checkpoint, and
        // drive the turn to settlement. Otherwise the item stays
        // blocked_on_decision_gate forever (the heartbeat renews its lease so
        // the sweep never reclaims it and maybeEmitStuck excludes it), wedging
        // the whole thread on every restart.
        if (isDecisionGateExpired(err) || isDecisionGateWithdrawn(err)) {
          this.terminalizeReconciledGate(gate, err).catch((e) =>
            this.emitError(
              "terminalize_reconciled_gate_failed",
              e instanceof Error ? e.message : String(e),
            ),
          );
          return;
        }
        this.emitError(
          "replay_after_pending_gate_failed",
          err instanceof Error ? err.message : String(err),
        );
      });
  }

  /**
   * Durable expiry backstop (Task 4). For each pending gate whose deadline has
   * lapsed: if it is armed in this process's GateManager, fire the live expiry
   * path (`expire` rejects the waiter → the requestDecision / re-arm handler
   * persists the terminal status and drives settlement). If it is NOT armed
   * (a lost in-process timer — e.g. a re-armed row whose waiter never attached),
   * re-arm through `reconcileGate`: the fresh fenced attempt registers the
   * already-past gate, which self-expires immediately and terminalizes.
   * Complements the low-latency in-memory `setTimeout` in `GateManager.register`.
   */
  async sweepExpiredGates(snapshot?: readonly DecisionGate[]): Promise<void> {
    const store = this.session.providers.store;
    const now = Date.now();
    const gates = snapshot ?? await store.listDecisionGates(this.session.id, this.id);
    // Lazily fetched once per sweep pass, shared by every lapsed gate.
    let suspended: SuspendedTurnState | null | undefined;
    for (const gate of gates) {
      if (gate.status !== "pending") continue;
      if (gate.expiresAt === undefined || gate.expiresAt > now) continue;
      if (this.gates.isPending(gate.id)) {
        this.gates.expire(gate.id);
        continue;
      }
      // Command gates live on this thread's rows but their waiter is armed
      // in the SESSION-level manager (awaitCommandGate) — a live one is
      // owned, not orphaned. Its own timer terminalizes it.
      if (this.session.isCommandGatePending(gate.id)) continue;
      // One read serves every gate this tick — the checkpoint cannot change
      // under the sweep (reconcileGate re-validates before acting).
      if (suspended === undefined) {
        suspended = await store.getSuspendedTurn(this.session.id, this.id);
      }
      if (!suspended || suspended.gateId !== gate.id) {
        // No armed waiter and no checkpoint reference this row: it is a
        // superseded pending gate (its turn moved on to a later gate, or a
        // pre-stickiness build left it behind). No turn state to repair —
        // expire the row in place so it stops rendering as an actionable
        // approval, and skip a row whose queue item is the live turn (that
        // turn's own gate cycle owns it).
        if (gate.queueItemId !== this.runningItem?.id) {
          await this.expireUnownedGateRow(gate);
        }
        continue;
      }
      // Checkpointed but not armed: a live turn (if any) owns the thread —
      // leave it be.
      if (this.runningItem) continue;
      const item = await store.getQueueItem(this.session.id, suspended.queueItemId);
      if (!item) continue;
      await this.reconcileGate(item, suspended, "rearm");
    }
  }

  /**
   * Expire a lapsed pending gate row that no waiter or checkpoint owns.
   * Row + DAG entry flip to `expired` and the expiry event reaches live
   * clients, so the approval card clears everywhere. Deliberately does NOT
   * touch queue items or the transcript — there is no suspended turn to
   * resume for these rows.
   *
   * Visibility (alert, don't auto-repair): every hit records the
   * `valet.gates.unowned_expired` counter and logs the gate id, so a
   * violation of the checkpoint-first open ordering shows up as a signal
   * distinct from ordinary expiry instead of being silently reaped. A
   * steady rate after the pre-stickiness backlog drains is a bug upstream.
   */
  private async expireUnownedGateRow(gate: DecisionGate): Promise<void> {
    try {
      await persistTerminalGate(this.session.providers.store, this.session.id, this.id, gate, {
        status: "expired",
      });
      recordGateUnownedExpired(gate.type);
      console.warn(
        `[engine] expired unowned pending gate ${gate.id} (session=${this.session.id} ` +
          `thread=${this.id} type=${gate.type}): no waiter or checkpoint owned it`,
      );
      await this.session.emit(
        { type: "decision_gate_expired", threadId: this.id, gateId: gate.id },
        { eventKey: `gate:${gate.id}:expired` },
      );
    } catch (err) {
      this.emitError(
        "expire_unowned_gate_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Terminalize a re-armed gate that expired or was withdrawn after restart,
   * then drive its suspended turn to settlement. Mirrors the live
   * `requestDecision` expiry/withdrawal path (persist terminal gate status +
   * DAG entry, emit `decision_gate_expired` for expiry) but, because there is
   * no in-flight `runAgent` to rethrow into, uses `driveResumeToCompletion` to
   * repair the dangling gate tool_call, flip the block, continue, and settle —
   * matching what the live path's rethrow ultimately achieves.
   */
  private async terminalizeReconciledGate(gate: DecisionGate, err: unknown): Promise<void> {
    const store = this.session.providers.store;
    const reason = isDecisionGateWithdrawn(err) ? err.reason : undefined;
    await persistTerminalGate(
      store,
      this.session.id,
      this.id,
      gate,
      reason ? { status: "withdrawn", reason } : { status: "expired" },
    );
    if (!reason) {
      await this.session.emit(
        {
          type: "decision_gate_expired",
          threadId: this.id,
          gateId: gate.id,
        },
        { eventKey: `gate:${gate.id}:expired` },
      );
    }
    this.blockedGateId = undefined;

    if (this.runningItem && this.fence) {
      const message = reason
        ? `decision gate withdrawn (${reason}) before resolution`
        : "decision gate expired before resolution";
      await this.driveResumeToCompletion(this.runningItem, message);
    }
  }

  /**
   * One full gate cycle: persist the gate, checkpoint the suspended turn,
   * flip the durable block, await the human decision, then unwind. The
   * caller MUST hold this thread's gate-cycle slot (`gateCycleTail`) — the
   * strict running↔blocked_on_decision_gate toggle and the single
   * suspended-turn checkpoint slot both assume one cycle at a time.
   */
  private async runGateCycle(args: {
    req: DecisionGateRequest;
    gateCtx: GateContext;
    signal: AbortSignal;
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }): Promise<DecisionResolution> {
    const { req, gateCtx, signal, toolCallId, toolName, toolArgs } = args;
    const session = this.session;
    // Ordinal resolution: reuse a still-pending gate for this
    // (queueItemId, resumeKey) — JOIN it rather than open a duplicate — or,
    // once the latest is terminal, mint a fresh gate at ordinal+1 (a retried
    // action after a human decision gets a fresh decision). Null → ordinal 0.
    // One bounded read serves the ordinal resolution AND the sticky scan
    // below — both scope to this queue item's gates.
    const queueGates = await session.providers.store.listDecisionGatesForQueueItem(
      session.id,
      this.id,
      gateCtx.queueItemId,
    );
    const latestGate = latestGateForResume(queueGates, gateCtx.queueItemId, gateCtx.resumeKey);
    const joiningPending = latestGate?.status === "pending";
    const ordinal = latestGate
      ? joiningPending
        ? latestGate.ordinal
        : latestGate.ordinal + 1
      : 0;
    // Fence captured for the whole suspend/resume cycle of this claimed
    // turn. Undefined only on the replay path, which short-circuits above.
    const fence = this.fence;
    const runningItemId = this.runningItem?.id;
    // Fenced writes in the gate path route through fencedWrite (design
    // point 3): a stale fence aborts the turn, marks it for skipped
    // settlement, and unwinds the tool. The agent is already aborted at
    // that point, so the unwind never reaches the model as a tool error.
    // Non-stale errors (e.g. ConflictError from a wrong-direction blocked
    // toggle) still propagate — they are deliberate contract violations.
    const fencedGateWrite = async (fn: () => Promise<void>): Promise<void> => {
      await this.fencedWrite(fn);
      if (this.staleFenceDetected) {
        throw new Error(`turn superseded: stale write fence for item ${runningItemId}`);
      }
    };
    // When joining a still-pending gate the durable row + DAG entry already
    // exist, so reuse them; only re-arm the wait and re-checkpoint below.
    const gate = joiningPending && latestGate ? latestGate : fromRequest(req, { ...gateCtx, ordinal });
    // The turn unwound while this call waited for the gate-cycle slot:
    // Thread.abort sets `aborted`; steer supersession aborts the agent's
    // run signal without setting it. Either way, do not persist a gate
    // that no waiter will ever own. This check runs BEFORE the sticky
    // scan: an unwinding turn must get the withdrawal, not a stored
    // resolution that would let it run onResolution side effects and emit
    // audit records on behalf of a discarded attempt.
    if (this.aborted || signal.aborted) {
      throw new DecisionGateWithdrawnError(gate.id, this.aborted ? "abort" : "steer");
    }
    // Sticky terminal outcomes: within this queue item, a human denial or an
    // unanswered expiry in the request's dedupe scope is final. Return the
    // stored denial (or re-throw expiry) instead of opening a fresh gate —
    // otherwise an agent that retries after deny/expiry mints new gates
    // forever (tweaked args hash to a new resumeKey; a lapsed 72h gate
    // resurrects itself every 72h). A still-pending gate for this exact
    // resumeKey takes precedence: join it below and let the human answer.
    // A same-args retry returns the ORIGINAL ordinal on purpose — the policy
    // audit sink dedupes on (queueItemId, resumeKey, gateOrdinal), so model
    // retries of one denied call collapse onto the one human decision record.
    if (!joiningPending) {
      const sticky = findStickyTerminalGate(queueGates, {
        queueItemId: gateCtx.queueItemId,
        resumeKey: gateCtx.resumeKey,
        dedupeKey: req.dedupeKey,
      });
      if (sticky?.kind === "denied") {
        return { ...sticky.resolution, gateOrdinal: sticky.gate.ordinal };
      }
      if (sticky?.kind === "expired") {
        throw new DecisionGateExpiredError(sticky.gate.id, sticky.gate.ordinal);
      }
    }
    try {
      // Checkpoint FIRST — the suspended-turn row is the ownership anchor
      // for `terminalizeOrphanedGate`'s guard: once it references this gate,
      // a resolve/withdraw that lands before the waiter arms is left alone
      // (retryable) instead of consumed by the store-side orphan repair. A
      // crash in this window leaves a checkpoint without a row (inert; the
      // next cycle overwrites it) rather than a row without a checkpoint
      // (an orphan card). Use real toolName + toolArgs so restoreSession
      // can replay this exact tool call.
      await fencedGateWrite(() =>
        session.providers.store.saveSuspendedTurn(
          session.id,
          this.id,
          {
            sessionId: session.id,
            threadId: this.id,
            queueItemId: runningItemId ?? "",
            gateId: gate.id,
            model: session.options.modelSpec ?? session.options.model.id,
            toolCallId,
            toolName,
            toolArgs,
            resumeKey: gateCtx.resumeKey,
            ordinal: gate.ordinal,
            attempt: 1,
            createdAt: Date.now(),
          },
          fence,
        ),
      );

      if (!joiningPending) {
        await session.providers.store.saveDecisionGate(session.id, this.id, gate);
        const gateEntry: SessionEntry = {
          id: uid("e"),
          sessionId: session.id,
          threadId: this.id,
          parentId: null,
          type: "decision_gate",
          gate,
          queueItemId: runningItemId,
          createdAt: Date.now(),
        };
        await fencedGateWrite(() =>
          this.appendEntry(gateEntry, fence),
        );
      }

      // Durable block flag under the fence (running → blocked). Gate-blocked
      // turns retain their claim and do not settle until the gate resolves.
      this.blockedGateId = gate.id;
      if (fence && runningItemId) {
        await fencedGateWrite(() =>
          session.providers.store.setSubmissionBlocked(
            session.id,
            this.id,
            runningItemId,
            true,
            fence,
          ),
        );
      }
      this.lastEmittedStatus = "blocked_on_decision_gate";
      await this.fencedEmit(
        {
          type: "status",
          threadId: this.id,
          status: "blocked_on_decision_gate",
        },
        { queueItemId: runningItemId },
      );
      await session.emit(
        { type: "decision_gate", threadId: this.id, gate },
        { eventKey: `gate:${gate.id}:pending`, queueItemId: runningItemId },
      );
    } catch (err) {
      // A partially-opened gate must not survive as a pending row with no
      // registered waiter — that renders as an approval card that neither
      // resolve nor refresh can clear (TKAI-238).
      await this.cleanupFailedGateOpen(gate, fence, runningItemId);
      throw err;
    }

    try {
      const rawResolution = await this.gates.register(gate, async (gateId) => {
        await session.providers.store.updateDecisionGateEntry(
          session.id,
          this.id,
          gateId,
          { resolvedAt: new Date().toISOString(), gate: { ...gate, status: "expired" } },
        );
        await session.emit(
          { type: "decision_gate_expired", threadId: this.id, gateId },
          { eventKey: `gate:${gateId}:expired`, queueItemId: runningItemId },
        );
      });
      // Stamp the gate's ordinal onto the resolution before it is
      // persisted or handed back to the calling tool — the caller (e.g.
      // call_tool's policy audit) needs this to distinguish a
      // restart-replay double-fire (same ordinal) from a fresh
      // legitimate repeat (new ordinal) for the same resumeKey.
      const resolution: DecisionResolution = { ...rawResolution, gateOrdinal: gate.ordinal };
      // Mark gate resolved in store and update DAG entry
      await persistTerminalGate(session.providers.store, session.id, this.id, gate, {
        status: "resolved",
        resolution,
      });
      this.blockedGateId = undefined;
      if (fence && runningItemId) {
        await fencedGateWrite(() =>
          session.providers.store.setSubmissionBlocked(
            session.id,
            this.id,
            runningItemId,
            false,
            fence,
          ),
        );
      }
      await fencedGateWrite(() =>
        session.providers.store.clearSuspendedTurn(session.id, this.id, fence),
      );
      return resolution;
    } catch (err) {
      // Withdrawn or expired: persist the terminal status, then propagate.
      const reason = isDecisionGateWithdrawn(err) ? err.reason : undefined;
      await persistTerminalGate(
        session.providers.store,
        session.id,
        this.id,
        gate,
        reason ? { status: "withdrawn", reason } : { status: "expired" },
      );
      this.blockedGateId = undefined;
      // Flip the durable block back to running so the turn can end and
      // settle normally (the model sees the gate's terminal state).
      if (fence && runningItemId) {
        await fencedGateWrite(() =>
          session.providers.store.setSubmissionBlocked(
            session.id,
            this.id,
            runningItemId,
            false,
            fence,
          ),
        );
      }
      await fencedGateWrite(() =>
        session.providers.store.clearSuspendedTurn(session.id, this.id, fence),
      );
      throw err;
    }
  }

  /**
   * Best-effort unwind after a gate open failed partway. The original open
   * error propagates from the caller regardless of what this method cleans.
   *
   * Stale fence: a successor incarnation owns the turn's durable state.
   * Touch nothing — the row (if one persisted) stays pending so the
   * successor's re-run can adopt it through the join path, and the fenced
   * checkpoint/blocked cleanup below would fail stale anyway. An unfenced
   * withdraw here would yank a gate the successor may have re-armed.
   *
   * Live fence: the turn continues and no waiter will ever own this gate —
   * terminalize the row (created or joined) so it cannot render as an
   * unresolvable approval card, then release the checkpoint and the blocked
   * toggle. Cleanup failures are emitted, not swallowed: a blocked toggle
   * that stays flipped wedges the whole thread (alert, don't auto-repair).
   */
  private async cleanupFailedGateOpen(
    gate: DecisionGate,
    fence: WriteFence | undefined,
    runningItemId: string | undefined,
  ): Promise<void> {
    if (this.blockedGateId === gate.id) this.blockedGateId = undefined;
    if (this.staleFenceDetected) return;
    const store = this.session.providers.store;
    try {
      await persistTerminalGate(store, this.session.id, this.id, gate, {
        status: "withdrawn",
        reason: "abort",
      });
      await this.session.emit(
        { type: "decision_gate_withdrawn", threadId: this.id, gateId: gate.id, reason: "abort" },
        { eventKey: `gate:${gate.id}:withdrawn` },
      );
    } catch (e) {
      this.emitError(
        "gate_open_cleanup_failed",
        e instanceof Error ? e.message : String(e),
      );
    }
    try {
      const suspended = await store.getSuspendedTurn(this.session.id, this.id);
      if (suspended?.gateId === gate.id) {
        await store.clearSuspendedTurn(this.session.id, this.id, fence);
      }
      if (fence && runningItemId) {
        const item = await store.getQueueItem(this.session.id, runningItemId);
        if (item?.status === "blocked_on_decision_gate") {
          await store.setSubmissionBlocked(this.session.id, this.id, runningItemId, false, fence);
        }
      }
    } catch (e) {
      this.emitError(
        "gate_open_cleanup_failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /** Append one entry after the durable active leaf and advance the leaf. */
  async appendEntry(entry: SessionEntry, fence?: WriteFence): Promise<void> {
    const append = this.entryAppendTail.then(async () => {
      if (this.activeLeafEntryId === undefined) {
        const data = await this.session.providers.store.getThread(this.session.id, this.id);
        this.activeLeafEntryId = data?.activeLeafEntryId;
      }
      entry.parentId = this.activeLeafEntryId ?? null;
      await this.session.providers.store.appendEntries(
        this.session.id,
        this.id,
        [entry],
        fence,
      );
      this.activeLeafEntryId = entry.id;
    });
    this.entryAppendTail = append.catch(() => undefined);
    return append;
  }

  private async transcriptSnapshot(): Promise<{ thread: ThreadData; entries: SessionEntry[] }> {
    const snapshot = await this.session.providers.store.getThreadSnapshot(
      this.session.id,
      this.id,
    );
    if (!snapshot) throw new Error(`thread not found: ${this.id}`);
    this.activeLeafEntryId = snapshot.thread.activeLeafEntryId;
    return snapshot;
  }

  /** Load restored history only when this thread needs an agent transcript. */
  private async ensureTranscript(): Promise<void> {
    if (!this.transcriptPending) return;
    if (!this.transcriptLoad) {
      this.transcriptLoad = withSpan(
        "thread.hydrate",
        { "valet.session.id": this.session.id, "valet.thread.id": this.id },
        async (span) => {
          const snapshot = await this.transcriptSnapshot();
          span.setAttribute("valet.thread.entries_loaded", snapshot.entries.length);
          this.rehydrateTranscript(snapshot.entries);
        },
      ).finally(() => {
        this.transcriptLoad = undefined;
      });
    }
    await this.transcriptLoad;
  }

  /**
   * Reconstruct the agent transcript from persisted DAG entries.
   *
   * Critical: assistant entries that issued tool calls have those calls in
   * `entry.parts` as `tool_call` parts. We MUST rebuild the AssistantMessage's
   * content[] with both text and ToolCall blocks, otherwise pushing a
   * subsequent toolResult (during replay) produces a malformed
   * [user, assistant(text-only), toolResult] sequence that LLM providers
   * reject. tool/system roles are dropped here — `replayBlocked` re-derives
   * the toolResult message before continuing.
   */
  rehydrateTranscript(entries: SessionEntry[]): void {
    this.replaceActiveSkillInvocations(entries);
    this.replaceAgentMessages(entriesToAgentMessages(entries, this.effectiveModelLenient(), {
      attributeAuthors: this.attributeAuthors,
      threadKey: this.key,
      activeLeafEntryId: this.activeLeafEntryId,
    }));
    // Arm the pre-turn proactive check (spec decision 5) so the first
    // post-restart turn is protected. The trigger estimates the rehydrated
    // transcript directly (TKAI-305), so no usage seeding is needed and a
    // trailing CompactionEntry needs no special case — the estimate already
    // reflects it.
    this.rehydratedCheckPending = this.agent.state.messages.length > 0;
    this.transcriptPending = false;
  }

  /**
   * Whether user messages carry a `[from: …]` sender line in the LLM
   * transcript. On when the session is shared (team/org-owned) — several
   * people prompt the same thread there, and the model cannot differentiate
   * them from the text alone. Personal sessions have one author; the line
   * would be noise.
   */
  private get attributeAuthors(): boolean {
    return this.session.owner.type !== "user";
  }

  setMode(mode: QueueMode): void {
    this.mode = mode;
  }

  toThreadData(): ThreadData {
    return {
      id: this.id,
      sessionId: this.session.id,
      key: this.key,
      status: this.paused ? "paused" : "active",
      activeLeafEntryId: this.activeLeafEntryId,
      queueMode: this.mode,
      paused: this.paused,
      model: this.modelOverride,
      reasoning: this.reasoningDisabled ? THREAD_REASONING_DISABLED : this.reasoningOverride,
      summary: undefined,
      createdAt: this.threadCreatedAt,
      updatedAt: Date.now(),
    };
  }

  /**
   * Set or clear the model, and emit `model_switched` so the wire / UI can
   * react. Pass `null` to clear and fall back to the session default.
   *
   * `reason` selects the writer, and the two writers have different scopes
   * (TKAI-338):
   *
   * - `tool:*` — the agent's own `switch_model`. A turn-scoped escalation:
   *   it retargets the running agent so the next LLM call uses it, is NOT
   *   persisted, and is dropped when the turn settles. The user's pin is
   *   untouched, so nothing strands a thread on a model the user never
   *   chose.
   * - anything else (`set_via_api`, `slash_command`) — the user's own
   *   choice. Persisted via `store.saveThread` and applied from the next
   *   turn onward, exactly as before.
   *
   * Keeping one field per writer is deliberate: the previous single field
   * let an agent escalation and a user setting overwrite each other, which
   * is why the picker appeared to change on its own.
   */
  async setModel(
    modelId: string | null,
    reason: string = "set_via_api",
  ): Promise<{ fromModel: string; toModel: string }> {
    const sessionDefault = this.session.options.modelSpec ?? this.session.options.model.id;
    // A `tool:*` reason marks the agent's own switch_model call. That is a
    // turn-scoped escalation, not a change to the setting the user picked,
    // so it never touches `modelOverride` and is never persisted.
    const isAgentSwitch = reason.startsWith("tool:");
    // The agent switch reports against what the TURN actually runs on, which
    // includes the running item's pin — that outranks `modelOverride`
    // everywhere else (see `turnModelSpec`). Leaving it out let a real
    // retarget report "model unchanged" and emit no event.
    const before = isAgentSwitch
      ? (this.agentModelSwitch ??
        this.runningItem?.model ??
        this.modelOverride ??
        sessionDefault)
      : (this.modelOverride ?? sessionDefault);
    if (isAgentSwitch) {
      if (modelId === null) {
        this.agentModelSwitch = undefined;
      } else {
        const priorLiveModel = this.agent.state.model;
        const priorAgentModelSwitch = this.agentModelSwitch;
        const priorTurnApiKey = this.turnApiKey;
        // Validate before assigning so an unknown id is rejected and the
        // turn keeps its previous model. The resolution is handed straight
        // to the apply step: resolving twice costs a second provider lookup
        // (a DB + credential read on the api host) and lets the two calls
        // disagree, e.g. validate accepting a NoCredentialsError that apply
        // then reports as "switch_model failed".
        try {
          const resolved = await this.validateModelSpec(modelId);
          // Retarget the live agent so the NEXT LLM CALL of this turn uses the
          // new model — the contract switch_model advertises, and what the
          // prompt rules mean by "switch_model ... in this turn, then continue".
          await this.applyModelToRunningTurn(modelId, resolved);
          this.agentModelSwitch = modelId;
          if (
            this.runningItem &&
            !(await this.publishActiveModelState(this.runningItem.id, this.agent.state.model))
          ) {
            this.agent.state.model = priorLiveModel;
            this.agentModelSwitch = priorAgentModelSwitch;
            this.turnApiKey = priorTurnApiKey;
          }
        } catch (err) {
          // The switch is not usable until its active-state disclosure lands.
          // Restore all live turn-scoped values so the tool reports failure
          // and any continuation stays on the previously disclosed model.
          this.agent.state.model = priorLiveModel;
          this.agentModelSwitch = priorAgentModelSwitch;
          this.turnApiKey = priorTurnApiKey;
          throw err;
        }
      }
    } else if (modelId === null) {
      this.modelOverride = undefined;
      await this.session.providers.store.saveThread(this.session.id, this.toThreadData());
    } else {
      // Validate before assigning so an unknown id is rejected and the
      // thread keeps its previous setting.
      await this.validateModelSpec(modelId);
      this.modelOverride = modelId;
      await this.session.providers.store.saveThread(this.session.id, this.toThreadData());
    }
    const after = isAgentSwitch
      ? (this.agentModelSwitch ??
        this.runningItem?.model ??
        this.modelOverride ??
        sessionDefault)
      : (this.modelOverride ?? sessionDefault);
    if (before !== after) {
      await this.session.emit({
        type: "model_switched",
        threadId: this.id,
        fromModel: before,
        toModel: after,
        reason,
        // Turn-scoped switches end when the turn settles, and nothing emits
        // a matching switch back. A consumer that rebuilds the current model
        // from the event stream needs this to avoid showing the thread as
        // permanently escalated.
        scope: isAgentSwitch ? "turn" : "thread",
      });
    }
    return { fromModel: before, toModel: after };
  }

  /**
   * Set or clear this thread's reasoning-level pin. The new value takes
   * effect on the *next* LLM call. Pass `null` to clear the pin and fall
   * back to the session default.
   *
   * The token is validated against `REASONING_LEVELS` here; the clamp to
   * the model's supported levels happens at stream time, so a pin the
   * current model cannot honor is kept, not rewritten.
   */
  async setReasoning(level: string | null): Promise<void> {
    if (level === null) {
      this.reasoningOverride = undefined;
      this.reasoningDisabled = false;
    } else {
      // Validate before assigning so a bad token leaves the pin intact.
      if (!isReasoningLevel(level)) {
        throw new ValidationError(
          `unknown reasoning level: ${level}. Valid levels: ${REASONING_LEVELS.join(", ")}.`,
        );
      }
      this.reasoningOverride = level;
      this.reasoningDisabled = false;
    }
    await this.session.providers.store.saveThread(this.session.id, this.toThreadData());
  }

  /**
   * Validate a model spec the way admission (`submitPrompt`) and the thread
   * pin (`setModel`) both require. A spec naming the session's own effective
   * spec, or this thread's current pin, is valid by construction — the live
   * model object exists even when the spec is not in pi-ai's static registry
   * (custom providers, test doubles). Otherwise resolve through the host
   * resolver when present, else the internal registry. NoCredentialsError is
   * accepted: the model resolved; the key is configurable before a turn
   * runs. Throws `ValidationError` on an unknown spec.
   */
  private async validateModelSpec(spec: string): Promise<ResolvedModel | null> {
    const sessionSpec = this.session.options.modelSpec ?? this.session.options.model.id;
    // Valid by construction, and deliberately NOT resolved: null tells the
    // caller "accepted without a lookup", which `applyModelToRunningTurn`
    // has to handle rather than treat as a resolution failure.
    if (spec === sessionSpec || spec === this.modelOverride) return null;
    const resolver = this.session.options.resolveModel;
    let resolved: ResolvedModel | PiModel | null | undefined;
    try {
      resolved = resolver ? await resolver(spec) : resolveModelId(spec);
    } catch (err) {
      if (!(err instanceof NoCredentialsError)) throw err;
      resolved = { model: err.model };
    }
    if (!resolved) {
      throw new ValidationError(
        `unknown model id: ${spec}. Run /model to list the available models.`,
      );
    }
    // Normalize both shapes to ResolvedModel so the caller can apply the
    // model (and any per-turn key) without re-resolving.
    return "model" in resolved ? resolved : { model: resolved };
  }

  /**
   * Point the live agent at `spec` for the remainder of the current turn.
   *
   * No-op when no turn is running: there is no agent state to retarget, and
   * the next turn resolves its model from scratch anyway.
   *
   * With a host `resolveModel` seam present this also refreshes the per-turn
   * API key, so an escalation that crosses providers still authenticates —
   * the same pairing `applyResolvedKeyForResume` does on a gate resume.
   */
  private async applyModelToRunningTurn(
    spec: string,
    resolved: ResolvedModel | null,
  ): Promise<void> {
    if (!this.runningItem) return;
    if (resolved) {
      this.turnApiKey = resolved.apiKey;
      this.agent.state.model = resolved.model;
      return;
    }
    // `resolved === null` means validateModelSpec accepted the spec WITHOUT
    // a lookup: it names the session's own effective spec, or the thread's
    // current pin. Those still have to be applied — returning here would
    // tell the agent it switched while the turn kept streaming against the
    // old model, which is the defect class this whole change exists to fix.
    const sessionSpec = this.session.options.modelSpec ?? this.session.options.model.id;
    const resolver = this.session.options.resolveModel;
    if (resolver) {
      // Re-resolve so a switch BACK also refreshes the per-turn key: after an
      // escalation, `turnApiKey` holds the escalated provider's key, and
      // reusing it against the original provider would 401.
      let viaResolver: ResolvedModel | null | undefined;
      try {
        viaResolver = await resolver(spec);
      } catch (err) {
        if (!(err instanceof NoCredentialsError)) throw err;
        viaResolver = { model: err.model };
      }
      if (viaResolver) {
        this.turnApiKey = viaResolver.apiKey;
        this.agent.state.model = viaResolver.model;
        return;
      }
    }
    // No resolver, or a resolver that does not know the session's own spec.
    // The session already holds that model object, and it may not be in
    // pi-ai's static registry at all (custom providers, test doubles) — the
    // same carve-out `resolveTurnModel` makes. Only a DIVERGENT spec needs
    // the registry, and a miss there fails loud (spec decision 3).
    if (spec === sessionSpec) {
      this.agent.state.model = this.session.options.model;
      return;
    }
    const m = resolveModelId(spec);
    if (!m) {
      throw new ValidationError(
        `unknown model id: ${spec}. Run /model to list the available models.`,
      );
    }
    this.agent.state.model = m;
  }

  /** Layered resolution: agent escalation → item model → thread pin →
   *  session default. Returns the live pi-ai Model for the next LLM call.
   *
   *  A pin that stops resolving FAILS THE TURN LOUD (spec decision 3) —
   *  silently falling back to the session default ran the turn on a model
   *  the user never chose, with no event and no transcript evidence. */
  resolveTurnModel(item?: QueueItem): PiModel {
    const sessionSpec = this.session.options.modelSpec ?? this.session.options.model.id;
    const pin = this.agentModelSwitch ?? item?.model ?? this.modelOverride;
    // A pin that names the session's own effective spec resolves to the live
    // session model object — the session already holds it, and it may not be
    // in pi-ai's static registry at all (custom providers, test doubles).
    // Only a DIVERGENT pin needs its own resolution.
    if (pin && pin !== sessionSpec) {
      const m = resolveModelId(pin);
      if (m) return m;
      throw new Error(
        `Model '${pin}' is no longer available. Switch this thread's model with /model <id>, or clear the pin to use the session default.`,
      );
    }
    return this.session.options.model;
  }

  /** Effective model spec string for this turn: agent escalation → item
   *  model → thread pin → session default spec (`modelSpec` — the canonical
   *  form; `model.id` is the wire id and only coincides for bare/internal
   *  resolution).
   *
   *  The escalation ranks first so that any site re-deriving the spec during
   *  a live turn sees what the turn is really running on. No current caller
   *  does: both callers run either at fresh-turn start (escalation already
   *  cleared) or on a post-restart reconcile path (escalation never
   *  persisted). It is the correct precedence, not a load-bearing one. */
  private turnModelSpec(item?: QueueItem): string {
    return (
      this.agentModelSwitch ??
      item?.model ??
      this.modelOverride ??
      this.session.options.modelSpec ??
      this.session.options.model.id
    );
  }

  /**
   * Best-effort effective model for NON-TURN sites that must not throw
   * (transcript rehydration, budget math outside a live turn). Unresolvable
   * pins fall back to the session default here — the turn path has already
   * failed loud for those; these sites only need a sane context-window
   * approximation.
   */
  private effectiveModelLenient(): PiModel {
    if (this.modelOverride) {
      const m = resolveModelId(this.modelOverride);
      if (m) return m;
    }
    return this.session.options.model;
  }

  /**
   * Resolve this turn's model, and — with a host `resolveModel` seam present —
   * stamp its per-turn API key onto `this.turnApiKey`. Absent resolver: the
   * existing synchronous `resolveTurnModel()` path, no key touched
   * (byte-identical). Present resolver: resolve the effective spec through it
   * and hold `{ model, apiKey }` for this turn only. If the resolver can't
   * resolve the (setModel-validated) spec at turn time, FAIL THE TURN LOUD
   * (spec decision 3) — same contract as `applyResolvedKeyForResume`.
   * Silently proceeding on internal resolution + env keys ran the turn on a
   * model and credentials the user never chose.
   */
  private async resolveTurnModelForTurn(item?: QueueItem): Promise<PiModel> {
    this.assignedModelSpec = this.turnModelSpec(item);
    const resolver = this.session.options.resolveModel;
    if (!resolver) return this.resolveTurnModel(item);
    const spec = this.turnModelSpec(item);
    return withSpan("model.resolve", { "valet.model.spec": spec }, async (span) => {
      const resolved = await resolver(spec);
      if (resolved) {
        span.setAttributes({
          "valet.model.wire_id": resolved.model.id,
          "valet.model.provider": resolved.model.provider,
          // Key PRESENCE only — an undefined key means "env fallback", which
          // is exactly the thing to check when a turn 401s.
          "valet.model.key_source": resolved.apiKey !== undefined ? "resolver" : "env",
        });
        this.turnApiKey = resolved.apiKey;
        return resolved.model;
      }
      span.setAttribute("valet.model.key_source", "dead_pin");
      // "Clear the pin" only helps when the pin diverges from the session
      // default — when the DEFAULT itself is what died, clearing resolves
      // the identical spec and fails again, so point at the admin fix.
      const sessionSpec = this.session.options.modelSpec ?? this.session.options.model.id;
      throw new Error(
        spec === sessionSpec
          ? `Model '${spec}' is no longer available. Switch this thread's model with /model <id>, or ask an admin to restore the model in the provider settings.`
          : `Model '${spec}' is no longer available. Switch this thread's model with /model <id>, or clear the pin to use the session default.`,
      );
    });
  }

  /**
   * Resume/replay key delivery: with a host resolver present, re-resolve this
   * turn's effective spec and stamp the per-turn key + agent model before the
   * agent continues an interrupted or gate-resolved turn. No-op when the
   * resolver is absent (byte-identical to the pre-seam resume paths).
   *
   * THROWS `NoCredentialsError` straight through — symmetric with the
   * pre-run detection in runItem — and throws `unknown model id` when the
   * resolver returns null (spec no longer resolvable). Swallowing either and
   * continuing with a stale/unset key would silently activate pi-ai's
   * AMBIENT env fallback: a revoked org key could resume on a dev-shell/pod
   * env key the org never authorized. Callers treat the throw as a normal
   * turn failure (the continuation settles `failed`; claim cleaned, no
   * wedge).
   */
  private async applyResolvedKeyForResume(item?: QueueItem): Promise<void> {
    this.assignedModelSpec = this.turnModelSpec(item);
    const resolver = this.session.options.resolveModel;
    if (!resolver) return;
    const spec = this.turnModelSpec(item);
    const resolved = await resolver(spec);
    if (resolved === null) {
      // Unknown spec — e.g. an admin deleted the custom provider row while
      // the session sat suspended at a gate. Silently proceeding would keep
      // the stale turnApiKey/model and continue on ambient env creds — the
      // exact failure mode the loud-fail contract exists to prevent. Same
      // surface as setModel's unknown-spec rejection; the caller settles the
      // resume `failed`.
      throw new Error(`unknown model id: ${spec}`);
    }
    this.turnApiKey = resolved.apiKey;
    this.agent.state.model = resolved.model;
  }

  async readEntries(opts?: MessageQuery): Promise<SessionEntry[]> {
    return this.session.providers.store.getEntries(this.session.id, this.id, opts);
  }

  // ── internals ───────────────────────────────────────────────────

  /** Current running submission id (for the session heartbeat's lease renewal). */
  runningItemId(): string | undefined {
    return this.runningItem?.id;
  }

  /**
   * Read-only snapshot of this thread's derived queue state from durable
   * rows. Same derivation as the `queue_state` event, without emitting.
   * Used by the `/status` and `/clear` built-ins.
   */
  async currentQueueState(): Promise<QueueState> {
    const items = await this.session.providers.store.listUnsettledSubmissions(this.session.id);
    return deriveQueueState(this.id, items, this.mode, this.paused, this.blockedGateId);
  }

  /** True when this thread is mid-turn (a submission is claimed and running). */
  get hasActiveRun(): boolean {
    return this.runningItem != null;
  }

  /** Current committed submission model after all earlier transitions finish. */
  currentModelState(): Promise<ActiveModelState | null> {
    return this.enqueueModelStateTransition(async () =>
      this.committedModelState ? { ...this.committedModelState } : null,
    );
  }

  /**
   * Best current reading of this thread's agent status, for a subscriber that
   * connects mid-turn (the WS handshake seeds a `status` frame from it).
   * Derived from live in-memory state, so it self-corrects where
   * `lastEmittedStatus` alone would mislead: a resolved gate un-blocks back
   * to `tool_calling` (the gate was raised inside a tool call that is still
   * running), and a claimed-but-not-yet-streaming turn reads `thinking`.
   */
  get currentAgentStatus(): EngineEventStatus {
    if (this.blockedGateId) return "blocked_on_decision_gate";
    if (!this.runningItem) return "idle";
    if (this.lastEmittedStatus === "blocked_on_decision_gate") return "tool_calling";
    if (this.lastEmittedStatus === "idle") return "thinking";
    return this.lastEmittedStatus;
  }

  /**
   * The claim loop. Drives the thread's durable queue: repeatedly claim the
   * thread's runnable head from the store, run the turn under a write fence,
   * settle two-phase, and loop until nothing is claimable. Serialized — a
   * second call while one is in flight joins the same tail (the store's
   * head-blocking makes a redundant claim a harmless null).
   */
  /**
   * The one idiom for kicking a turn drive fire-and-forget (resume drives,
   * gate replays). Guarantees every background drive:
   *
   *  1. is registered in the in-process live-drive registry, so a
   *     same-process rebuild's reconcile waits instead of CAS-stealing the
   *     live attempt (see `liveBackgroundDrives`);
   *  2. lands in `backgroundDriveTail`, so `abort()` (and through it
   *     `Session.destroy`) can join it like it joins `kickTail`;
   *  3. has a rejection owner: the inner drives settle their own failures,
   *     so a rejection escaping here means the drive's finally never ran —
   *     emit it, and clear the in-process claim if this drive still holds it
   *     (otherwise `kickLoop`'s `runningItem` guard parks the thread forever
   *     while the heartbeat keeps the lease fresh).
   */
  private kickBackgroundDrive(
    errorCode: string,
    itemId: string,
    fenceAtKick: WriteFence | undefined,
    drive: () => Promise<void>,
  ): void {
    registerBackgroundDrive(itemId);
    const p = drive()
      .catch((err: unknown) => {
        this.emitError(errorCode, err instanceof Error ? err.message : String(err));
        if (fenceAtKick !== undefined && this.fence === fenceAtKick) {
          this.runningItem = null;
          this.fence = undefined;
        }
      })
      .finally(() => {
        unregisterBackgroundDrive(itemId);
      });
    this.backgroundDriveTail = this.backgroundDriveTail.then(() => p);
  }

  async kick(): Promise<void> {
    if (this.kicking) return this.kickTail;
    this.kicking = true;
    this.kickTail = this.kickLoop()
      .catch((err) => {
        // The loop handles expected failures itself; anything escaping here
        // must not become an unhandled rejection through `void this.kick()`.
        this.emitError("kick_failed", err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        this.kicking = false;
      });
    return this.kickTail;
  }

  private async kickLoop(): Promise<void> {
    const store = this.session.providers.store;
    while (true) {
      if (this.paused) return;
      if (this.runningItem) return;
      const head = await this.unsettledHead();
      if (!head) return;

      // A previous settlement durably recorded its outcome (reserve) but the
      // finalize half failed transiently: retry it under the item's stored
      // current attemptId. The terminalizing head blocks claims until it lands.
      if (head.status === "terminalizing") {
        if (!(await this.retryFinalize(head))) return; // still failing; next sweep retries
        continue;
      }
      // running / blocked head: owned by a live attempt — nothing to claim
      // until it settles (expired-lease reclaim is Task 5 reconciliation).
      if (head.status !== "queued") return;

      // An abort was requested while this item was still queued: settle it
      // `aborted` without ever running it, rather than claiming it.
      if (head.abortRequestedAt !== undefined) {
        await store.settleUnclaimed(this.session.id, this.id, head.id, { outcome: "aborted" });
        await this.emitSettled(head.id, { outcome: "aborted" });
        await this.emitQueueState();
        continue;
      }

      const attemptId = uid("att");
      const claimed = await store.claimSubmission({
        sessionId: this.session.id,
        threadId: this.id,
        itemId: head.id,
        attemptId,
        ownerId: this.session.ownerId,
      });
      if (!claimed) return; // lost the race or head is not actually claimable

      await store.insertAttemptMarker(claimed.id, attemptId);
      this.runningItem = claimed;
      // A fresh turn starts on the user's model. Any escalation belonged to
      // the turn that just ended; clearing here (not only at settle) means
      // no repair path can leak one turn's escalation into the next.
      this.agentModelSwitch = undefined;
      this.turnStartedAt = Date.now();
      const admissionLink = linkFromTraceparent(claimed.metadata?.[TRACEPARENT_METADATA_KEY]);
      this.submissionSpan = engineTracer().startSpan("submission.run", {
        attributes: {
          "valet.session.id": this.session.id,
          "valet.thread.id": this.id,
          "valet.queue_item.id": claimed.id,
          "valet.submission.attempt": claimed.attemptCount,
          // Queue wait — the time between admission and this claim — is a
          // first-order bottleneck signal, invisible inside any child span.
          "valet.submission.queue_wait_ms": Date.now() - claimed.createdAt,
          // Size, not content: enough to correlate "huge prompt" with a slow
          // turn without putting user text on a span.
          "valet.submission.content_chars": JSON.stringify(claimed.content).length,
          ...(claimed.channel ? { "valet.submission.channel": claimed.channel.channelType } : {}),
          ...(claimed.dispatchId ? { "valet.submission.dispatch_id": claimed.dispatchId } : {}),
          ...(claimed.author ? { "valet.submission.author": claimed.author.id } : {}),
        },
        links: admissionLink ? [admissionLink] : undefined,
      });
      this.fence = { itemId: claimed.id, attemptId };
      this.staleFenceDetected = false;
      this.session.ensureTimers();
      await this.emitQueueState();

      // Run-start reconcile window (sandbox reconcile spec, decision 4): the only
      // place convergence may act. Idle = no other thread mid-run and no pending
      // exec jobs. Errors degrade to running stale — never fail the turn.
      if (!this.session.hasOtherActiveRuns(this.id) && this.session.pendingJobCount() === 0) {
        try { await this.session.attachment.reconcile(); } catch (err) { console.error("[thread] reconcile failed, continuing:", err); }
      }

      // First load of repo AGENTS.md instructions (agents-md spec, decision 1):
      // the ready transition's host-hook refresh is async and unawaited, so
      // without this the first turn would race it and run without the
      // fragment. No-op unless a provider exists, the attachment is ready,
      // and no refresh has completed yet. Errors degrade to running without
      // instructions — never fail the turn.
      try {
        await this.session.ensureRepoInstructions();
      } catch (err) {
        console.error("[thread] repo-instructions load failed, continuing:", err);
      }

      let turnFailed = false;
      let turnError: unknown;
      try {
        await this.runItem(claimed);
      } catch (err) {
        turnFailed = true;
        turnError = err;
        this.emitError("run_failed", err instanceof Error ? err.message : String(err));
      }
      // A pre-first-token stream failure may leave NO assistant message for
      // this turn, so settlement can't rely on the transcript to detect it
      // (decideTurnOutcome deliberately ignores stale trailing messages) —
      // runItem records the agent throw independently and it becomes a
      // normal turn failure here.
      if (!turnFailed && this.turnAgentError !== undefined) {
        turnFailed = true;
        turnError = this.turnAgentError;
      }

      // The turn couldn't run because the host resolver threw
      // NoCredentialsError at turn start (`credentialError` is set ONLY by
      // that throw). For the first few attempts, release the claim back to
      // `queued` (fenced) instead of settling `failed`, so the submission
      // stays abortable and re-runs once credentials appear — a racing abort
      // settles it `aborted` via the queued settle-unclaimed path. Past the
      // cap, settle `failed` with the host's own credentials error so a
      // genuinely key-less session gets one bounded, surfaced failure
      // instead of a silent forever-spin.
      // From here to the end of the iteration the claim is installed: every
      // exit — release-success return, ownership-loss abandon, cap
      // fall-through, settleTurn success or throw, and any transient store
      // throw inside the credential-release helper — must clear
      // runningItem/fence exactly once, via the single finally below. A
      // store throw escaping with the claim still set would wedge the thread
      // (heartbeat renews the lease forever, nothing ever settles the item).
      const credentialError = this.credentialError;
      this.credentialError = undefined;
      const releaseFence = this.fence;
      try {
        // Invariant: credentialError and turnFailed are mutually exclusive —
        // runItem catches NoCredentialsError internally and returns normally
        // (it never propagates to the catch that sets turnFailed). The
        // `!turnFailed` guard is therefore provably redundant today, but
        // load-bearing if that invariant ever breaks: a turn that BOTH
        // errored and lacked credentials must settle failed, never enter the
        // release cycle. Keep the guard.
        if (credentialError !== undefined && !turnFailed && releaseFence) {
          const verdict = await this.attemptCredentialRelease(claimed, releaseFence);
          if (verdict === "released") {
            // Emit untagged (queueItemId: null): the item just went back to
            // `queued`, so the envelope must not carry it as a live claim.
            // runningItem/fence themselves clear only in the finally —
            // clearing them early opens an idle window in which a concurrent
            // reconcile pass could install a fresh claim that the pending
            // finally would then strip.
            await this.emitQueueState({ queueItemId: null });
            // Deliberately NO re-kick here: the session's 5s sweep interval
            // is the retry backoff. With pre-run credential detection an
            // immediate re-kick would burn all attempts in milliseconds and
            // defeat the "wait for a key to appear" grace window.
            return;
          }
          if (verdict === "abandon") {
            // A successor attempt owns the item (or it settled): nothing of
            // ours left to settle — but OUR attempt's marker is now stale and
            // no other path cleans it (the successor only deletes its own on
            // settle; the refused release CAS is contract-bound to touch no
            // markers). Delete it here or one row leaks per ownership-loss
            // cycle for the session's lifetime. Best-effort: a transient
            // store blip must not escape to the settlement_failed catch and
            // abort the iteration over pure cleanup — on failure the marker
            // simply leaks this one row.
            try {
              await store.deleteAttemptMarker(claimed.id, releaseFence.attemptId);
            } catch (err) {
              this.emitError(
                "stale_marker_cleanup_failed",
                err instanceof Error ? err.message : String(err),
              );
            }
            return;
          }
          if (verdict === "settle-cap") {
            // Cap reached — settle `failed` with the HOST's message.
            // decideTurnOutcome still yields to a racing abort/supersession
            // first. Append the user entry NOW (every credential attempt
            // returned pre-append, so this cannot double-append): the
            // transcript must record what the user asked when the failure
            // surfaces.
            await this.appendUserEntry(claimed);
            turnFailed = true;
            turnError = credentialError;
          }
          // "settle-owned": a supersession or abort stamp owns the outcome —
          // fall through with turnFailed still false so decideTurnOutcome
          // settles it `superseded`/`aborted` (do NOT release — a re-queued
          // superseded item is an orphan skipped by both unsettledHead and
          // the store's claim head; a re-queued aborted item is a
          // running→queued→aborted flicker on the queue-state stream).
        }

        await this.settleTurn(claimed, turnFailed ? { error: turnError } : undefined);
      } catch (err) {
        // Transient (non-stale) settlement failure: keep the attempt marker so
        // the sweep / reconciliation can finish the job. Do not wedge the
        // thread and do not leak the rejection to void callers.
        this.emitError(
          "settlement_failed",
          err instanceof Error ? err.message : String(err),
        );
        return;
      } finally {
        await this.clearActiveModelState(claimed.id, { finalizeLocal: true });
        if (this.staleFenceDetected && releaseFence) {
          try {
            await store.deleteAttemptMarker(claimed.id, releaseFence.attemptId);
          } catch (err) {
            this.emitError(
              "stale_marker_cleanup_failed",
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        this.submissionSpan?.end();
        this.submissionSpan = undefined;
        this.runningItem = null;
        this.fence = undefined;
        // The escalation dies with the turn that requested it.
        this.agentModelSwitch = undefined;
      }
    }
  }

  /**
   * One credential-release cycle for a claimed turn whose host resolver
   * threw `NoCredentialsError` before the turn could run. Consults and
   * updates the DURABLE budget on the queue item (`credentialAttempts` /
   * `lastCredentialReleaseAt` — written atomically inside the release CAS,
   * surviving restarts so a crash-looping keyless session still fails
   * boundedly). Backoff-aware: a release within
   * `credentialReleaseBackoffMs` of the last COUNTED cycle coalesces into it
   * (external kicks fire on every submit/resume/abort; a burst must not burn
   * the budget in milliseconds).
   *
   * Verdicts for the claim loop:
   *  - "released": claim released back to `queued` (budget persisted).
   *  - "settle-cap": budget exhausted — settle `failed` with the host error.
   *  - "settle-owned": a durable stamp (supersession OR abort) landed on the
   *    item, possibly mid-window — the outcome belongs to that stamp: settle
   *    under our attempt with no failure so decideTurnOutcome yields
   *    `superseded`/`aborted` accordingly (never re-queue: a superseded
   *    re-queue is an orphan; an aborted one is a queue-state flicker).
   *  - "abandon": a successor attempt owns the item (or it settled) —
   *    nothing of ours left to settle.
   */
  private async attemptCredentialRelease(
    claimed: QueueItem,
    releaseFence: WriteFence,
  ): Promise<"released" | "settle-cap" | "settle-owned" | "abandon"> {
    const store = this.session.providers.store;
    // Mirror settleTurn's guards: a successor attempt may own the item now.
    if (this.staleFenceDetected) return "abandon";
    const current = await store.getQueueItem(this.session.id, claimed.id);
    if (!current || current.status !== "running") return "abandon";
    if (current.supersededByItemId || current.abortRequestedAt !== undefined) {
      return "settle-owned";
    }

    const now = Date.now();
    const backoffMs =
      this.session.options.credentialReleaseBackoffMs ?? CREDENTIAL_RELEASE_BACKOFF_MS;
    const prevCount = current.credentialAttempts ?? 0;
    const lastAt = current.lastCredentialReleaseAt;
    const withinBackoff = lastAt !== undefined && now - lastAt < backoffMs;
    const count = withinBackoff ? prevCount : prevCount + 1;
    // NB: the durable counter records COMPLETED release cycles, not the
    // terminal attempt — on settle-cap the row keeps credential_attempts at
    // MAX-1 (or lower under burst coalescing) because the cap returns before
    // any CAS and settlement deliberately writes no counter. Any future
    // feature that re-runs a settled row must reset or re-derive the budget
    // rather than trusting this value.
    if (!withinBackoff && count >= MAX_CREDENTIAL_ATTEMPTS) return "settle-cap";

    // The release CAS is the atomic authority, not the `current` snapshot
    // above: it refuses when a supersession or abort stamp landed between
    // the snapshot read and this commit (TOCTOU window). The budget counters
    // ride the same CAS — persisted iff the release lands.
    const released = await store.releaseSubmission(
      this.session.id,
      this.id,
      claimed.id,
      releaseFence,
      { attempts: count, lastReleaseAt: withinBackoff && lastAt !== undefined ? lastAt : now },
    );
    if (released) return "released";
    // CAS refused. Re-read to decide who owns the item now: still running
    // under OUR attempt means a supersession/abort stamped after the
    // snapshot — we must settle it ourselves (a bare CAS-fail must never
    // strand the item running+stamped). Anything else: a successor owns it.
    const after = await store.getQueueItem(this.session.id, claimed.id);
    if (!after || after.status !== "running" || after.attemptId !== releaseFence.attemptId) {
      return "abandon";
    }
    return "settle-owned";
  }

  /**
   * The thread's oldest unsettled, non-superseded, non-collecting submission —
   * mirrors the store's claim-head rule. A running/blocked/terminalizing head
   * blocks every later item from being claimed.
   */
  private async unsettledHead(): Promise<QueueItem | undefined> {
    const all = await this.session.providers.store.listUnsettledSubmissions(this.session.id);
    return all
      .filter((i) => i.threadId === this.id && i.status !== "collecting" && !i.supersededByItemId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  }

  /**
   * Retry the finalize half of an interrupted settlement. The outcome is
   * already durably recorded on the item; finalize re-runs the fence against
   * the item's stored CURRENT attemptId (never cleared on terminal
   * transitions), so this is safe even after the in-memory fence is gone.
   */
  async retryFinalize(item: QueueItem): Promise<boolean> {
    const store = this.session.providers.store;
    const attemptId = item.attemptId;
    if (!attemptId) return false; // defensive: terminalizing items always carry one
    const fence: WriteFence = { itemId: item.id, attemptId };
    try {
      await this.notifyTurnComplete(item);
      await store.finalizeSettlement(this.session.id, this.id, item.id, fence);
    } catch (err) {
      if (err instanceof StaleAttemptError) return false; // successor owns it now
      this.emitError(
        "settlement_failed",
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
    await store.deleteAttemptMarker(item.id, attemptId);
    await this.emitSettled(item.id, item.outcome ?? { outcome: "completed" });
    await this.emitQueueState();
    return true;
  }

  /**
   * Two-phase settlement for a claimed turn. Skipped when the turn is still
   * blocked on a decision gate (the claim is retained), or when a stale fence
   * signalled that a successor already owns the item.
   */
  private async settleTurn(item: QueueItem, turnFailure?: { error: unknown }): Promise<void> {
    return this.inSubmissionContext(() =>
      withSpan(
        "submission.settle",
        {
          "valet.session.id": this.session.id,
          "valet.thread.id": this.id,
          "valet.queue_item.id": item.id,
        },
        (span) => this.settleTurnInner(item, turnFailure, span),
      ),
    );
  }

  private async settleTurnInner(
    item: QueueItem,
    turnFailure: { error: unknown } | undefined,
    span: Span,
  ): Promise<void> {
    if (this.staleFenceDetected) {
      // A successor owns this item; do not settle. (Zombie self-fencing.)
      return;
    }
    const fence = this.fence;
    if (!fence) return;
    const store = this.session.providers.store;
    const current = await store.getQueueItem(this.session.id, item.id);
    if (!current) return;
    // Gate-blocked turns do not settle — the claim is retained until the gate
    // resolves and the turn actually ends.
    if (current.status === "blocked_on_decision_gate") return;
    if (current.status === "settled" || current.status === "terminalizing") return;

    const outcome = this.decideTurnOutcome(current, turnFailure);
    span.setAttribute("valet.submission.outcome", outcome.outcome);
    this.submissionSpan?.setAttribute("valet.submission.outcome", outcome.outcome);
    recordSettlement(
      outcome.outcome,
      this.turnStartedAt !== undefined ? Math.max(0, this.turnStartedAt - item.createdAt) : undefined,
    );
    if (outcome.outcome === "failed") {
      markSpanError(span, outcome.error ?? "submission failed");
      if (this.submissionSpan) markSpanError(this.submissionSpan, outcome.error ?? "submission failed");
    }
    let patchRef: SettlePatchRef;
    try {
      await store.reserveSettlement(this.session.id, this.id, item.id, outcome, fence);
      await this.repairRestState(item, fence);
      // Best-effort workspace patch (engine traces spec, change 3) — runs
      // between reserve and finalize so the record lands in finalize's own
      // transaction, but its own I/O never throws and never weakens the CAS.
      patchRef = await this.captureSettlePatch(item);
      await this.notifyTurnComplete(item);
      await store.finalizeSettlement(this.session.id, this.id, item.id, fence, patchRef);
    } catch (err) {
      if (err instanceof StaleAttemptError) {
        this.staleFenceDetected = true;
        return;
      }
      throw err;
    }
    await store.deleteAttemptMarker(item.id, fence.attemptId);
    await this.emitSettled(item.id, outcome, patchRef);
    await this.emitQueueState();
  }

  private async notifyTurnComplete(item: QueueItem): Promise<void> {
    await this.session.options.onTurnComplete?.({
      sessionId: this.session.id, submissionId: item.id, threadId: this.id,
      actorId: item.author?.id ?? this.session.options.userId, owner: this.session.owner,
      sandbox: this.session.attachment.current() ?? undefined,
    });
  }

  /**
   * Best-effort settle-time patch capture (engine traces spec, change 3).
   * Never throws; a sandbox that isn't currently `ready` is skipped rather
   * than re-provisioned (a hibernated sandbox must not be woken to diff it).
   */
  private async captureSettlePatch(item: QueueItem): Promise<SettlePatchRef> {
    return withSpan(
      "patch.capture",
      { "valet.session.id": this.session.id, "valet.queue_item.id": item.id },
      async (span) => {
        const ref = await capturePatch({
          sessionId: this.session.id,
          queueItemId: item.id,
          blobs: this.session.providers.blobs,
          startRef: this.session.options.startRef,
          sandbox: this.session.attachment.current(),
          attachmentState: this.session.attachment.state,
        });
        span.setAttribute("valet.patch.status", ref.status);
        if (ref.reason !== undefined) span.setAttribute("valet.patch.reason", ref.reason);
        if (ref.bytes !== undefined) span.setAttribute("valet.patch.bytes", ref.bytes);
        if (ref.status === "failed") markSpanError(span, ref.reason ?? "patch capture failed");
        return ref;
      },
    );
  }

  /** Map the turn's terminal state to a SubmissionOutcome. */
  private decideTurnOutcome(
    current: QueueItem,
    turnFailure?: { error: unknown },
  ): SubmissionOutcome {
    // Agent messages carry no queueItemId, so scope the transcript read with
    // the in-memory turn marker instead: `currentAssistantMessageId` is
    // cleared at turn start (runItem) and set on the turn's own
    // `message_start`, so an undefined value means the trailing assistant
    // message predates this item (e.g. the credential-cap path appends
    // nothing) — its stopReason must not decide this item's outcome. A real
    // abort OF THIS ITEM still wins via the durable `abortRequestedAt` stamp
    // checked below, which `Thread.abort` writes before interrupting the
    // stream.
    const last = [...this.agent.state.messages].reverse().find((message) => message.role !== "system");
    const stop =
      this.currentAssistantMessageId !== undefined && last?.role === "assistant"
        ? last.stopReason
        : undefined;
    if (current.supersededByItemId) return { outcome: "superseded" };
    if (current.abortRequestedAt !== undefined || stop === "aborted") return { outcome: "aborted" };
    // A throw outside the agent stream (tool building, store I/O, model
    // resolution) must settle `failed` — the last agent message may be a stale
    // prior turn's clean stop and would otherwise decide `completed`.
    if (turnFailure) {
      const e = turnFailure.error;
      return { outcome: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    if (stop === "error") {
      const errText = last && last.role === "assistant" ? last.errorMessage : undefined;
      return { outcome: "failed", error: errText ?? "turn ended with an error" };
    }
    // "stop" and "length" both settle completed — a length-terminated turn
    // still ended with usable output (revisit if we want to distinguish).
    return { outcome: "completed" };
  }

  /**
   * Rest-state repair (spec, Terminalization): any trailing assistant tool_call
   * part still marked `running` when the turn ends (interrupted mid-tool) is
   * rewritten to an error part — never re-executed. Fenced.
   */
  private async repairRestState(
    item: QueueItem,
    fence: WriteFence | undefined,
    errorText: string = "interrupted",
  ): Promise<void> {
    const store = this.session.providers.store;
    const entries = await store.getEntries(this.session.id, this.id);
    for (const e of entries) {
      if (e.type !== "message" || e.role !== "assistant") continue;
      if (e.queueItemId !== item.id) continue;
      const parts = e.parts;
      if (!parts) continue;
      let mutated = false;
      for (const p of parts) {
        if (p.type === "tool_call" && p.status === "running") {
          p.status = "error";
          p.error = errorText;
          mutated = true;
        }
      }
      if (mutated) {
        await store.updateEntry(this.session.id, this.id, e, fence);
      }
    }
  }

  private async emitSettled(
    itemId: string,
    outcome: SubmissionOutcome,
    patch?: SettlePatchRef,
  ): Promise<void> {
    await this.clearActiveModelState(itemId);
    // Deterministic eventKey `settled:{itemId}`: every settlement path (fenced
    // two-phase, retryFinalize, reconciliation, and the fenceless
    // settleUnclaimed sites) routes through here, so a double-emission across
    // restart/reconcile paths dedupes to exactly one durable row per item.
    await this.session.emit(
      {
        type: "submission_settled",
        sessionId: this.session.id,
        threadId: this.id,
        queueItemId: itemId,
        outcome,
        ...(patch ? { patch } : {}),
      },
      { eventKey: `settled:${itemId}`, queueItemId: itemId },
    );
  }

  /**
   * Reconciliation executor — settle branch (steps 1,2,3,5,6). Never-claimed
   * items (still queued/collecting) settle via the fenceless `settleUnclaimed`
   * CAS; claimed items (running/blocked) settle under a freshly-owned attempt so
   * the two-phase reserve/finalize is fenced. Superseded items additionally
   * withdraw their still-pending gate (carry-forward: steer-crash cleanup).
   */
  async settleReconciled(
    item: QueueItem,
    outcome: SubmissionOutcome,
    suspended: SuspendedTurnState | null,
  ): Promise<void> {
    const store = this.session.providers.store;

    if (item.status === "queued" || item.status === "collecting") {
      const ok = await store.settleUnclaimed(this.session.id, this.id, item.id, outcome);
      if (ok) {
        await this.emitSettled(item.id, outcome);
        await this.emitQueueState();
      }
      return;
    }

    // Claimed (running / blocked): own a fresh attempt so the settle is fenced.
    const attemptId = uid("att");
    const expectedAttemptId = item.attemptId;
    if (!expectedAttemptId) return; // defensive: claimed items always carry one
    const replaced = await store.replaceSubmissionAttempt(
      this.session.id,
      this.id,
      item.id,
      {
        sessionId: this.session.id,
        threadId: this.id,
        itemId: item.id,
        attemptId,
        ownerId: this.session.ownerId,
      },
      { expectedAttemptId },
    );
    if (!replaced) return; // lost the CAS — a successor owns it now
    const fence: WriteFence = { itemId: item.id, attemptId };

    // Carry-forward: a crash between the steer supersession stamp and the gate
    // withdrawal leaves a pending gate on the superseded item. Clean it up
    // durably (reason 'steer') as part of settling it superseded.
    if (outcome.outcome === "superseded" && suspended) {
      const gate = await store.getDecisionGate(this.session.id, suspended.gateId);
      if (gate && gate.status === "pending") {
        await persistTerminalGate(store, this.session.id, this.id, gate, {
          status: "withdrawn",
          reason: "steer",
        });
        await this.session.emit(
          {
            type: "decision_gate_withdrawn",
            threadId: this.id,
            gateId: gate.id,
            reason: "steer",
          },
          { eventKey: `gate:${gate.id}:withdrawn` },
        );
      }
    }

    let patchRef: SettlePatchRef;
    try {
      await store.reserveSettlement(this.session.id, this.id, item.id, outcome, fence);
      await this.repairRestState(item, fence);
      if (suspended) await store.clearSuspendedTurn(this.session.id, this.id, fence);
      // A claimed-then-reconciled item may have run tools before the crash or
      // supersession — capture whatever landed on disk, same best-effort
      // contract as the normal settle path.
      patchRef = await this.captureSettlePatch(item);
      await this.notifyTurnComplete(item);
      await store.finalizeSettlement(this.session.id, this.id, item.id, fence, patchRef);
    } catch (err) {
      if (err instanceof StaleAttemptError) return; // successor owns it now
      throw err;
    }
    await store.deleteAttemptMarker(item.id, attemptId);
    await this.emitSettled(item.id, outcome, patchRef);
    await this.emitQueueState();
  }

  /**
   * Reconciliation executor — gate branch (step 4). Takes over the blocked
   * turn's attempt (fresh attemptId, this instance's ownerId) so the retained
   * claim's lease renews under our heartbeat and the eventual replay's writes
   * are fenced, then either re-arms the pending gate or replays the resolved
   * one. Mirrors the pre-Task-5 `resumeBlockedThreadIfReady`, now attempt-owned.
   */
  async reconcileGate(
    item: QueueItem,
    suspended: SuspendedTurnState,
    mode: "rearm" | "replay",
  ): Promise<void> {
    // Load before taking ownership so a store failure cannot strand a retained gate claim.
    await this.ensureTranscript();
    const store = this.session.providers.store;
    const attemptId = uid("att");
    const expectedAttemptId = item.attemptId;
    if (!expectedAttemptId) return;
    const replaced = await store.replaceSubmissionAttempt(
      this.session.id,
      this.id,
      item.id,
      {
        sessionId: this.session.id,
        threadId: this.id,
        itemId: item.id,
        attemptId,
        ownerId: this.session.ownerId,
      },
      { expectedAttemptId },
    );
    if (!replaced) return; // lost the CAS
    await store.insertAttemptMarker(item.id, attemptId);
    this.runningItem = replaced;
    this.turnStartedAt = Date.now();
    this.fence = { itemId: item.id, attemptId };
    this.staleFenceDetected = false;
    this.session.ensureTimers();

    const gate = await store.getDecisionGate(this.session.id, suspended.gateId);
    if (!gate) {
      // Gate vanished between the decision and here — nothing to re-arm.
      this.runningItem = null;
      this.fence = undefined;
      return;
    }

    if (mode === "rearm") {
      this.armPendingGateForRestart(gate, suspended);
    } else {
      const entries = await store.getEntries(this.session.id, this.id);
      const entry = entries.find(
        (e) => e.type === "decision_gate" && e.gate.id === gate.id,
      );
      const resolution = entry && entry.type === "decision_gate" ? entry.resolution : undefined;
      if (!resolution) {
        this.emitError("replay_missing_resolution", `gate ${gate.id} resolved but no resolution stored`);
        this.runningItem = null;
        this.fence = undefined;
        return;
      }
      this.kickBackgroundDrive("replay_drive_rejected", suspended.queueItemId, undefined, () =>
        this.replayBlocked({ suspended, resolution }),
      );
    }
    await this.emitQueueState();
  }

  /**
   * Reconciliation executor — resume branch (step 7). Own a fresh attempt (CAS
   * on the dead one), record the marker, repair the transcript rest-state
   * FIRST (dangling tool_call parts → error, never re-executed — per the
   * continuation contract, an honest error is the only safe injection), rehydrate
   * the agent transcript, append synthetic toolResults for the interrupted
   * calls so the trailing message is toolResult-convertible, then continue the
   * turn and settle it normally.
   *
   * Resolves once the fresh attempt is claimed and the resume drive is
   * KICKED via `kickBackgroundDrive` — never when the resumed turn finishes.
   * This method is awaited from `Session.reconcile()`, which
   * `rehydrate`/`restoreSession` awaits, which the host's single-flight
   * `sessionFor` hands to every threads/messages/decisions route. Awaiting
   * the drive here held all of those pending for the resumed turn's full
   * duration — and DEADLOCKED permanently when the resumed turn parked on a
   * decision gate, because the human who had to resolve the gate could not
   * load the session that was waiting on them (dev incident 2026-09-05; see
   * test/restore-nonblocking.test.ts).
   */
  async resumeInterrupted(item: QueueItem): Promise<void> {
    const store = this.session.providers.store;
    const attemptId = uid("att");
    const expectedAttemptId = item.attemptId;
    if (!expectedAttemptId) return;
    const replaced = await store.replaceSubmissionAttempt(
      this.session.id,
      this.id,
      item.id,
      {
        sessionId: this.session.id,
        threadId: this.id,
        itemId: item.id,
        attemptId,
        ownerId: this.session.ownerId,
      },
      { expectedAttemptId },
    );
    if (!replaced) return; // lost the CAS
    await store.insertAttemptMarker(item.id, attemptId);
    this.runningItem = replaced;
    this.turnStartedAt = Date.now();
    this.fence = { itemId: item.id, attemptId };
    this.staleFenceDetected = false;
    this.session.ensureTimers();
    await this.emitQueueState();

    this.kickBackgroundDrive("resume_drive_rejected", item.id, this.fence, () =>
      this.driveResumeToCompletion(replaced, "interrupted — result lost in restart"),
    );
  }

  /**
   * Drive an interrupted turn we already own (`runningItem` + `fence` installed
   * by the caller) to completion and settle it. Repairs the dangling tool_call
   * to an error carrying `repairMessage`, clears any stale suspended-gate
   * checkpoint, flips the durable block back to running, rehydrates the
   * transcript, continues the agent so the model sees the repaired state, then
   * settles normally. Shared by `resumeInterrupted` (step-7 resume) and the
   * re-armed-gate expiry/withdrawal terminalization (`terminalizeReconciledGate`).
   */
  private async driveResumeToCompletion(item: QueueItem, repairMessage: string): Promise<void> {
    return withSpan(
      "agent.turn",
      {
        "valet.session.id": this.session.id,
        "valet.thread.id": this.id,
        "valet.queue_item.id": item.id,
        "valet.turn.resumed": true,
      },
      async (span) => {
        this.turnSpan = span;
        this.turnToolCallCount = 0;
        this.llmRoundStartedAt = Date.now();
        try {
          await this.driveResumeToCompletionInner(item, repairMessage);
        } finally {
          this.turnSpan = undefined;
          this.llmSpan?.end();
          this.llmSpan = undefined;
        }
      },
    );
  }

  private async driveResumeToCompletionInner(item: QueueItem, repairMessage: string): Promise<void> {
    const store = this.session.providers.store;
    const fence = this.fence;
    if (!fence) return;

    let turnFailed = false;
    let turnError: unknown;
    const baselineModel = this.agent.state.model;
    try {
      // Rest-state repair FIRST — before appending any recovery output.
      await this.repairRestState(item, fence, repairMessage);

      // A resume reached from the blocked fall-through (gate expired/withdrawn/
      // missing while the engine was down) still has the suspended-turn
      // checkpoint on disk; clear it so a later restart doesn't try to replay a
      // dead gate.
      const staleSuspended = await store.getSuspendedTurn(this.session.id, this.id);
      if (staleSuspended && staleSuspended.queueItemId === item.id) {
        await store.clearSuspendedTurn(this.session.id, this.id, fence);
      }
      // Same fall-through: flip the durable block back to running (strict
      // blocked→running toggle, done once) so the resumed turn can settle —
      // settleTurn refuses to settle a blocked item.
      if (item.status === "blocked_on_decision_gate") {
        await store.setSubmissionBlocked(this.session.id, this.id, item.id, false, fence);
      }

      // Rehydrate from the repaired entries. entriesToAgentMessages answers
      // every resolved (completed/error) tool call — including the crash point
      // just repaired to an interrupted error — so the trailing message is
      // toolResult-convertible, satisfying the continuation contract. No
      // separate synthetic append: entriesToAgentMessages is the single owner
      // of toolResult emission (no callId is ever answered twice).
      const snapshot = await this.transcriptSnapshot();
      const entries = snapshot.entries;
      const resumeModel = this.effectiveModelLenient();
      this.replaceActiveSkillInvocations(entries);
      this.replaceAgentMessages(entriesToAgentMessages(
        entries,
        {
          api: resumeModel.api,
          provider: resumeModel.provider,
          id: resumeModel.id,
        },
        {
          attributeAuthors: this.attributeAuthors,
          threadKey: this.key,
          activeLeafEntryId: this.activeLeafEntryId,
        },
      ));
      this.transcriptPending = false;
      this.agent.state.tools = this.buildTools();

      // Host resolver (if any) delivers this resumed turn's per-turn key before
      // the continuation LLM call; no-op when absent.
      await this.applyResolvedKeyForResume(item);
      if (await this.publishActiveModelState(item.id, this.agent.state.model) &&
          await this.canRunCurrentSubmission()) {
        await this.agent.continue();
        await this.agent.waitForIdle();
      }
    } catch (err) {
      turnFailed = true;
      turnError = err;
      this.emitError("resume_failed", err instanceof Error ? err.message : String(err));
    } finally {
      this.agent.state.model = baselineModel;
      this.turnApiKey = undefined;
    }

    try {
      await this.settleTurn(item, turnFailed ? { error: turnError } : undefined);
    } catch (err) {
      this.emitError("settlement_failed", err instanceof Error ? err.message : String(err));
      return;
    } finally {
      await this.clearActiveModelState(item.id, { finalizeLocal: true });
      if (this.staleFenceDetected) {
        try {
          await store.deleteAttemptMarker(item.id, fence.attemptId);
        } catch (err) {
          this.emitError(
            "stale_marker_cleanup_failed",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      this.runningItem = null;
      this.fence = undefined;
    }
    void this.kick();
  }

  /**
   * Emit the derived `queue_state` event for this thread from durable rows.
   * The emit envelope's retention-linkage `queueItemId` defaults to the
   * running item; pass `{ queueItemId: null }` to emit untagged (used by the
   * credential-release path, where the item has just gone back to `queued`
   * but the in-memory claim must stay installed until the loop's finally —
   * clearing it early opens a window for a concurrent reconcile to install a
   * fresh claim that the pending finally would strip).
   */
  private async emitQueueState(opts?: { queueItemId?: string | null }): Promise<void> {
    const items = await this.session.providers.store.listUnsettledSubmissions(this.session.id);
    const state = deriveQueueState(this.id, items, this.mode, this.paused, this.blockedGateId);
    const tag = opts?.queueItemId === undefined ? this.runningItem?.id : opts.queueItemId;
    await this.session.emit(
      { type: "queue_state", threadId: this.id, state },
      { queueItemId: tag ?? undefined },
    );
  }

  /**
   * Build and persist the turn's user MessageEntry (signal envelope handling
   * included) under the current fence, and return the text the model actually
   * sees this turn. Called by `runItem` on the normal path and by the claim
   * loop's credential-cap branch — a capped keyless submission must still
   * leave a transcript record of what the user asked (every pre-cap
   * credential attempt returns BEFORE appending, so the cap append is the
   * item's first and only one).
   */
  private async appendUserEntry(
    item: QueueItem,
  ): Promise<{ text: string; attachments: MessageEntry["attachments"] }> {
    // Signal content persists as its raw body + `signal` metadata; the text
    // the model actually sees this turn is the same rendered XML envelope
    // `entriesToAgentMessages` would reconstruct on reload (single render
    // function, two call sites).
    let signalMeta: MessageEntry["signal"];
    let text: string;
    let entryContent: string;
    if (isSignalContent(item.content)) {
      signalMeta = buildSignalMeta(item.content, item.metadata);
      text = renderSignalEnvelope(signalMeta, item.content.body);
      entryContent = item.content.body;
    } else {
      text = promptText(item.content);
      entryContent = text;
    }

    // Extract attachments if the prompt content has them.
    let attachments: MessageEntry["attachments"];
    if (
      typeof item.content === "object" &&
      item.content !== null &&
      "attachments" in item.content &&
      Array.isArray(item.content.attachments)
    ) {
      // Runtime validation of each attachment element to guard against malformed wire data
      const validated: MessageEntry["attachments"] = [];
      for (const att of item.content.attachments) {
        if (typeof att !== "object" || att === null) continue;
        if (att.type === "file") {
          // Sandbox file (upload subsystem): persist path/size/hash so the
          // REST projection and the transcript note survive reload. A
          // malformed file attachment is DROPPED with a warning — it must
          // never fall through to the image branch, where it would persist
          // as a phantom image with no url/data and silently vanish from
          // the projection and the transcript note on reload.
          if (
            typeof att.path === "string" &&
            typeof att.bytes === "number" &&
            typeof att.sha256 === "string" &&
            typeof att.name === "string"
          ) {
            validated.push({
              type: "file" as const,
              path: att.path,
              bytes: att.bytes,
              sha256: att.sha256,
              mimeType: att.mimeType,
              markdownPath: att.markdownPath,
              extractedTo: att.extractedTo,
              extractedFiles: att.extractedFiles,
              name: att.name,
            });
          } else {
            console.warn(
              `thread ${this.id}: dropping malformed file attachment (name=${String(att.name)})`,
            );
          }
        } else if (typeof att.mimeType === "string") {
          // Data/url-carrying media (images; channel audio/file bytes keep
          // their long-standing image-shaped persistence).
          validated.push({
            type: "image" as const,
            url: att.url,
            data: att.data,
            mimeType: att.mimeType,
            name: att.name,
          });
        }
        // Skip malformed elements silently; real issues will surface in model calls
      }
      attachments = validated.length > 0 ? validated : undefined;
    }

    // IDEMPOTENT: skip when this submission's user entry already exists — a
    // transient settle throw after the credential-cap append leaves a
    // `running` item WITH its user entry; the retried attempt (fresh re-run
    // or a second cap pass) must not duplicate it. Return the persisted
    // entry's attachments (the authoritative on-disk shape) so a retried
    // attempt still feeds the model the same image blocks.
    const existing = await this.session.providers.store.getEntries(this.session.id, this.id);
    const existingUserEntry = existing.find(
      (e): e is MessageEntry =>
        e.type === "message" && e.role === "user" && e.queueItemId === item.id,
    );
    if (existingUserEntry) {
      // A spilled entry keeps the FULL paste in `content` (durable, REST-
      // visible) and carries the file path in metadata. Reconstruct the
      // pointer for the LLM so a replayed turn re-prompts what fits the window,
      // not the oversized text — matching what entriesToAgentMessages renders.
      const spillPath = existingUserEntry.metadata?.[SPILLED_INPUT_PATH_KEY];
      const restoredText =
        typeof spillPath === "string"
          ? buildSpilledInputMarker({
              path: spillPath,
              tokens: estimateTokens(existingUserEntry.content),
              chars: existingUserEntry.content.length,
            })
          : text;
      return {
        text: renderReplyContext(restoredText, existingUserEntry.metadata),
        attachments: existingUserEntry.attachments,
      };
    }

    // Divert an oversized paste to a sandbox file before it enters context.
    // Signals are exempt: they are bounded and their XML envelope must render
    // verbatim. Compaction never shrinks the newest turn, so a single message
    // larger than the window is un-compactable; spilling keeps the content
    // reachable (the agent pages the file) without the overflow loop. The full
    // text stays in `entryContent` (persisted, REST-visible); only the LLM
    // `text` becomes the pointer — so nothing the user pasted is discarded.
    const entryId = uid("e");
    let spilledInputPath: string | undefined;
    if (signalMeta === undefined) {
      const threshold = inputSpillThreshold(
        this.agent.state.model,
        this.session.options.compaction,
      );
      if (estimateTokens(entryContent) > threshold) {
        spilledInputPath = await this.spillOversizedInput(entryId, entryContent);
        if (spilledInputPath !== undefined) {
          text = buildSpilledInputMarker({
            path: spilledInputPath,
            tokens: estimateTokens(entryContent),
            chars: entryContent.length,
          });
        }
        // On spill failure `text` stays the full content; the compaction
        // fail-safe surfaces a clear error if it overflows, no data lost.
      }
    }

    // QueueItem.metadata flows through onto the entry so synthetic flags like
    // compaction_continue survive into the DAG for client UIs and for later
    // restoration.
    const baseMetadata = stripSignalStamp(item.metadata);
    const metadata = spilledInputPath
      ? { ...(baseMetadata ?? {}), [SPILLED_INPUT_PATH_KEY]: spilledInputPath }
      : baseMetadata;

    text = renderReplyContext(text, metadata);

    const userEntry: MessageEntry = {
      id: entryId,
      sessionId: this.session.id,
      threadId: this.id,
      parentId: null,
      type: "message",
      role: "user",
      content: entryContent,
      signal: signalMeta,
      author: item.author,
      channel: item.channel,
      attachments,
      // signalStamp (when present) has already been lifted into `signal`
      // above; stripping it here avoids duplicating the sender stamp into
      // the persisted entry's metadata (and onto the wire) a second time.
      // Built as a fresh object so the queue item's own stored metadata is
      // never mutated.
      metadata,
      queueItemId: item.id,
      createdAt: Date.now(),
    };
    await this.fencedWrite(() =>
      this.appendEntry(userEntry, this.fence),
    );
    return { text, attachments };
  }

  /**
   * Write an oversized inbound message to a file in the sandbox for the agent
   * to page over, and return its path (undefined on failure). The full text
   * stays in the persisted entry either way — the path only drives what the
   * LLM sees (a pointer via `buildSpilledInputMarker`), so nothing the user
   * pasted is ever discarded. The file lives under the workspace so the read
   * and bash tools reach it. On failure the full content stays in context and
   * the compaction fail-safe surfaces a clear error if it still overflows —
   * that beats silently truncating the user's words.
   */
  private async spillOversizedInput(
    entryId: string,
    content: string,
  ): Promise<string | undefined> {
    const root = this.session.options.workspace.replace(/\/+$/, "");
    const dir = `${root}/.valet/large-inputs`;
    const path = `${dir}/${entryId}.txt`;
    try {
      await this.session.sandbox.mkdir(dir);
      await this.session.sandbox.writeFile(path, content);
      return path;
    } catch (err) {
      this.emitError(
        "input_spill_failed",
        `Could not save an oversized message to the sandbox (${
          err instanceof Error ? err.message : String(err)
        }); keeping the full message in context, which may overflow and surface a clear error.`,
      );
      return undefined;
    }
  }

  /**
   * Run the claimed turn inside an `agent.turn` span, itself parented under
   * the live `submission.run` span. The span's usage/cost/model attributes
   * are stamped by the `turn_end` handler via `this.turnSpan`; children
   * (model resolution, tool executions, sandbox execs, credential reads)
   * nest automatically through the host's context manager.
   */
  private async runItem(item: QueueItem): Promise<void> {
    await this.ensureTranscript();
    return this.inSubmissionContext(() =>
      withSpan(
        "agent.turn",
        {
          "valet.session.id": this.session.id,
          "valet.thread.id": this.id,
          "valet.queue_item.id": item.id,
          // Context size going INTO the turn — the first thing to look at
          // when a turn is slow (big context → slow rounds, compaction risk).
          "valet.turn.context_messages": this.agent.state.messages.length,
          ...(item.role !== undefined ? { "valet.turn.role": item.role } : {}),
          ...(item.model !== undefined ? { "valet.turn.model_override": item.model } : {}),
        },
        async (span) => {
          this.turnSpan = span;
          this.turnToolCallCount = 0;
          this.llmRoundStartedAt = Date.now();
          try {
            await this.runItemInner(item);
          } finally {
            this.turnSpan = undefined;
            this.llmSpan?.end();
            this.llmSpan = undefined;
          }
        },
      ),
    );
  }

  /** Run `fn` with the live `submission.run` span as the active parent. */
  private inSubmissionContext<T>(fn: () => Promise<T>): Promise<T> {
    const span = this.submissionSpan;
    if (!span) return fn();
    return otelContext.with(otelTrace.setSpan(otelContext.active(), span), fn);
  }

  private async runItemInner(item: QueueItem): Promise<void> {
    this.aborted = false;
    this.credentialError = undefined;
    this.turnAgentError = undefined;
    // Per-turn: the next turn may hold a transcript compaction can help.
    this.turnCompactionBlocked = false;
    this.currentAssistantMessageId = undefined;
    this.currentAssistantParts = [];
    this.currentToolCalls.clear();
    if (!(await this.canRunCurrentSubmission())) return;

    // Warm-on-claim (spec decision 5): kick sandbox provisioning at the
    // start of the claimed turn, in parallel with the LLM call — never at
    // session-create time. Hoisted ABOVE model resolution so provisioning is
    // amortized over credential-release cycles too (a keyless turn still
    // warms; the sandbox is ready by the time a key appears). Fire-and-forget;
    // tool ops that touch the sandbox await readiness themselves via
    // PolicySandbox. Sessions opted out via `warmSandboxOnClaim: false`
    // (e.g. orchestrators) stay sandbox-less until a turn's tool actually
    // touches the filesystem — the lazy PolicySandbox attachment provisions
    // on that first touch.
    if (this.session.options.warmSandboxOnClaim !== false) {
      this.session.attachment.warm();
    }

    // Layered model resolution (item model → thread pin → session default),
    // BEFORE the user-entry append and buildTools. A host resolver that throws
    // NoCredentialsError means the turn cannot reach the model at all: flag
    // it for the claim loop's release path and return with NO user entry
    // appended, NO agent run, and NO assistant error entry — so bounded
    // credential retries never duplicate entries. Any OTHER resolver throw
    // (disabled provider, model not active, unknown provider, dead pin)
    // settles the turn `failed`: append the user entry FIRST so the prompt
    // is still in the transcript when the failure surfaces, then rethrow
    // with an identical failure surface.
    let turnModel: PiModel;
    try {
      turnModel = await this.resolveTurnModelForTurn(item);
    } catch (err) {
      if (err instanceof NoCredentialsError) {
        this.credentialError = err;
        return;
      }
      await this.appendUserEntry(item);
      throw err;
    }

    if (!(await this.canRunCurrentSubmission())) {
      this.turnApiKey = undefined;
      return;
    }

    // Apply the turn model (resolved above) BEFORE the role overlay so a
    // role's model frontmatter still wins for that one turn. The baseline is
    // captured here so we restore the right thing, not whatever the role
    // overlaid. Applied before the pre-turn compaction below so its budget
    // math sees this turn's effective model.
    const baselineModel = this.agent.state.model;
    if (turnModel !== baselineModel) {
      this.agent.state.model = turnModel;
    }

    // Publish the model that was actually applied before any compaction can
    // invoke an LLM. If the fence is stale, restore the turn-scoped values
    // before the claim loop performs settlement and claim cleanup.
    let modelStatePublished: boolean;
    try {
      modelStatePublished = await this.publishActiveModelState(item.id, this.agent.state.model);
    } catch (err) {
      this.agent.state.model = baselineModel;
      this.turnApiKey = undefined;
      await this.appendUserEntry(item);
      throw err;
    }
    if (!modelStatePublished) {
      this.agent.state.model = baselineModel;
      this.turnApiKey = undefined;
      return;
    }

    // Pre-turn protection for the first post-restart turn (spec decision 5):
    // when the rehydrate seed says the persisted context already exceeds
    // usable, compact BEFORE this turn's LLM call — the regular proactive
    // check only runs post-turn and would let this turn hit the model with
    // an over-budget context. One-shot: consumed here whether or not it
    // triggers; every later turn is covered by the post-turn check.
    //
    // MUST run before appendUserEntry: compaction rebuilds
    // agent.state.messages from the persisted DAG, so a user entry persisted
    // first would enter the rebuilt transcript AND be prompted again by
    // runAgent — the model would see the prompt twice.
    if (this.rehydratedCheckPending) {
      this.rehydratedCheckPending = false;
      if (this.shouldCompactProactive()) {
        await this.runProactiveCompaction(false);
      }
    }

    // Persist the user message entry (shared helper — the claim loop's
    // credential-cap branch appends the same entry shape). Threading
    // `attachments` through to `runAgent` is what keeps a turn-1 image in
    // `agent.state.messages` across subsequent turns: the LLM sees the image
    // on every downstream call, not just the turn it was uploaded on.
    const { text, attachments } = await this.appendUserEntry(item);
    const queuedSkillFact = item.metadata?.skillInvocation;
    if (isSkillInvocationFact(queuedSkillFact)) {
      this.activeSkillInvocations.set(queuedSkillFact.id, queuedSkillFact);
    }

    // Build the AgentTool list with closures over this turn's ToolContext.
    this.agent.state.tools = this.buildTools();

    // Repo AGENTS.md instructions overlay (agents-md spec, decision 4):
    // applied FIRST so the composition is base → systemContext → repo
    // instructions → role → cold hint, and restored LAST so the existing
    // overlays nest unchanged inside it.
    const repoInstructionsApplied = this.applyRepoInstructionsForTurn();
    // Apply role overlay (system-prompt overlay + optional model override) for
    // this one turn. Restored unconditionally in finally.
    const roleOverlay = this.applyRoleForTurn(item);
    // Cold-attachment hint (spec decision 7), applied AFTER the role overlay
    // so the two compose (role text, then hint). Restored unconditionally in
    // finally, before the role restore, so both idioms nest correctly
    // whether or not a role was applied this turn.
    const coldHintApplied = this.applyColdHintForTurn();
    // Followed Slack-thread signals carry `reply: "manual"`. Add the shared
    // delivery guidance after all other turn overlays so it remains prominent.
    const slackOverheardApplied = this.applySlackOverheardGuidanceForTurn(item);
    // The sender line must match what entriesToAgentMessages renders for
    // this entry on reload — same gate (shared owner, non-signal), same
    // render function — or the hot and cold transcripts diverge.
    const sender =
      this.attributeAuthors && !isSignalContent(item.content) ? item.author : undefined;
    try {
      // A role can replace the queue-item model. Publish the replacement
      // after the overlay applies and before the main agent run.
      if (!(await this.publishActiveModelState(item.id, this.agent.state.model))) return;

      try {
        await this.runAgent(text, attachments, sender);
      } catch (err) {
        // Record the throw for settlement: a stream failing before its first
        // message_start leaves no assistant message this turn, and
        // decideTurnOutcome ignores stale trailing messages — without this
        // the turn would settle `completed`. The claim loop folds it into
        // turnFailed; abort/supersession still take precedence there.
        this.turnAgentError = err;
        this.emitError("agent_failed", err instanceof Error ? err.message : String(err));
      }

      // Proactive compaction: if this turn pushed us past usable, run a
      // compaction pass before yielding back to the queue. Reactive
      // compaction (overflow retry) is handled inline in runAgent.
      if (this.shouldCompactProactive()) {
        await this.runProactiveCompaction();
      }
    } finally {
      this.restoreSlackOverheardGuidanceAfterTurn(slackOverheardApplied);
      this.restoreColdHintAfterTurn(coldHintApplied);
      this.restoreRoleAfterTurn(roleOverlay);
      this.restoreRepoInstructionsAfterTurn(repoInstructionsApplied);
      // Restore the agent's baseline model so the next turn picks up any
      // mutation we made via setModel. We compute the override fresh on
      // each turn anyway, but keeping state tidy avoids surprises.
      this.agent.state.model = baselineModel;
      // Per-turn key is turn-scoped only — clear it so the next turn re-resolves
      // (rotation applies next turn; a resolver-less session never set it).
      this.turnApiKey = undefined;
    }
  }

  /**
   * Cold-attachment model hint (spec decision 7): when the sandbox
   * attachment isn't ready at turn start, appends a hint to the
   * (role-overlaid) system prompt telling the model filesystem/shell tools
   * will wait. Returns whether it added a section so the caller can remove it
   * in the turn's finally.
   *
   * For `warmSandboxOnClaim: false` sessions the hint applies only while
   * the attachment is actually `provisioning` — a lazy session's earlier
   * turn may have kicked a provision that is still booting when this turn
   * claims. In the `detached` state nothing is provisioning (no warm()
   * kick happened), so a "provisioning" hint would be false and the lazy
   * first-touch contract covers it silently instead.
   */
  private appendSystemSection(name: string, content: string | null): void {
    this.agent.state.messages = [...this.agent.state.messages, {
      role: "system",
      content: "",
      sections: { [name]: content },
      timestamp: Date.now(),
    }];
  }

  private replaceAgentMessages(messages: AgentMessage[]): void {
    const system = getCurrentSystemMessage(this.agent.state.messages);
    this.agent.state.messages = system ? [system, ...messages] : messages;
  }

  private applyColdHintForTurn(): boolean {
    if (this.session.attachment.state === "ready") return false;
    if (this.session.options.warmSandboxOnClaim === false && this.session.attachment.state !== "provisioning") {
      return false;
    }
    const estimateMs = this.session.attachment.coldStartEstimateMs ?? 10_000;
    this.appendSystemSection(
      "valet-cold-sandbox",
      `[workspace status] The workspace sandbox is provisioning (~${Math.ceil(estimateMs / 1000)}s). Filesystem and shell tools will wait for it; sequence non-filesystem work first.`,
    );
    return true;
  }

  private restoreColdHintAfterTurn(applied: boolean): void {
    if (applied) this.appendSystemSection("valet-cold-sandbox", null);
  }

  /** Add the shared Slack guidance only to manual-delivery message signals. */
  private applySlackOverheardGuidanceForTurn(item: QueueItem): boolean {
    if (!isSignalContent(item.content) ||
        !item.content.signalType.endsWith(".message") ||
        item.content.origin?.channelType !== "slack" ||
        item.content.origin.reply !== "manual") {
      return false;
    }
    this.appendSystemSection("valet-slack-overheard", SLACK_OVERHEARD_REPLY_GUIDANCE);
    return true;
  }

  private restoreSlackOverheardGuidanceAfterTurn(applied: boolean): void {
    if (applied) this.appendSystemSection("valet-slack-overheard", null);
  }

  /**
   * Repo AGENTS.md instructions overlay (agents-md spec, decision 4).
   * Snapshots `session.repoInstructions()` exactly ONCE, here at turn start,
   * and appends a turn-local fragment. A mid-turn `refreshRepoInstructions()`
   * applies to the next turn.
   */
  private applyRepoInstructionsForTurn(): boolean {
    const instructions = this.session.repoInstructions();
    if (!instructions) return false;
    const fragment = buildRepoInstructionsFragment(instructions);
    if (!fragment) return false;
    this.appendSystemSection("valet-repo-instructions", fragment);
    return true;
  }

  private restoreRepoInstructionsAfterTurn(applied: boolean): void {
    if (applied) this.appendSystemSection("valet-repo-instructions", null);
  }

  private applyRoleForTurn(item: QueueItem): RoleOverlay {
    const roleName = item.role;
    if (!roleName) return { restore: false };
    const role = this.session.roles.get(roleName);
    if (!role) {
      // Spec: prompt-level role resolution errors fail the prompt before
      // model invocation. We surface as an emitted error and skip overlay
      // — the run still proceeds with the base configuration so the
      // failure is visible to the LLM and the user, not silent.
      this.emitError("role_not_found", `role "${roleName}" not registered on this session`);
      return { restore: false };
    }
    this.appendSystemSection("valet-role", role.content);

    let priorModel: PiModel | undefined;
    if (role.model) {
      // Resolve the role's model id against pi-ai's registry (provider/model)
      // or the session's pre-registered model. The simplest reuse: if the
      // role.model matches a known anthropic model, look it up; otherwise
      // skip the override and emit a warning.
      try {
        const next = resolveRoleModel(role.model);
        if (next) {
          priorModel = this.agent.state.model;
          this.agent.state.model = next;
          this.roleModelSpec = role.model;
        }
      } catch (err) {
        this.emitError(
          "role_model_lookup_failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return {
      restore: true,
      model: priorModel,
    };
  }

  private restoreRoleAfterTurn(overlay: RoleOverlay): void {
    this.roleModelSpec = undefined;
    if (!overlay.restore) return;
    this.appendSystemSection("valet-role", null);
    if (overlay.model !== undefined) {
      this.agent.state.model = overlay.model;
    }
  }

  /** Recheck durable cancellation after asynchronous turn setup or recovery. */
  private async canRunCurrentSubmission(): Promise<boolean> {
    if (this.aborted) return false;
    const running = this.runningItem;
    if (!running) return true;
    const item = await this.session.providers.store.getQueueItem(this.session.id, running.id);
    return this.runningItem === running && running.abortRequestedAt === undefined &&
      !!item && item.status === "running" &&
      item.abortRequestedAt === undefined && !item.supersededByItemId;
  }

  /**
   * Run one prompt cycle. On context-overflow error, compact and retry once.
   *
   * `attachments` MUST be included on the pushed user message so the current
   * turn's image content blocks land in `agent.state.messages` — otherwise
   * they exist only in persisted `MessageEntry.attachments`, which is
   * consulted (via `entriesToAgentMessages`) only on cold rehydrate, resume,
   * and compaction. A session that stays hot across turns would otherwise
   * send `[{type:"text", text}]` on turn 1 (image invisible) and on every
   * later turn (turn-1 image still invisible) — the "attachments lost after
   * turn 1" symptom.
   */
  private async runAgent(
    text: string,
    attachments?: MessageEntry["attachments"],
    sender?: PromptAuthor,
  ): Promise<void> {
    if (!(await this.canRunCurrentSubmission())) return;
    const content = userContentBlocks(text, attachments, sender);
    await this.agent.prompt({
      role: "user",
      content,
      timestamp: Date.now(),
    });
    await this.agent.waitForIdle();

    const last = this.agent.state.messages[this.agent.state.messages.length - 1];
    if (
      !this.overflowRetryInProgress &&
      last &&
      last.role === "assistant" &&
      last.stopReason === "error" &&
      // The turn's effective model, not the session default — a thread pinned
      // to a smaller-context model must detect ITS overflow (spec decision 4).
      isContextOverflow(last, this.agent.state.model.contextWindow)
    ) {
      this.overflowRetryInProgress = true;
      try {
        // A failed reactive compaction must not fail the turn as
        // agent_failed with a confusing summarizer message: report it as
        // compaction_failed and skip the retry — the recorded overflow
        // response already carries the turn's honest error (TKAI-306).
        let outcome: CompactionOutcome;
        try {
          outcome = await this.compactThread({ mode: "reactive" });
        } catch (err) {
          this.emitError(
            "compaction_failed",
            err instanceof Error ? err.message : String(err),
          );
          return;
        }
        if (outcome === "insufficient" || outcome === "coverage_gap") {
          // Compaction cannot help this transcript: the newest turn alone
          // exceeds the window, or the history it must replace carries no
          // summarizer-readable text. Neither changes on a retry, and a
          // retry would overflow again. compactThreadInner already emitted
          // the actionable error; leave the recorded overflow response and
          // stop, instead of looping. This is the bug that bricked a
          // session when a single pasted transcript exceeded the context.
          //
          // Count it once, here. The post-turn proactive check would
          // otherwise run the identical pass over the identical context: the
          // user read the same error twice for one failure, and one failure
          // moved the breaker by one anyway. The breaker still has to move,
          // or an unhelpable thread runs a doomed pass on every turn.
          this.turnCompactionBlocked = true;
          this.bumpCompactionFailureBreaker();
          return;
        }
        // Drop the failed assistant message from the agent transcript and retry.
        this.agent.state.messages = this.agent.state.messages.slice(0, -1);
        await this.agent.prompt({
          role: "user",
          content,
          timestamp: Date.now(),
        });
        await this.agent.waitForIdle();
      } finally {
        this.overflowRetryInProgress = false;
      }
      return;
    }

    await this.retryTransientTurnError();
  }

  /**
   * Turn-level retry for transient provider errors (TKAI-319). Engages only
   * when the turn settled with a classified-transient error AND the session
   * is unattended (or `turnRetry` is configured explicitly) — an interactive
   * user sees the error and decides. Each retry drops the failed assistant
   * message and calls `agent.continue()`, pi-agent-core's native re-run for
   * a transcript ending on a user/tool-result message — re-prompting would
   * append a SECOND copy of the user content and the model could act on it
   * twice. The transport layer already retried underneath; this catches the
   * failures that exhausted it (long rate-limit windows, capacity events).
   */
  private async retryTransientTurnError(): Promise<void> {
    const cfgd = this.session.options.turnRetry;
    const purpose = this.session.options.purpose;
    const unattended = purpose === "orchestrator" || purpose === "workflow" || purpose === "child";
    const maxAttempts = cfgd?.maxAttempts ?? (unattended ? UNATTENDED_TURN_RETRY_ATTEMPTS : 0);
    if (maxAttempts <= 0) return;
    // An explicitly configured empty backoff list means "no wait", not
    // "crash on index" — but an absent/empty list falls back to defaults.
    const backoff = cfgd?.backoffMs?.length ? cfgd.backoffMs : UNATTENDED_TURN_RETRY_BACKOFF_MS;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const last = this.agent.state.messages[this.agent.state.messages.length - 1];
      if (
        !last ||
        last.role !== "assistant" ||
        last.stopReason !== "error" ||
        !isRetryableAssistantError(last)
      ) {
        return;
      }
      const waitMs = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0;
      this.emitError(
        "turn_transient_retry",
        formatTransientRetryMessage({
          provider: this.agent.state.model.provider,
          errorMessage: last.errorMessage,
          waitMs,
          attempt,
          maxAttempts,
        }),
      );
      if ((await this.backoffOrStandDown(waitMs)) === "stand-down") return;
      // Drop the failed assistant message; the transcript now ends on the
      // user/tool-result message, which is exactly Agent.continue()'s
      // contract for re-running the turn without duplicating the prompt.
      this.agent.state.messages = this.agent.state.messages.slice(0, -1);
      // The retry rewinds the transcript, so the next response's cache reads
      // are expected to differ — do not count that as a break (TKAI-320).
      this.prevCacheSnapshot = undefined;
      await this.agent.continue();
      await this.agent.waitForIdle();
    }
  }

  /**
   * Abort- and steer-aware backoff for the transient retry (TKAI-319).
   * Nothing streams during the wait, so `agent.abort()` cannot interrupt
   * it — instead the sleep is chunked: `this.aborted` every second, the
   * durable queue item every 5s and once at the end. A superseded or
   * aborted item must not spawn a zombie retry racing its successor.
   */
  private async backoffOrStandDown(totalMs: number): Promise<"proceed" | "stand-down"> {
    const store = this.session.providers.store;
    const itemId = this.runningItem?.id;
    const checkItem = async (): Promise<boolean> => {
      if (!itemId) return true;
      const current = await store.getQueueItem(this.session.id, itemId);
      return (
        !!current &&
        current.status === "running" &&
        !current.supersededByItemId &&
        current.abortRequestedAt === undefined
      );
    };
    const until = Date.now() + totalMs;
    let lastItemCheck = Date.now();
    while (Date.now() < until) {
      await delay(Math.min(1_000, until - Date.now()));
      if (this.aborted) return "stand-down";
      if (Date.now() - lastItemCheck >= 5_000) {
        lastItemCheck = Date.now();
        if (!(await checkItem())) return "stand-down";
      }
    }
    if (this.aborted) return "stand-down";
    return (await checkItem()) ? "proceed" : "stand-down";
  }

  /**
   * Count a failed (or futile) proactive compaction toward the circuit
   * breaker and emit it. At the cap, emit a distinct event so clients can
   * tell the user proactive compaction gave up (a plain compaction_failed
   * looks like a one-off).
   */
  private recordProactiveCompactionFailure(code: string, message: string): void {
    this.emitError(code, message);
    this.bumpCompactionFailureBreaker();
  }

  /**
   * Count one proactive-compaction failure toward the circuit breaker and open
   * it at the threshold. Split from `recordProactiveCompactionFailure` so a
   * caller that already emitted the failure error (the "insufficient" outcome,
   * emitted inside compactThreadInner) can feed the breaker WITHOUT emitting a
   * second, duplicate error for the same pass.
   */
  private bumpCompactionFailureBreaker(): void {
    this.consecutiveCompactionFailures++;
    if (this.consecutiveCompactionFailures === MAX_CONSECUTIVE_COMPACTION_FAILURES) {
      this.emitError(
        "compaction_circuit_open",
        `Automatic compaction stopped after ${MAX_CONSECUTIVE_COMPACTION_FAILURES} consecutive attempts that failed or reclaimed nothing. Run /compact to retry manually.`,
      );
    }
  }

  /**
   * Shared handling for both proactive compaction passes (pre-turn
   * rehydration and post-turn). A thrown compaction counts as a failure; a
   * "noop" outcome ALSO counts — the trigger fired but nothing was
   * reclaimable (context dominated by system overhead the estimate cannot
   * reduce), and without the breaker that repeats silently on every turn.
   */
  private async runProactiveCompaction(autoContinue?: false): Promise<void> {
    let outcome: CompactionOutcome;
    try {
      outcome = await this.compactThread(
        autoContinue === false ? { mode: "proactive", autoContinue } : { mode: "proactive" },
      );
    } catch (err) {
      this.recordProactiveCompactionFailure(
        "compaction_failed",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    if (outcome === "noop") {
      this.recordProactiveCompactionFailure(
        "compaction_noop",
        "Compaction found nothing to reclaim: the recent turns already fit the tail budget, so the context is dominated by the system prompt and tool definitions. Reduce enabled tools or start a new thread.",
      );
    } else if (outcome === "insufficient" || outcome === "coverage_gap") {
      // Compaction cannot help this transcript. compactThreadInner ALREADY
      // emitted the actionable error for the reason it found:
      // context_overflow_unrecoverable, or compaction_coverage_gap.
      this.bumpCompactionFailureBreaker();
    } else if (
      outcome === "compacted" &&
      autoContinue !== false &&
      this.session.options.compaction?.autoContinue !== false
    ) {
      try {
        await this.continueAfterCompaction();
      } catch (err) {
        this.turnAgentError = err;
        this.emitError(
          "compaction_continuation_failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  private async continueAfterCompaction(): Promise<void> {
    const item = this.runningItem;
    if (!item) {
      throw new Error("Compaction continuation has no active submission.");
    }
    const entry: MessageEntry = {
      id: uid("e"),
      sessionId: this.session.id,
      threadId: this.id,
      parentId: null,
      type: "message",
      role: "user",
      content: AUTO_CONTINUE_PROMPT,
      channel: item.channel,
      metadata: { compaction_continue: true, synthetic: true },
      queueItemId: item.id,
      createdAt: Date.now(),
    };
    await this.fencedWrite(() => this.appendEntry(entry, this.fence));
    if (this.staleFenceDetected) return;
    await this.runAgent(AUTO_CONTINUE_PROMPT);
  }

  private shouldCompactProactive(): boolean {
    const cfg = this.session.options.compaction;
    if (cfg?.enabled === false) return false;
    // A compaction pass in this turn already reported that it cannot help
    // this transcript. Running the proactive pass now repeats that report
    // for one failure and advances the breaker twice.
    if (this.turnCompactionBlocked) return false;
    // Circuit breaker (TKAI-306): a thread whose proactive compaction keeps
    // failing must not hammer the summarizer on every turn. A successful
    // compaction (including manual /compact) closes the breaker again.
    if (this.consecutiveCompactionFailures >= MAX_CONSECUTIVE_COMPACTION_FAILURES) {
      return false;
    }
    // Budget against the turn's effective model (spec decision 4):
    // shouldCompactProactive only runs from runItem's try block, before the
    // finally restores the baseline, so `agent.state.model` is the resolved
    // turn model — including resolver-only specs `resolveModelId` can't see.
    const usable = usableTokens(this.agent.state.model, cfg);
    if (usable === 0) return false;
    // Trigger on the usage-anchored estimate (TKAI-306): the last real
    // response's reported total is the exact context of that request
    // (system prompt and tool definitions included), and only messages
    // appended since are estimated with the cut-point budget's char ruler.
    // This runs before the turn's finally-block restores the baseline
    // prompt, so the fallback estimate sees the overlays the turn used.
    // Same role filter as `convertToLlm` — custom AgentMessage kinds never
    // reach the LLM, so they must not count toward the context estimate.
    const llmMessages = this.agent.state.messages.filter(
      (m): m is Message =>
        m.role === "user" || m.role === "assistant" || m.role === "toolResult",
    );
    const estimated = estimateLiveContextTokens(
      this.modelSystemPrompt(this.agent.state.systemPrompt, this.agent.state.model), llmMessages,
    );
    return estimated >= usable;
  }

  /**
   * Run a compaction pass: prune cheap stale tool outputs, then if the
   * result still doesn't fit, summarize older messages into a
   * CompactionEntry. Persist DAG updates and rewrite agent.state.messages
   * so the next turn sees a smaller context.
   */
  async compactThread(opts: {
    mode: "proactive" | "reactive" | "manual";
    /** Free-text steer for the summarizer (manual `/compact <text>`). */
    instructions?: string;
    /**
     * Force-suppress the proactive auto-continue follow-up. Set by the
     * pre-turn rehydration pass — its turn is about to run anyway, so a
     * synthetic continuation would duplicate work.
     */
    autoContinue?: false;
  }): Promise<CompactionOutcome> {
    const cfg = this.session.options.compaction;
    if (cfg?.enabled === false) return "noop";
    await this.ensureTranscript();
    return withSpan(
      "compaction",
      {
        "valet.session.id": this.session.id,
        "valet.thread.id": this.id,
        "valet.compaction.mode": opts.mode,
      },
      async (span) => {
        const outcome = await this.compactThreadInner(opts, span);
        span.setAttribute("valet.compaction.outcome", outcome);
        return outcome;
      },
    );
  }

  private async compactThreadInner(
    opts: {
      mode: "proactive" | "reactive" | "manual";
      instructions?: string;
      autoContinue?: false;
    },
    span?: Span,
  ): Promise<CompactionOutcome> {
    const cfg = this.session.options.compaction;
    const session = this.session;
    const store = session.providers.store;
    // Budget against the thread's effective model (spec decision 4). Inside
    // a claimed turn (proactive after runAgent, reactive within it),
    // `agent.state.model` is the resolved turn model — exact, including
    // role overlays and resolver-only specs. A manual `/compact` can run
    // outside a claim, where `agent.state.model` still holds the session
    // baseline — resolve the pin leniently there instead.
    const effectiveModel = this.runningItem
      ? this.agent.state.model
      : this.effectiveModelLenient();
    const model = cfg?.summarizerModel ?? effectiveModel;

    // Load the full DAG, then follow the active leaf to the root. Other
    // branches stay durable but must not enter this compaction pass.
    const snapshot = await this.transcriptSnapshot();
    const entries = walkTranscriptDag(snapshot.entries, this.activeLeafEntryId);

    // Step 1: pruning pass (cheap, no LLM).
    const protectedTools = new Set<string>();
    for (const t of [...session.builtinTools, ...(session.options.tools ?? [])]) {
      if (t.protectedFromPruning) protectedTools.add(t.name);
    }
    // Reflects the prune pass: after a commit this is the elided view, so
    // downstream size math (the fail-safe below) sees post-prune tokens, not
    // the un-mutated `entries`.
    let effectiveEntries: readonly SessionEntry[] = entries;
    const prunePlan = planPrune({ entries, cfg, protectedTools });
    if (prunePlan.willCommit) {
      const mutable = entries.map((e) => structuredClone(e)) as SessionEntry[];
      applyPrune(mutable, prunePlan);
      // Persist each elided entry back to the store via updateEntry. Compaction
      // only runs inside a claimed turn (from runItem after runAgent, or the
      // reactive-overflow path in runAgent), so `this.fence` names the current
      // attempt — thread it through so a superseding successor's fence still
      // wins over these writes.
      for (const entry of mutable) {
        if (!prunePlan.toElide.has(entry.id)) continue;
        await store.updateEntry(session.id, this.id, entry, this.fence);
      }
      // Apply to the live agent transcript:
      this.applyElisionsToAgentMessages(prunePlan);
      effectiveEntries = mutable;
    }

    // Step 2: cut-point selection.
    const cut = selectCutPoint({ entries, model: effectiveModel, cfg });
    if (cut.cutIndex === 0 || cut.cutIndex === entries.length) {
      // Nothing to compact: either the tail already fits everything, or
      // there's no tail to preserve. The pruning pass above may have been
      // sufficient on its own. The outcome tells the proactive caller apart:
      // "pruned" is progress; "noop" means the trigger fired but nothing was
      // reclaimable (context dominated by system overhead the budget math
      // cannot see) — left unhandled that repeats silently every turn.
      return prunePlan.willCommit ? "pruned" : "noop";
    }

    const head = entries.slice(0, cut.cutIndex);
    if (head.length === 0) return prunePlan.willCommit ? "pruned" : "noop";

    // Fail-safe: `fallbackToFloor` means selectCutPoint could not fit even the
    // last turn within the tail budget and kept it anyway. If that forced tail
    // also exceeds the usable window, summarizing the head cannot bring the
    // prompt under the limit (post-compaction context is roughly summary +
    // tail). This is the shape that loops overflow -> compact-head -> overflow:
    // an un-compactable newest turn, such as a paste too large to spill or an
    // oversized tool result. Report it as an actionable error instead of a
    // false success the reactive path retries forever. The `fallbackToFloor`
    // gate keeps this off the normal small-model path, where the tail-budget
    // floor legitimately exceeds usable. The estimate MUST use the post-prune
    // view: an oversized tool result the prune pass just elided is fittable
    // now, and counting it at full size would wrongly abandon the turn.
    const usable = usableTokens(effectiveModel, cfg);
    const tailTokens = estimateTotalTokens(effectiveEntries.slice(cut.cutIndex));
    if (cut.fallbackToFloor && usable > 0 && tailTokens > usable) {
      span?.setAttributes({
        "valet.compaction.insufficient_reason": "newest_turn_too_large",
        "valet.compaction.tail_tokens": tailTokens,
      });
      this.emitError(
        "context_overflow_unrecoverable",
        `The newest turn is about ${tailTokens} tokens, larger than the model's ${usable}-token ` +
          `usable context. Compaction keeps the newest turn verbatim, so it cannot reduce this. ` +
          `Shorten the last message, split it across turns, or attach it as a file.`,
      );
      return "insufficient";
    }

    // A checkpoint covers what its summary describes, and no more. The
    // summarizer input is a budgeted window, so a head bigger than that
    // budget is summarized across several passes: this pass takes the newest
    // part the budget holds, and the older part stays in live context for a
    // later pass to take (TKAI-461).
    //
    // Entries the superseded checkpoint already covered stay covered. Their
    // content reaches this summary through `previousSummary`, and
    // `entriesToAgentMessages` reads only the NEWEST checkpoint, so leaving
    // them out would put them back into the context an earlier pass removed.
    const supersededCheckpoint = findMostRecentCompaction(entries);
    const carriedCoverage = new Set(supersededCheckpoint?.coveredEntryIds ?? []);
    const pendingHead = head.filter((e) => !carriedCoverage.has(e.id));
    if (!pendingHead.some((e) => e.type === "message")) {
      // Nothing left to reclaim: the checkpoint this pass would supersede
      // covers every head message already, and what remains (an older
      // checkpoint, a command result, a decision gate) never reaches the
      // model context. A new checkpoint would repeat the last one and free
      // nothing. Report it the way the caller handles any futile pass, so
      // the breaker counts it instead of compacting again on the next turn.
      // This is not a coverage gap: a gap means live history would be lost,
      // and there is no live history here.
      return prunePlan.willCommit ? "pruned" : "noop";
    }

    // Step 3: summarize.
    await session.emit(
      { type: "compaction_start", threadId: this.id },
      { queueItemId: this.runningItem?.id },
    );
    let summaryResult: SummarizeResult;
    // Everything between compaction_start and here MUST balance the pair —
    // the wire contract promises "compaction_end fires on failure too", and
    // the web store's compacting indicator only clears on the end frame. The
    // finally covers the summarizer AND the persist/rebuild steps.
    try {
      const previousSummary = supersededCheckpoint?.summary;
      // Overflow retry (TKAI-306): if the summarize call itself blows the
      // summarizer model's context, shrink the input and try again. The
      // checkpoint covers whatever survives the shrink, so a dropped slice
      // costs a later pass, not the history. `previousSummary` still anchors
      // facts from earlier compactions.
      // Size the summarizer window with the ruler its payload uses. The
      // conversion caps prose and tool output, so an entry's raw estimate
      // overstates its summarizer cost, by up to 100x for a tool-heavy turn.
      // Memoized: the conversion allocates capped copies of an entry's text,
      // and the window walk, the coverage check, and the evidence budget all
      // ask for the same entries. Entries do not change within a pass.
      const summarySizes = new Map<string, number>();
      const sizeForSummary = (entry: SessionEntry): number => {
        const cached = summarySizes.get(entry.id);
        if (cached !== undefined) return cached;
        const size = estimateSummaryEntryTokens(entry, {
          toolOutputMaxChars: cfg?.toolOutputMaxChars,
          attributeAuthors: this.attributeAuthors,
        });
        summarySizes.set(entry.id, size);
        return size;
      };
      const summaryInputBudget = Math.min(
        Math.max(usableTokens(model), SUMMARY_CHECKPOINT_TAIL_MAX_TOKENS),
        SUMMARY_INPUT_MAX_TOKENS,
      );
      // Head coverage is an allocation rule, not a hope. Every covered entry
      // leaves the model context, so the window the summarizer reads is what
      // the checkpoint may claim. The window comes from the pending head
      // alone: a window over [head, tail] aligns onto the newest turn and
      // leaves the head unread, and a window over already-covered entries
      // spends the budget on history `previousSummary` already carries
      // (TKAI-461).
      let headForSummary = selectSummaryCheckpointTail(pendingHead, summaryInputBudget, {
        sizeOf: sizeForSummary,
      });
      // Recent tail evidence anchors the recovery checkpoint in the current
      // task. It is optional, so it takes the budget the head leaves, and it
      // is trimmed to what fits rather than dropped whole. A newest entry
      // that alone exceeds the evidence budget leaves no evidence. The tail
      // stays verbatim in live context either way.
      let tailEvidence = selectSummaryCheckpointTail(
        effectiveEntries.slice(cut.cutIndex),
        Math.min(
          SUMMARY_CHECKPOINT_TAIL_MAX_TOKENS,
          Math.max(
            summaryInputBudget -
              headForSummary.reduce((total, e) => total + sizeForSummary(e), 0),
            0,
          ),
        ),
        { sizeOf: sizeForSummary, keepNewest: false },
      );
      // Coverage is a property of the PAYLOAD, not of entry ids. The
      // conversion skips non-message entries and assistant entries that
      // render to nothing, so a window can hold head entries by id and still
      // send the summarizer no head content.
      const pendingHeadIds = new Set(pendingHead.map((e) => e.id));
      const coversHead = (selection: readonly SessionEntry[]): boolean =>
        selection.some((entry) => pendingHeadIds.has(entry.id) && sizeForSummary(entry) > 0);
      // This guard handles the pass that can summarize nothing: the pending
      // head carries no text the summarizer reads, so any checkpoint would
      // describe an empty transcript. It runs before the summarizer call, so
      // such a pass costs nothing. A pending head that is only PARTLY
      // readable is not this case. The checkpoint below claims the window
      // and no more, so the rest keeps its place in live context.
      if (!coversHead(headForSummary)) {
        span?.setAttributes({
          "valet.compaction.insufficient_reason": "coverage_gap",
          "valet.compaction.input_budget_tokens": summaryInputBudget,
          "valet.compaction.head_entries": pendingHead.length,
        });
        recordCompactionCoverageGap(opts.mode);
        this.emitError(
          "compaction_coverage_gap",
          `Compaction found no history to summarize. The ${pendingHead.length} entries it must replace hold ` +
            `no text the summarizer can read. Start a new thread if the context still overflows.`,
        );
        return "coverage_gap";
      }
      for (let attempt = 0; ; attempt++) {
        try {
          summaryResult = await summarize({
            headEntries: [...headForSummary, ...tailEvidence],
            model,
            toolOutputMaxChars: cfg?.toolOutputMaxChars,
            attributeAuthors: this.attributeAuthors,
            previousSummary,
            instructions: opts.instructions,
            // Reactive compaction fires WITHIN a claimed turn (and proactive
            // just after runAgent, still before the turn's finally clears it),
            // so `turnApiKey` is live here. Without this, a BYO-key session
            // whose only key comes from the host `resolveModel` seam would fail
            // the summarizer completion on first context overflow. Undefined
            // when no resolver is wired (env-fallback path) — behavior unchanged.
            apiKey: this.turnApiKey,
          });
          break;
        } catch (err) {
          if (!(err instanceof SummarizeOverflowError)) throw err;
          if (attempt + 1 >= MAX_SUMMARIZE_OVERFLOW_RETRIES) throw err;
          // Shrink in an order that keeps head coverage: the optional tail
          // evidence first, then the oldest half of the head. No
          // user-message alignment: `summarize` prepends its own preface, so
          // an assistant-first slice is a legal payload. Aligning forward to
          // the next user entry instead threw away context the budget could
          // still hold, and a slice with no user entry at all left an input
          // that providers rejected with a plain 400 that aborted this loop
          // (TKAI-461).
          if (tailEvidence.length > 0) {
            tailEvidence = [];
            continue;
          }
          const truncated = headForSummary.slice(Math.floor(headForSummary.length / 2));
          // Coverage is checked BEFORE the retry. A slice that carries no
          // head content would buy a summary this pass must then discard,
          // and both calls are billed. Neither shrink step can drop head
          // coverage once this passes, so the checkpoint below needs no
          // second check.
          if (truncated.length === headForSummary.length || !coversHead(truncated)) {
            throw err;
          }
          headForSummary = truncated;
        }
      }

      // Step 4: persist CompactionEntry.
      //
      // The covered set is the window this pass summarized, plus what the
      // superseded checkpoint covered. Both halves are described by this
      // summary: the window through the input above, the carried half
      // through `previousSummary`. Head entries outside the window are not
      // claimed, so they keep their place in live context and the next pass
      // sees a shorter pending head.
      //
      // `tokenCountBefore` and `fileContext` measure the same covered set, so
      // the compression ratio reports the history this checkpoint replaced
      // and not the history it left behind.
      const summarized = new Set(headForSummary.map((e) => e.id));
      const covered = new Set([...carriedCoverage, ...summarized]);
      const coveredEntries = entries.filter((e) => covered.has(e.id));
      const compactionEntry: CompactionEntry = {
        id: uid("c"),
        sessionId: session.id,
        threadId: this.id,
        parentId: null,
        type: "compaction",
        summary: summaryResult.summary,
        coveredEntryIds: coveredEntries.map((e) => e.id),
        tokenCountBefore: estimateTotalTokens(coveredEntries),
        tokenCountAfter: estimateTokens(summaryResult.summary),
        fileContext: extractFileContext(coveredEntries),
        createdAt: Date.now(),
      };
      // Head entries this pass deferred to the next one. They are live
      // context, not lost history, so this is a size signal and not a
      // violation: a head that needs many passes shows up here as a large
      // deferral that shrinks pass over pass.
      const deferredHead = pendingHead.filter((e) => !summarized.has(e.id));
      span?.setAttributes({
        "valet.compaction.tokens_before": compactionEntry.tokenCountBefore,
        "valet.compaction.tokens_after": compactionEntry.tokenCountAfter,
        "valet.compaction.entries_covered": compactionEntry.coveredEntryIds.length,
        "valet.compaction.head_entries_deferred": deferredHead.length,
        "valet.compaction.head_tokens_deferred": estimateTotalTokens(deferredHead),
      });
      // Fenced under the current turn's attempt (compaction is always in-turn).
      await this.appendEntry(compactionEntry, this.fence);
      // A persisted summary closes the failure circuit breaker — any mode's
      // success proves the summarizer works again (manual /compact included).
      this.consecutiveCompactionFailures = 0;

      // Step 5: rewrite agent.state.messages. The simplest and most
      // correct path is to rebuild from the now-augmented DAG.
      const updatedSnapshot = await this.transcriptSnapshot();
      const updatedEntries = updatedSnapshot.entries;
      this.replaceActiveSkillInvocations(updatedEntries);
      this.replaceAgentMessages(entriesToAgentMessages(
        updatedEntries,
        {
          api: effectiveModel.api,
          provider: effectiveModel.provider,
          id: effectiveModel.id,
        },
        {
          attributeAuthors: this.attributeAuthors,
          threadKey: this.key,
          activeLeafEntryId: this.activeLeafEntryId,
        },
      ));
      // Compaction legitimately rewrites the prefix — the next turn's cache
      // reads SHOULD drop. Reset the break-detector baseline so the expected
      // drop is not counted as a break (TKAI-320).
      this.prevCacheSnapshot = undefined;
    } finally {
      await session.emit(
        { type: "compaction_end", threadId: this.id },
        { queueItemId: this.runningItem?.id },
      );
    }

    // Step 5.5: compaction hooks (Phase 4 decision 9). Run in order, each
    // individually try/caught — a throwing hook is logged via emitError and
    // never blocks a later hook or the rest of compaction (auto-continue
    // below still runs even if every hook throws).
    for (const hook of session.options.compactionHooks ?? []) {
      try {
        await hook({
          sessionId: session.id,
          threadId: this.id,
          mode: opts.mode,
          summary: summaryResult.summary,
        });
      } catch (err) {
        this.emitError(
          "compaction_hook_failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // The proactive caller continues this same submission after this method
    // returns. Settlement therefore cannot race ahead of the continuation.

    return "compacted";
  }

  private applyElisionsToAgentMessages(plan: PruneResult): void {
    if (!plan.willCommit) return;
    // Walk agent.state.messages and replace tool-call result references.
    // pi-agent-core stores tool calls inside assistant messages and tool
    // results as separate toolResult messages. We replace toolResult content
    // for any callId in the plan.
    const elidedCallIds = new Set<string>();
    for (const ids of plan.toElide.values()) {
      for (const id of ids) elidedCallIds.add(id);
    }
    for (const m of this.agent.state.messages) {
      if (m.role !== "toolResult") continue;
      if (!elidedCallIds.has(m.toolCallId)) continue;
      m.content = [{ type: "text", text: "[output elided to save context]" }];
    }
  }

  /** Build from the actual stream model after role and agent overrides have applied. */
  private modelSystemPrompt(prompt: string | undefined, model: PiModel): string {
    const assignedSelection = this.assignedModelSpec ?? this.turnModelSpec(this.runningItem ?? undefined);
    return appendRuntimeModelContext(prompt, {
      assignedSelection,
      activeSelection: this.agentModelSwitch ?? this.roleModelSpec ?? assignedSelection,
      provider: model.provider,
      modelId: model.id,
      temporaryOverride: this.agentModelSwitch !== undefined
        ? "switch_model"
        : this.roleModelSpec !== undefined
          ? "role model"
          : this.runningItem?.model !== undefined ? "submission model" : undefined,
    });
  }

  private buildAgent(): Agent {
    // Only wire `getApiKey` when a host resolver is present. Absent → the Agent
    // is constructed with the exact same options as before the seam existed, so
    // pi-ai's env-var fallback stamps StreamOptions.apiKey (byte-identical pin).
    const hasResolver = this.session.options.resolveModel !== undefined;
    const agent = new Agent({
      initialState: {
        model: this.session.options.model,
        systemPrompt: this.buildBaseSystemPrompt(),
      },
      // Deliberate transport-retry policy (TKAI-319): pi-ai wraps provider
      // requests in an abortable backoff only when maxRetries is set — the
      // bare streamSimple left retries to whatever the SDK defaulted to.
      // The spread keeps everything pi-agent-core passes (apiKey, signal);
      // only the three knobs are pinned.
      // Defaults, not overrides (TKAI-319): anything pi-agent-core forwards
      // from its own config wins — pinning here would silently disable the
      // upstream knob forever.
      streamFn: async (model, context, options) => {
        await this.persistSkillContextAttributions();
        const runtimeModelContext = this.modelSystemPrompt(undefined, model);
        const initialSystemIndex = context.messages.findIndex((message) => message.role === "system");
        const runtimeSystem = {
          role: "system" as const,
          content: "",
          sections: { "valet-runtime-model": runtimeModelContext },
          timestamp: Date.now(),
        };
        const transcript = {
          messages: initialSystemIndex === -1
            ? [runtimeSystem, ...context.messages]
            : context.messages.map((message, index) =>
              index === initialSystemIndex && message.role === "system"
                ? {
                    ...message,
                    sections: {
                      ...message.sections,
                      "valet-runtime-model": runtimeModelContext,
                    },
                  }
                : message,
            ),
        };
        return streamSimple(model, transcript, {
          ...options,
          maxRetries: options?.maxRetries ?? TURN_STREAM_MAX_RETRIES,
          maxRetryDelayMs: options?.maxRetryDelayMs ?? TURN_STREAM_MAX_RETRY_DELAY_MS,
          timeoutMs: options?.timeoutMs ?? TURN_STREAM_TIMEOUT_MS,
          // Cache wiring (TKAI-320): a stable per-thread session id gives
          // providers with session-affinity caching a routing key (threads
          // have divergent transcripts, so the key is thread-scoped).
          // Retention defaults long for orchestrators — they idle between
          // wake-ups, outliving the short TTL. Same defaults-not-overrides
          // rule as the retry knobs above.
          sessionId: options?.sessionId ?? `${this.session.id}/${this.id}`,
          cacheRetention:
            options?.cacheRetention ??
            this.session.options.cacheRetention ??
            (this.session.options.purpose === "orchestrator" ? "long" : "short"),
          // Host sampling defaults (eval reproducibility seam). Same
          // defaults-not-overrides rule: anything pi-agent-core forwards wins.
          temperature: options?.temperature ?? this.session.options.sampling?.temperature,
          // Reasoning layers per call: pi-agent-core's own option → this
          // thread's pin → the session default. The clamp lives here (not
          // in setReasoning) so a pin survives a model that cannot honor
          // it: `model` is the model this call actually runs on.
          reasoning: resolveReasoningLevel(
            model,
            options?.reasoning,
            this.reasoningOverride,
            this.reasoningDisabled ? undefined : this.session.options.sampling?.reasoning,
          ),
          samplingParams: options?.samplingParams ?? this.session.options.sampling?.params,
        });
      },
      // Filter out custom AgentMessage types (decision_gate, compaction, etc.)
      // before the LLM sees them. They live in the engine DAG, not in LLM context.
      convertToLlm: (messages: AgentMessage[]): Message[] => {
        return messages.filter(
          (m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult",
        ) as Message[];
      },
      // Re-read the live model between loop iterations (TKAI-338).
      //
      // pi-agent-core snapshots `state.model` into its loop config once per
      // run, so a mid-run mutation is invisible to the remaining LLM calls
      // without this hook. That is what made `switch_model` a no-op for the
      // turn that called it: the tool moved the model, and the loop kept
      // streaming against the model it started on. Returning the live state
      // here is what makes "takes effect on the next LLM call" true.
      prepareNextTurn: () => ({ model: this.agent.state.model }),
      // A stale fenced publication means a successor owns this submission.
      // abort() is best-effort while a tool is executing, so also end at the
      // turn boundary before the loop can start another provider request.
      finishTurn: () => this.staleFenceDetected ? { action: "end" } : undefined,
      // Per-turn key delivery: pi-agent-core calls this with the turn's provider
      // and stamps the result onto StreamOptions.apiKey (undefined → env fallback).
      ...(hasResolver ? { getApiKey: (_provider: string) => this.turnApiKey } : {}),
    });
    agent.subscribe((event, _signal) => this.handleAgentEvent(event));
    return agent;
  }

  /**
   * Base system prompt = `options.systemPrompt` + ordered `systemContext`
   * fragments, sorted by `(order ?? 100, name)` (Phase 4 decision 6). Baked
   * in once at agent construction so it sits BEFORE the per-turn role
   * overlay (`applyRoleForTurn`) and cold-sandbox hint
   * (`applyColdHintForTurn`), both of which append to
   * `agent.state.systemPrompt` on top of whatever this returns. Final
   * composition: base → systemContext → role overlay → cold hint — a
   * deliberate deviation from the portable-runtime spec's "after role
   * overlays" ordering; do not "fix" it.
   */
  private buildBaseSystemPrompt(): string {
    const threadContext = this.session.options.threadSystemContext?.({ id: this.id, key: this.key });
    const base = [this.session.options.systemPrompt, threadContext].filter(Boolean).join("\n\n");
    const fragments = this.session.options.systemContext ?? [];
    if (fragments.length === 0) return base;
    const sorted = [...fragments].sort((a, b) => {
      const orderA = a.order ?? 100;
      const orderB = b.order ?? 100;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });
    const fragmentText = sorted.map((f) => f.content).join("\n\n");
    return base ? `${base}\n\n${fragmentText}` : fragmentText;
  }

  private buildTools(): AgentTool[] {
    const all: ToolDef[] = [...this.session.builtinTools, ...(this.session.options.tools ?? [])];
    return all.map((def) =>
      toAgentTool(def, ({ signal, toolCallId, toolName, toolArgs }) =>
        this.buildToolContext({ signal, toolCallId, toolName, toolArgs }),
      ),
    );
  }

  private buildToolContext(args: {
    signal: AbortSignal;
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }): ToolContext {
    const { signal, toolCallId, toolName, toolArgs } = args;
    const session = this.session;
    const runningContent = this.runningItem?.content;
    const origin =
      runningContent !== undefined && isSignalContent(runningContent) ? runningContent.origin : undefined;
    return {
      // Author is persisted with the submission; session credentials stay fixed.
      invocationId: toolCallId,
      userId: this.runningItem?.author?.id ?? session.options.userId,
      orgId: session.options.orgId,
      sessionId: session.id,
      threadId: this.id,
      sessionPurpose: session.options.purpose,
      cwd: session.options.workspace,
      credentials: session.credentialProvider(),
      sandbox: session.sandbox,
      recordSkillInvocation: (skill, path, injectedText) =>
        this.recordModelToolSkillInvocation(skill, path, injectedText, toolCallId),
      fileReads: {
        get: (path) => this.fileReadHashes.get(path),
        record: (path, contentHash) => this.fileReadHashes.set(path, contentHash),
      },
      config: session.options.toolConfig,
      owner: session.owner,
      policyResolver: session.options.policyResolver,
      pluginStoreFactory: session.options.pluginStoreFactory,
      browserPolicy: session.options.browserPolicy,
      extractDocument: session.options.extractDocument,
      queueItemId: this.runningItem?.id,
      // The running submission's channel origin, when it came from a channel,
      // so reply_to_origin / react_to_origin answer the right conversation.
      origin,
      sharedTranscript: session.options.sharedTranscript,
      resolveOutboundSender: session.options.resolveOutboundSender,
      signal,
      decisionGateId: this.toolCtxOverlay.gateId,
      suspendedDecision: this.suspendedDecisionForReplay,
      requestDecision: async (req: DecisionGateRequest): Promise<DecisionResolution> => {
        if (!req.resumeKey) {
          throw new Error(
            "DecisionGateRequest.resumeKey is required for restart-safe gates.",
          );
        }
        const gateCtx = {
          sessionId: session.id,
          threadId: this.id,
          queueItemId: this.runningItem?.id ?? "",
          resumeKey: req.resumeKey,
        };
        // Restart-safe replay: if running with a suspendedDecision and the
        // gate ID matches, return the stored resolution without re-persisting.
        const sc = shouldShortCircuit({
          ctx: gateCtx,
          suspendedDecision: this.suspendedDecisionForReplay,
        });
        if (sc.match) {
          const replayOrdinal = this.suspendedDecisionForReplay?.ordinal;
          this.suspendedDecisionForReplay = undefined; // one-shot
          // The persisted resolution already carries gateOrdinal from the
          // original (non-replay) requestDecision call below, but stamp it
          // defensively so a replay is self-describing even if the stored
          // record predates this field.
          return { ...sc.resolution, gateOrdinal: sc.resolution.gateOrdinal ?? replayOrdinal };
        }
        // One gate cycle at a time per thread (see gateCycleTail): the next
        // open waits until the previous gate resolves and releases the
        // durable blocked toggle (TKAI-238).
        const prevCycle = this.gateCycleTail;
        let releaseCycle!: () => void;
        this.gateCycleTail = new Promise<void>((r) => {
          releaseCycle = r;
        });
        await prevCycle;
        try {
          return await this.runGateCycle({ req, gateCtx, signal, toolCallId, toolName, toolArgs });
        } finally {
          releaseCycle();
        }
      },
      threadRead: async (key, opts) => {
        const sibling = await this.session.threadByKey(key);
        if (!sibling) return [];
        return sibling.readEntries(opts);
      },
      listThreads: async () => {
        // Pull from the store so paused/archived threads not currently
        // hydrated in memory still surface.
        const datas = await session.providers.store.listThreads(session.id);
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
      setModel: async ({ model }) => {
        // The `tool:` prefix is what marks this as an agent-initiated,
        // turn-scoped escalation rather than a change to the user's pin —
        // see ToolContext.setModel docs and Thread.setModel.
        return this.setModel(model, `tool:${toolName}`);
      },
    };
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "agent_start":
        await this.session.emit(
          { type: "thread_start", threadId: this.id },
          { queueItemId: this.runningItem?.id },
        );
        this.lastEmittedStatus = "thinking";
        await this.fencedEmit(
          { type: "status", threadId: this.id, status: "thinking" },
          { queueItemId: this.runningItem?.id },
        );
        break;
      case "message_start": {
        if (event.message.role === "assistant") {
          this.currentAssistantMessageId = uid("e");
          this.currentAssistantParts = [];
          this.currentToolCalls.clear();
          this.currentAssistantEntry = undefined;
          // One llm.generate span per assistant round, parented under the
          // turn. Start time is the SYNTHESIZED round start — the model was
          // "thinking" from the moment the prior round's work finished, and
          // message_start only fires once streaming begins.
          if (this.turnSpan) {
            this.llmSpan?.end(); // defensive: never leak a dangling round
            this.llmSpan = engineTracer().startSpan(
              "llm.generate",
              {
                startTime: this.llmRoundStartedAt ?? Date.now(),
                attributes: {
                  "valet.session.id": this.session.id,
                  "valet.thread.id": this.id,
                },
              },
              otelTrace.setSpan(otelContext.active(), this.turnSpan),
            );
          }
          await this.fencedEmit(
            {
              type: "message_start",
              threadId: this.id,
              messageId: this.currentAssistantMessageId,
              role: "assistant",
            },
            { queueItemId: this.runningItem?.id },
          );
        }
        break;
      }
      case "message_update": {
        // A superseded (zombie) attempt can keep receiving buffered stream
        // events after its fence died. Fenced durable emits already throw
        // StaleAttemptError; ephemeral emits (text_delta, tool_call_update)
        // bypass the fence, so gate them on the detected-stale flag to stop
        // painting a dead attempt's output into live clients.
        if (this.staleFenceDetected) break;
        const ev = event.assistantMessageEvent;
        if (ev.type === "text_delta") {
          await this.session.emit({
            type: "text_delta",
            threadId: this.id,
            text: ev.delta,
          });
        } else if (ev.type === "toolcall_start" || ev.type === "toolcall_delta") {
          // Live-only args streaming: forward the raw JSON chunk keyed by
          // callId so clients can render the tool call before it executes.
          const block = ev.partial.content[ev.contentIndex];
          if (block?.type === "toolCall") {
            await this.session.emit({
              type: "tool_call_update",
              threadId: this.id,
              callId: block.id,
              toolName: block.name,
              argsDelta: ev.type === "toolcall_delta" ? ev.delta : "",
            });
          }
        } else if (ev.type === "toolcall_end") {
          const part: MessagePart = {
            type: "tool_call",
            callId: ev.toolCall.id,
            toolName: ev.toolCall.name,
            status: "running",
            args: ev.toolCall.arguments,
          };
          this.currentToolCalls.set(ev.toolCall.id, part);
          this.currentAssistantParts.push(part);
        }
        break;
      }
      case "message_end": {
        if (event.message.role === "assistant" && this.currentAssistantMessageId) {
          // Close this round's llm.generate span with per-round attributes.
          // The NEXT round (if any) effectively starts now — tools run in
          // between and tool_execution_end re-stamps the round start.
          if (this.llmSpan) {
            const u = event.message.usage;
            this.llmSpan.setAttributes({
              "gen_ai.request.model": event.message.model,
              "gen_ai.usage.input_tokens": u.input,
              "gen_ai.usage.output_tokens": u.output,
              "valet.llm.stop_reason": event.message.stopReason,
              "valet.llm.tool_calls": this.currentToolCalls.size,
            });
            if (event.message.stopReason === "error") {
              markSpanError(this.llmSpan, event.message.errorMessage ?? "stream error");
            }
            this.llmSpan.end();
            this.llmSpan = undefined;
          }
          this.llmRoundStartedAt = Date.now();
          const text = textOf(event.message);
          // Compose parts: leading text + tool calls (already tracked)
          const parts: MessagePart[] = [];
          if (text) parts.push({ type: "text", text });
          for (const p of this.currentAssistantParts) parts.push(p);

          // "length" maps to end_turn: a length-terminated turn still ended
          // with usable output (Task 6 resolves result text from the last
          // assistant entry with stopReason end_turn).
          const stopReason: MessageEntry["stopReason"] | undefined =
            event.message.stopReason === "aborted"
              ? "abort"
              : event.message.stopReason === "error"
              ? "error"
              : event.message.stopReason === "stop" || event.message.stopReason === "length"
              ? "end_turn"
              : undefined; // toolUse (mid-turn) carries no stopReason
          const entry: MessageEntry = {
            id: this.currentAssistantMessageId,
            sessionId: this.session.id,
            threadId: this.id,
            parentId: null,
            type: "message",
            role: "assistant",
            content: text,
            parts,
            model: event.message.model,
            queueItemId: this.runningItem?.id,
            stopReason,
            createdAt: Date.now(),
          };
          await this.fencedWrite(() =>
            this.appendEntry(entry, this.fence),
          );
          // Hold a reference so tool_execution_end can re-persist as each
          // tool completes (`parts` is shared by reference; mutating a
          // tool_call's status flows through to this entry's parts array).
          this.currentAssistantEntry = entry;
          await this.fencedEmit(
            {
              type: "message_end",
              threadId: this.id,
              messageId: entry.id,
              reason:
                event.message.stopReason === "aborted"
                  ? "abort"
                  : event.message.stopReason === "error"
                  ? "error"
                  : event.message.stopReason === "toolUse"
                  ? "tool_use"
                  : "end_turn",
            },
            { queueItemId: this.runningItem?.id },
          );
        }
        break;
      }
      case "tool_execution_start":
        this.turnToolCallCount++;
        this.toolCtxOverlay.gateId = undefined;
        await this.fencedEmit(
          {
            type: "tool_start",
            threadId: this.id,
            tool: event.toolName,
            callId: event.toolCallId,
            args: event.args ?? {},
          },
          { queueItemId: this.runningItem?.id },
        );
        this.lastEmittedStatus = "tool_calling";
        await this.fencedEmit(
          { type: "status", threadId: this.id, status: "tool_calling" },
          { queueItemId: this.runningItem?.id },
        );
        break;
      case "tool_execution_end": {
        const part = this.currentToolCalls.get(event.toolCallId);
        const resultText = renderToolResult(event.result);
        if (part && part.type === "tool_call") {
          part.status = event.isError ? "error" : "completed";
          // Persist the *flattened* text alongside the raw structured
          // result. pi-agent-core emits AgentToolResult-shaped objects
          // (`{ content: [{ type: "text", text }] }`) and consumers that
          // try to read a tool result later (UI renderers, thread_read
          // formatting, exports) shouldn't need to know about that shape.
          // Storing both means any reader can pull `result.text` and Just
          // Get something readable; clients that want the raw blocks can
          // still inspect `result.content`.
          const structured =
            event.result && typeof event.result === "object"
              ? (event.result as Record<string, unknown>)
              : {};
          part.result = { ...structured, text: resultText };
          const skillFact = this.activeSkillInvocations.get(
            `ski:${this.session.id}:${this.id}:${event.toolCallId}`,
          );
          if (skillFact) part.skillInvocation = skillFact;
        }
        // The next LLM round begins once tool results are in — re-stamp the
        // synthesized round start so llm.generate covers its full wait.
        this.llmRoundStartedAt = Date.now();
        // Re-persist the entry now that this tool's status/result has been
        // mutated. Without this, sqlite still has status="running" + no
        // result; on reload the chat shows tool cards stuck mid-execution.
        if (this.currentAssistantEntry) {
          const entry = this.currentAssistantEntry;
          await this.fencedWrite(() =>
            this.session.providers.store.updateEntry(this.session.id, this.id, entry, this.fence),
          );
        }
        await this.fencedEmit(
          {
            type: "tool_end",
            threadId: this.id,
            tool: event.toolName,
            callId: event.toolCallId,
            result: resultText,
            ...(toolResultImages(event.result).length > 0 ? { resultData: part?.type === "tool_call" ? part.result : event.result } : {}),
            isError: event.isError,
          },
          { queueItemId: this.runningItem?.id },
        );
        break;
      }
      case "turn_end": {
        const stopReason =
          event.message.role === "assistant" ? event.message.stopReason : undefined;
        const errorMessage =
          event.message.role === "assistant" ? event.message.errorMessage : undefined;
        // Usage/cost trace (engine traces spec, change 1): one snapshot feeds
        // BOTH the entry update and the enriched turn_end event below, so the
        // two surfaces can never disagree.
        let turnUsage: MessageUsage | undefined;
        let turnCost: MessageCost | undefined;
        let turnModel: string | undefined;
        if (event.message.role === "assistant") {
          const u = event.message.usage;
          this.lastAssistantUsage = {
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
            total: u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite,
          };
          // All-zero usage (dev fakes, providers that don't report) is
          // "no usage reported" — omit, mirroring the cost-is-null rule.
          if (this.lastAssistantUsage.total > 0) turnUsage = { ...this.lastAssistantUsage };
          turnModel = event.message.model;
          // Cache-break telemetry (TKAI-320): compare against the previous
          // turn's snapshot and count breaks by cause. Alert-only — nothing
          // here changes behavior.
          if (this.lastAssistantUsage.total > 0) {
            const snapshot: CacheTurnSnapshot = {
              promptTokens: u.input + u.cacheRead + u.cacheWrite,
              cacheRead: u.cacheRead,
              modelId: event.message.model,
              systemPromptLength: this.modelSystemPrompt(this.agent.state.systemPrompt, this.agent.state.model).length,
              toolCount: this.agent.state.tools.length,
            };
            // prev.cacheRead > 0 proves this provider reports cache usage
            // at all — OpenAI-compatible/custom providers that never do
            // would otherwise trip the detector on every turn forever.
            if (this.prevCacheSnapshot && this.prevCacheSnapshot.cacheRead > 0) {
              const cause = classifyCacheBreak(this.prevCacheSnapshot, snapshot);
              if (cause) {
                recordCacheBreak(cause, snapshot.modelId);
                console.error(
                  `[engine] cache break session=${this.session.id} thread=${this.id} cause=${cause} expected_read≈${this.prevCacheSnapshot.promptTokens} got=${snapshot.cacheRead}`,
                );
              }
            }
            this.prevCacheSnapshot = snapshot;
          }
          // Cost is null, not zero: unpriced models (custom providers, dev
          // fakes) omit the field entirely — a missing value reads
          // "unpriced", never "$0".
          const c = u.cost;
          if (c && c.total > 0) {
            turnCost = {
              input: c.input,
              output: c.output,
              cacheRead: c.cacheRead,
              cacheWrite: c.cacheWrite,
              total: c.total,
            };
          }
          if (this.currentAssistantEntry && turnUsage) {
            const entry = this.currentAssistantEntry;
            entry.usage = turnUsage;
            if (turnCost) entry.cost = turnCost;
            await this.fencedWrite(() =>
              this.session.providers.store.updateEntry(this.session.id, this.id, entry, this.fence),
            );
          }
          // Metrics: same snapshot the entry/span get (no-op without a
          // registered MeterProvider).
          recordTurn({
            model: turnModel,
            reason: stopReason === "aborted" ? "abort" : stopReason === "error" ? "error" : "end_turn",
            durationMs: this.turnStartedAt !== undefined ? Date.now() - this.turnStartedAt : undefined,
            usage: turnUsage,
            costUsd: turnCost?.total,
          });
          // A round that errored/aborted before message_end leaves a
          // dangling llm.generate span — close it with the turn's fate.
          if (this.llmSpan) {
            if (errorMessage) markSpanError(this.llmSpan, errorMessage);
            this.llmSpan.end();
            this.llmSpan = undefined;
          }
          // Same snapshot onto the live agent.turn span (distributed tracing).
          if (this.turnSpan) {
            this.turnSpan.setAttributes({
              "valet.turn.stop_reason": stopReason ?? "end_turn",
              "valet.turn.tool_calls": this.turnToolCallCount,
            });
            if (errorMessage) {
              this.turnSpan.setAttribute("valet.turn.error", attrTruncate(errorMessage, 300));
            }
            if (turnModel !== undefined) this.turnSpan.setAttribute("gen_ai.request.model", turnModel);
            if (turnUsage) {
              this.turnSpan.setAttributes({
                "gen_ai.usage.input_tokens": turnUsage.input,
                "gen_ai.usage.output_tokens": turnUsage.output,
                "valet.usage.cache_read_tokens": turnUsage.cacheRead,
                "valet.usage.cache_write_tokens": turnUsage.cacheWrite,
                "valet.usage.total_tokens": turnUsage.total,
              });
            }
            if (turnCost) this.turnSpan.setAttribute("valet.cost.total_usd", turnCost.total);
            if (stopReason === "error") {
              markSpanError(this.turnSpan, errorMessage ?? "turn ended with an error");
            }
          }
        }
        if (errorMessage) {
          // Same stdout mirror as `emitError`: the event is best-effort (a
          // dead WS drops it), and this is the path provider failures take
          // (bad key, exhausted credits, 4xx/5xx) — without a log line the
          // host process is silent about a turn that returned nothing.
          console.error(
            `[engine] agent error session=${this.session.id} thread=${this.id} ${stopReason ?? "agent_error"}: ${errorMessage}`,
          );
          await this.fencedEmit(
            {
              type: "error",
              threadId: this.id,
              code: stopReason ?? "agent_error",
              error: errorMessage,
              recoverable: stopReason !== "error",
            },
            { queueItemId: this.runningItem?.id },
          );
        }
        const reason: "end_turn" | "error" | "abort" =
          stopReason === "aborted"
            ? "abort"
            : stopReason === "error"
            ? "error"
            : "end_turn";
        await this.fencedEmit(
          {
            type: "turn_end",
            threadId: this.id,
            reason,
            ...(turnModel !== undefined ? { model: turnModel } : {}),
            ...(turnUsage !== undefined ? { usage: turnUsage } : {}),
            ...(turnCost !== undefined ? { cost: turnCost } : {}),
            ...(turnUsage !== undefined && this.turnStartedAt !== undefined
              ? { turnDurationMs: Date.now() - this.turnStartedAt }
              : {}),
          },
          { queueItemId: this.runningItem?.id },
        );
        this.lastEmittedStatus = "idle";
        await this.fencedEmit(
          { type: "status", threadId: this.id, status: "idle" },
          { queueItemId: this.runningItem?.id },
        );
        break;
      }
      default:
        break;
    }
  }

  /**
   * Publish the concrete model that now serves `queueItemId`. The boolean is
   * false when the fenced append discovers that a successor owns the item.
   */
  private publishActiveModelState(queueItemId: string, model: PiModel): Promise<boolean> {
    return this.enqueueModelStateTransition(async () => {
      if (this.staleFenceDetected) {
        this.committedModelState = null;
        return false;
      }
      const next: ActiveModelState = { queueItemId, model: concreteModelId(model) };
      if (
        this.committedModelState?.queueItemId === next.queueItemId &&
        this.committedModelState.model === next.model
      ) {
        return true;
      }

      const event: EngineEvent = {
        type: "model_state",
        threadId: this.id,
        queueItemId,
        model: next.model,
      };
      if (this.fence) {
        await this.fencedEmit(event, { queueItemId, throwOnAppendError: true });
      } else {
        await this.session.emit(event, { queueItemId, throwOnAppendError: true });
      }
      if (this.staleFenceDetected) {
        this.committedModelState = null;
        return false;
      }
      this.committedModelState = next;
      return true;
    });
  }

  /** Clear only the model state owned by `queueItemId`. */
  private clearActiveModelState(
    queueItemId: string,
    opts: { finalizeLocal?: boolean } = {},
  ): Promise<boolean> {
    return this.enqueueModelStateTransition(async () => {
      const clearsVisibleState = this.committedModelState?.queueItemId === queueItemId;
      const retriesPendingDelivery = this.pendingModelStateClearQueueItemId === queueItemId;
      if (!clearsVisibleState && !retriesPendingDelivery) {
        return !this.staleFenceDetected;
      }
      if (clearsVisibleState) {
        // Settlement cleanup owns the reconnect view immediately. Keep the
        // failed idle delivery separate so the outer cleanup can retry it.
        this.committedModelState = null;
        this.pendingModelStateClearQueueItemId = queueItemId;
      }
      if (this.staleFenceDetected) {
        this.pendingModelStateClearQueueItemId = null;
        return false;
      }

      const event: EngineEvent = {
        type: "model_state",
        threadId: this.id,
        queueItemId: null,
        model: null,
      };
      try {
        if (this.fence) {
          await this.fencedEmit(event, { queueItemId, throwOnAppendError: true });
        } else {
          await this.session.emit(event, { queueItemId, throwOnAppendError: true });
        }
      } catch (err) {
        this.emitError(
          "model_state_emit_failed",
          err instanceof Error ? err.message : String(err),
        );
        // The settlement path gets one retry from the outer claim/recovery
        // finally. The reconnect snapshot was already cleared before the
        // first attempt; final cleanup only retires the delivery marker.
        if (opts.finalizeLocal) this.pendingModelStateClearQueueItemId = null;
        return false;
      }
      this.pendingModelStateClearQueueItemId = null;
      return !this.staleFenceDetected;
    });
  }

  /** Run model-state transitions and snapshot reads in invocation order. */
  private enqueueModelStateTransition<T>(transition: () => Promise<T>): Promise<T> {
    const result = this.modelStateTransitionTail.then(transition);
    this.modelStateTransitionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Run a fenced store write. A StaleAttemptError means a successor now owns
   * the item: mark the turn stale (so settlement is skipped), abort the agent,
   * and swallow — never rethrow to the user (zombie self-fencing signal).
   */
  private async fencedWrite(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof StaleAttemptError) {
        this.staleFenceDetected = true;
        this.emitError("stale_fence", `turn superseded for item ${err.itemId}`);
        if (this.agent.state.isStreaming) this.agent.abort();
        return;
      }
      throw err;
    }
  }

  /**
   * Emit a live-execution event under the turn's write fence (decision 12).
   * `Session.emit` rethrows `StaleAttemptError` for a fenced append — this
   * wrapper is the site that actually absorbs it, mirroring `fencedWrite`:
   * mark the turn stale, abort the agent if still streaming, and swallow.
   * A rethrow here would otherwise escape as an unhandled rejection since
   * `handleAgentEvent` runs from a fire-and-forget `agent.subscribe`
   * callback with no caller to catch it.
   */
  private async fencedEmit(event: EngineEvent, opts: Omit<EmitOptions, "fence"> = {}): Promise<void> {
    if (this.staleFenceDetected) return;
    try {
      await this.session.emit(event, { ...opts, fence: this.fence });
    } catch (err) {
      if (err instanceof StaleAttemptError) {
        this.staleFenceDetected = true;
        this.emitError("stale_fence", `turn superseded for item ${err.itemId}`);
        if (this.agent.state.isStreaming) this.agent.abort();
        return;
      }
      throw err;
    }
  }

  private emitError(code: string, message: string): void {
    // Event delivery is best-effort (a dead WS drops it silently), so also
    // log to stderr — otherwise a failing turn (bad key, exhausted credits,
    // provider outage) leaves zero trace in the host process output.
    console.error(`[engine] thread error session=${this.session.id} thread=${this.id} ${code}: ${message}`);
    void this.session.emit({
      type: "error",
      threadId: this.id,
      code,
      error: message,
      recoverable: true,
    });
  }

  /**
   * Durable, resumable result observation (spec ~404, plan Task 6). Derives
   * the result from durable state — never from the `submission_settled`
   * event alone, since that emit is best-effort and can be lost. A settled
   * submission returns immediately from the store; an unsettled one
   * subscribes to the event as a wakeup and re-derives from the store once
   * woken (or once more, defensively, on timeout/abort).
   *
   * `outcome: "merged"` delegates: recurses on `mergedIntoItemId`, bounded to
   * `MAX_MERGE_DELEGATION_DEPTH` hops so a corrupt/cyclic linkage can never
   * spin forever.
   */
  async awaitResult(queueItemId: string, opts: AwaitResultOptions = {}): Promise<SubmissionResult> {
    return this.resolveResult(queueItemId, opts, 0);
  }

  private async resolveResult(
    itemId: string,
    opts: AwaitResultOptions,
    depth: number,
  ): Promise<SubmissionResult> {
    if (depth > MAX_MERGE_DELEGATION_DEPTH) {
      return {
        queueItemId: itemId,
        outcome: "failed",
        error: `merge delegation depth exceeded ${MAX_MERGE_DELEGATION_DEPTH} hops`,
      };
    }
    const store = this.session.providers.store;
    let item = await store.getQueueItem(this.session.id, itemId);
    if (!item) throw new NotFoundError("queue item", itemId);
    if (item.status !== "settled") {
      await this.waitForSettlement(itemId, opts);
      item = await store.getQueueItem(this.session.id, itemId);
      if (!item || item.status !== "settled") {
        throw new Error(`queue item ${itemId} did not settle after wait`);
      }
    }
    return this.buildResult(item, opts, depth);
  }

  private async buildResult(
    item: QueueItem,
    opts: AwaitResultOptions,
    depth: number,
  ): Promise<SubmissionResult> {
    const outcome = item.outcome ?? { outcome: "failed", error: "settled without a recorded outcome" };
    if (outcome.outcome === "merged") {
      if (!item.mergedIntoItemId) {
        return {
          queueItemId: item.id,
          outcome: "failed",
          error: "merged submission is missing mergedIntoItemId",
        };
      }
      return this.resolveResult(item.mergedIntoItemId, opts, depth + 1);
    }
    const entries = await this.session.providers.store.getEntries(this.session.id, item.threadId);
    const text =
      outcome.outcome === "superseded"
        ? resolvePartialSubmissionText(entries, item.id)
        : resolveSubmissionText(entries, item.id);
    const result: SubmissionResult = { queueItemId: item.id, outcome: outcome.outcome, text };
    if (outcome.error !== undefined) result.error = outcome.error;
    if (opts.resultSchema && outcome.outcome === "completed") {
      const extracted = extractStructuredOutput(text ?? "", opts.resultSchema);
      if (extracted.output !== undefined) result.output = extracted.output;
      if (extracted.error !== undefined) result.error = extracted.error;
    }
    return result;
  }

  /**
   * Resolves once `itemId` settles, rejects on timeout/abort. Never mutates
   * the submission — a timed-out or aborted wait leaves it running.
   *
   * The `submission_settled` event is a wakeup hint, not the source of
   * truth: some settlement paths (e.g. a collect-window constituent settled
   * via `settleUnclaimed` in `flushCollectWindow`) never publish it, and the
   * event emit itself is best-effort. A low-frequency durable poll is the
   * actual correctness mechanism; the event and the immediate post-subscribe
   * re-check just make the common case resolve promptly instead of waiting
   * out a poll tick.
   */
  private async waitForSettlement(itemId: string, opts: AwaitResultOptions): Promise<void> {
    const store = this.session.providers.store;
    await new Promise<void>((resolve, reject) => {
      let done = false;
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let poll: ReturnType<typeof setTimeout> | undefined;
      let checking = false;
      let recheck = false;
      let onAbort: (() => void) | undefined;

      const cleanup = () => {
        unsubscribe?.();
        if (timer !== undefined) clearTimeout(timer);
        if (poll !== undefined) clearTimeout(poll);
        if (onAbort && opts.signal) opts.signal.removeEventListener("abort", onAbort);
      };
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        cleanup();
        if (err) reject(err);
        else resolve();
      };
      const checkStore = () => {
        if (done) return;
        if (checking) {
          // An event during a read must get a fresh check after that read.
          recheck = true;
          return;
        }
        if (poll !== undefined) clearTimeout(poll);
        checking = true;
        void store.getQueueItem(this.session.id, itemId)
          .then((current) => {
            if (current?.status === "settled") finish();
          })
          // A transient read failure does not settle or abandon the item.
          // Retry through the bounded fallback, without an unhandled rejection.
          .catch(() => { recheck = false; })
          .finally(() => {
            checking = false;
            if (done) return;
            poll = setTimeout(checkStore, recheck ? 0 : 1_000);
            recheck = false;
            poll.unref?.();
          });
      };

      unsubscribe = this.session.providers.stream.subscribe(
        { sessionId: this.session.id, eventTypes: ["submission_settled"] },
        (busEvent) => {
          const event = busEvent.event;
          if (event.type === "submission_settled" && event.queueItemId === itemId) checkStore();
        },
      );

      // Race guard: the submission may have settled between the caller's
      // last read and this subscribe call.
      checkStore();

      // Durable fallback: not every settlement path emits the event (e.g.
      // collect-window constituents settle via settleUnclaimed with no
      // event), so a poll is the only way to guarantee this promise
      // eventually resolves against store truth.
      // checkStore schedules the next fallback after its read completes.
      // Slow reads cannot build an unbounded queue of pending database work.

      const timeoutMs = opts.timeoutMs;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => finish(new TimeoutError(itemId, timeoutMs)), timeoutMs);
        timer.unref?.();
      }

      if (opts.signal) {
        if (opts.signal.aborted) {
          finish(new Error(`awaitResult aborted waiting for submission ${itemId}`));
          return;
        }
        onAbort = () => finish(new Error(`awaitResult aborted waiting for submission ${itemId}`));
        opts.signal.addEventListener("abort", onAbort);
      }
    });
  }
}

function promptText(content: PromptContent): string {
  if (typeof content === "string") return content;
  if (isSignalContent(content)) return content.body;
  return content.text ?? "";
}

/** Stamped internal-sender identity carried through `QueueItem.metadata.signalStamp` (no dedicated QueueItem field). */
interface SignalStamp {
  senderSessionId: string;
  senderOwner: Principal;
  hopCount: number;
}

function isPrincipalLike(value: unknown): value is Principal {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    (rec.type === "user" || rec.type === "team" || rec.type === "org") && typeof rec.id === "string"
  );
}

function readSignalStamp(metadata: Record<string, unknown> | undefined): SignalStamp | undefined {
  const raw = metadata?.signalStamp;
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.senderSessionId !== "string") return undefined;
  if (typeof rec.hopCount !== "number") return undefined;
  if (!isPrincipalLike(rec.senderOwner)) return undefined;
  return { senderSessionId: rec.senderSessionId, hopCount: rec.hopCount, senderOwner: rec.senderOwner };
}

/**
 * Returns `metadata` with the `signalStamp` key removed, without mutating
 * the input. Used when persisting the user `MessageEntry`: the stamp has
 * already been lifted into `entry.signal` by `buildSignalMeta`, so leaving
 * it in `entry.metadata` too would duplicate the sender stamp into the
 * persisted entry (and onto the wire).
 */
function stripSignalStamp(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || !("signalStamp" in metadata)) return metadata;
  const { signalStamp: _signalStamp, ...rest } = metadata;
  return rest;
}

/** Builds the `MessageEntry.signal` snapshot for a signal `QueueItem` at persistence time (runItem). */
function buildSignalMeta(
  content: SignalContent,
  metadata: Record<string, unknown> | undefined,
): NonNullable<MessageEntry["signal"]> {
  const stamp = readSignalStamp(metadata);
  return {
    signalType: content.signalType,
    attributes: content.attributes,
    tagName: content.tagName ?? "signal",
    senderSessionId: stamp?.senderSessionId,
    senderOwner: stamp?.senderOwner,
    hopCount: stamp?.hopCount,
    origin: content.origin,
  };
}

/** Map a submission's live status onto the narrower PromptReceipt status. */
function receiptStatus(status: QueueItem["status"]): PromptReceipt["status"] {
  if (status === "running") return "running";
  if (status === "blocked_on_decision_gate") return "blocked_on_decision_gate";
  return "queued";
}

function textOf(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  const parts = (message.content ?? []).filter((b) => b.type === "text") as Array<{
    type: "text";
    text: string;
  }>;
  return parts.map((p) => p.text).join("");
}

function renderToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const r = result as { content?: Array<{ type: string; text?: string }> };
  if (!r.content) return JSON.stringify(result);
  return r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

interface RoleOverlay {
  restore: boolean;
  model?: PiModel;
}

/**
 * Resolve a model id (or `provider/model`) to a pi-ai Model instance.
 *
 * - `provider/model` form (e.g. "anthropic/claude-haiku-4-5") — used as-is.
 * - Bare ids — tried under a small set of common providers (anthropic
 *   first since the engine is anthropic-default).
 *
 * Returns undefined when nothing matches. Callers that need to fail hard
 * (e.g. user-driven setModel) should throw on undefined.
 */
export function resolveModelId(spec: string): PiModel | undefined {
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const provider = spec.slice(0, slash);
    const modelId = spec.slice(slash + 1);
    return bundledModel(provider, modelId);
  }
  const tryProviders = ["anthropic", "openai", "google"] as const;
  for (const p of tryProviders) {
    const m = bundledModel(p, spec);
    if (m) return m;
  }
  return undefined;
}

// Back-compat alias used by applyRoleForTurn in this file.
const resolveRoleModel = resolveModelId;

/** Extract readable text from a persisted tool_call `result` (any shape). */
function toolResultText(result: unknown): string {
  if (result && typeof result === "object") {
    const r = result as { text?: unknown; content?: Array<{ type: string; text?: string }> };
    if (typeof r.text === "string") return r.text;
    if (Array.isArray(r.content)) {
      return r.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
    }
    return JSON.stringify(result);
  }
  return String(result ?? "");
}

/** Retain selected tool evidence on reload without reviving malformed content. */
function toolResultImages(result: unknown): ImageContent[] {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return [];
  const images: ImageContent[] = [];
  for (const block of result.content) {
    if (!block || typeof block !== "object" || block.type !== "image") continue;
    if (typeof block.data !== "string" || !block.data || typeof block.mimeType !== "string") continue;
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(block.mimeType)) continue;
    images.push({ type: "image", data: block.data, mimeType: block.mimeType });
  }
  return images;
}

function findMostRecentCompaction(
  entries: readonly SessionEntry[],
): CompactionEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "compaction") return e;
  }
  return undefined;
}

/**
 * Convert persisted user-message attachments into the pi-ai `ImageContent`
 * blocks the model consumes. Single source of truth for base64 / data-URL
 * decoding; used by BOTH `entriesToAgentMessages` (historical entries on
 * rehydrate / resume / compaction) AND `Thread.runAgent` (the CURRENT turn's
 * user message, so its image lands in `agent.state.messages` alongside the
 * text and survives into every subsequent turn's LLM call).
 *
 * Attachments without usable `data` or `url` are skipped silently; a URL
 * that is not a base64 `data:` URL is dropped with a warning (the model
 * cannot fetch remote URLs from here).
 */
/**
 * Build the content blocks for a user message from its text and persisted
 * attachments. Single source of truth for BOTH `entriesToAgentMessages`
 * (historical entries on rehydrate / resume / compaction) AND
 * `Thread.runAgent` (the current turn), so hot and cold transcripts agree.
 *
 * File attachments (sandbox uploads) render as a system-authored note
 * prepended to the text — the model reads paths, not bytes. Image
 * attachments render as image content blocks.
 *
 * `sender` (when set) renders as a `[from: …]` line above the text so the
 * model can tell which person sent the message. Callers pass it only on
 * shared (team/org-owned) sessions — on a personal session every prompt has
 * the same author and the line would be noise.
 */
export function userContentBlocks(
  text: string,
  attachments: MessageEntry["attachments"] | undefined,
  sender?: PromptAuthor,
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const files = (attachments ?? []).filter(
    (a): a is Extract<NonNullable<MessageEntry["attachments"]>[number], { type: "file" }> =>
      a.type === "file",
  );
  const note = formatFileAttachmentsNote(files);
  const senderLine = formatSenderLine(sender);
  const prefixed = [senderLine, note, text].filter((s) => s !== undefined && s !== "").join("\n\n");
  return [
    { type: "text" as const, text: prefixed },
    ...attachmentsToImageBlocks(attachments),
  ];
}


export function attachmentsToImageBlocks(
  attachments: MessageEntry["attachments"] | undefined,
): Array<{ type: "image"; data: string; mimeType: string }> {
  if (!attachments || attachments.length === 0) return [];
  const blocks: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const att of attachments) {
    if (att.type !== "image" || !att.mimeType.startsWith("image/")) continue;
    let imageData: string;
    // att.data is set when a tool returns binary attachment data (e.g. screenshot utilities)
    if (att.data instanceof Uint8Array) {
      imageData = Buffer.from(att.data).toString("base64");
    } else if (att.url) {
      // Extract base64 payload from data: URL
      const match = att.url.match(/^data:([^;]+);base64,([A-Za-z0-9+/]+=*)$/);
      if (!match) {
        // Invalid data: URL format — skip this attachment and log a warning
        console.warn(`[engine] skipping attachment with invalid data: URL format: ${att.url}`);
        continue;
      }
      imageData = match[2];
    } else {
      // Skip attachments without data
      continue;
    }
    blocks.push({ type: "image", data: imageData, mimeType: att.mimeType });
  }
  return blocks;
}

function isSkillInvocationFact(value: unknown): value is SkillInvocationFact {
  if (!value || typeof value !== "object") return false;
  const fact = value as Record<string, unknown>;
  return (
    typeof fact.id === "string" &&
    typeof fact.skillKey === "string" &&
    typeof fact.skillName === "string" &&
    typeof fact.estimatedBodyTokens === "number"
  );
}

/** Return skill bodies that are still present in the active transcript. */
export function skillInvocationsInContext(
  entries: readonly SessionEntry[],
  activeLeafEntryId?: string,
): SkillInvocationFact[] {
  const activeEntries = walkTranscriptDag(entries, activeLeafEntryId);
  let covered = new Set<string>();
  for (let i = activeEntries.length - 1; i >= 0; i--) {
    const entry = activeEntries[i];
    if (entry.type === "compaction") {
      covered = new Set(entry.coveredEntryIds);
      break;
    }
  }
  const facts: SkillInvocationFact[] = [];
  for (const entry of activeEntries) {
    if (entry.type !== "message" || covered.has(entry.id)) continue;
    const promptFact = entry.metadata?.skillInvocation;
    if (isSkillInvocationFact(promptFact)) facts.push(promptFact);
    for (const part of entry.parts ?? []) {
      if (part.type === "tool_call" && !part.elided && part.skillInvocation) {
        facts.push(part.skillInvocation);
      }
    }
  }
  return facts;
}

interface ReplyMetadata {
  messageId: string;
  excerpt: string;
}

function replyMetadata(metadata: Record<string, unknown> | undefined): ReplyMetadata | undefined {
  const value = metadata?.replyTo;
  if (!value || typeof value !== "object") return undefined;
  const ref = value as Record<string, unknown>;
  if (typeof ref.messageId !== "string" || typeof ref.excerpt !== "string") return undefined;
  return { messageId: ref.messageId, excerpt: ref.excerpt };
}

function escapeReplyContext(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Adds explicit topical context without changing transcript position or branching. */
export function renderReplyContext(
  text: string,
  metadata: Record<string, unknown> | undefined,
): string {
  const ref = replyMetadata(metadata);
  if (!ref) return text;
  return [
    "<reply-context>",
    "The user is replying to assistant message " + escapeReplyContext(ref.messageId) + ".",
    "Immutable excerpt: " + escapeReplyContext(ref.excerpt),
    "</reply-context>",
    "",
    text,
  ].join("\n");
}

export function entriesToAgentMessages(
  entries: readonly SessionEntry[],
  modelHint: { api: string; provider: string; id: string },
  opts?: {
    /**
     * Render each user entry's `author` as a `[from: …]` line (shared
     * team/org sessions, where prompts come from different people). Signal
     * entries are exempt — their envelope already names the sender.
     */
    attributeAuthors?: boolean;
    /**
     * This thread's key. When set and a compaction is active, the
     * <previous-context> wrapper tells the model the covered entries are
     * still readable via thread_read (the DAG keeps everything; only the
     * live context drops it). Claude Code's transcript-path escape hatch,
     * adapted (TKAI-306).
     */
    threadKey?: string;
    /** Durable leaf of the active transcript branch. */
    activeLeafEntryId?: string;
  },
): AgentMessage[] {
  const activeEntries = walkTranscriptDag(entries, opts?.activeLeafEntryId);
  // 1. Find the most recent CompactionEntry. Everything in its coveredEntryIds is dropped.
  let activeCompaction: { summary: string; covered: Set<string> } | undefined;
  for (let i = activeEntries.length - 1; i >= 0; i--) {
    const e = activeEntries[i];
    if (e.type === "compaction") {
      activeCompaction = { summary: e.summary, covered: new Set(e.coveredEntryIds) };
      break;
    }
  }

  const out: AgentMessage[] = [];
  if (activeCompaction) {
    // thread_read returns the newest `limit` entries (max 200), so this can
    // reach recent covered turns but not the oldest ones on a long thread —
    // say "recent" so the model does not overtrust it.
    const escapeHatch = opts?.threadKey
      ? `\n\nIf you need specific details from recent turns covered by this summary (exact code, error text, tool output), read them with the thread_read tool: key "${opts.threadKey}", limit 200.`
      : "";
    out.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `<previous-context>\n${activeCompaction.summary}\n</previous-context>${escapeHatch}`,
        },
      ],
      timestamp: 0,
    });
  }

  for (const e of activeEntries) {
    if (e.type !== "message") continue;
    if (activeCompaction?.covered.has(e.id)) continue;

    if (e.role === "user") {
      // A spilled entry keeps the full paste in `content` but must reach the
      // LLM as the pointer, so a rehydrated transcript agrees with the hot
      // path and does not re-overflow on the oversized text. Signals never
      // spill, so the two branches never collide.
      const spillPath = e.metadata?.[SPILLED_INPUT_PATH_KEY];
      const text =
        typeof spillPath === "string"
          ? renderReplyContext(
              buildSpilledInputMarker({
                path: spillPath,
                tokens: estimateTokens(e.content),
                chars: e.content.length,
              }),
              e.metadata,
            )
          : e.signal
          ? renderSignalEnvelope(e.signal, e.content)
          : renderReplyContext(e.content, e.metadata);
      const sender = opts?.attributeAuthors && !e.signal ? e.author : undefined;
      const contentBlocks = userContentBlocks(text, e.attachments, sender);
      out.push({
        role: "user",
        content: contentBlocks,
        timestamp: e.createdAt,
      });
      continue;
    }
    if (e.role === "assistant") {
      const blocks: Array<TextContent | ThinkingContent | ToolCall> = [];
      const parts = e.parts ?? [];
      const hadStructuredParts = parts.length > 0;
      for (const p of parts) {
        if (p.type === "text") blocks.push({ type: "text", text: p.text });
        else if (p.type === "thinking") blocks.push({ type: "thinking", thinking: p.text });
        else if (p.type === "tool_call") {
          blocks.push({
            type: "toolCall",
            id: p.callId,
            name: p.toolName,
            arguments: (p.args as JsonObject) ?? {},
          });
        }
      }
      if (!hadStructuredParts && e.content) {
        blocks.push({ type: "text", text: e.content });
      }
      out.push({
        role: "assistant",
        content: blocks,
        api: modelHint.api,
        provider: modelHint.provider,
        model: e.model ?? modelHint.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: e.createdAt,
      });
      // Answer every resolved tool call from persisted history — providers
      // reject a context whose toolCall lacks a matching toolResult, and a
      // multi-round turn has tool calls in EARLIER assistant messages too.
      // This function is the single owner of toolResult emission: the resume
      // path repairs dangling parts to `error` BEFORE rehydrating, so the
      // crash point is answered here with its honest interrupted error (never
      // a fabricated success, never re-executed). Parts still `running` (a
      // suspended gate's tool) stay unanswered — `replayBlocked` pushes their
      // result after re-running the tool, so no callId is answered twice.
      for (const p of parts) {
        if (p.type !== "tool_call") continue;
        if (p.status !== "completed" && p.status !== "error") continue;
        const isError = p.status === "error";
        out.push({
          role: "toolResult",
          toolCallId: p.callId,
          toolName: p.toolName,
          content: [
            {
              type: "text",
              // Elided parts keep their stored result for the summarizer and
              // the UI; the LIVE context is where the elision applies.
              text: isError
                ? p.error ?? "tool call failed"
                : p.elided
                  ? "[output elided to save context]"
                  : toolResultText(p.result),
            },
            ...(!isError && !p.elided ? toolResultImages(p.result) : []),
          ],
          isError,
          timestamp: e.createdAt,
        });
      }
    }
  }
  return out;
}
