import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { getModel, isContextOverflow } from "@mariozechner/pi-ai";
import type { Api, Message, Model, TextContent, ThinkingContent, ToolCall } from "@mariozechner/pi-ai";

type PiModel = Model<Api>;
import type { Session } from "./session.js";
import { toAgentTool } from "./tool-bridge.js";
import { fromRequest, GateManager, shouldShortCircuit } from "./decision-gate.js";
import { renderTemplate } from "./roles-skills/index.js";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import {
  applyPrune,
  estimateTokens,
  estimateTotalTokens,
  extractFileContext,
  planPrune,
  selectCutPoint,
  summarize,
  usableTokens,
  type PruneResult,
  type SummarizeResult,
} from "./compaction.js";
import type {
  CompactionEntry,
  DecisionGate,
  DecisionGateRequest,
  DecisionResolution,
  DecisionWithdrawReason,
  EngineEvent,
  MessagePart,
  MessageEntry,
  MessageQuery,
  PromptAuthor,
  PromptContent,
  PromptOptions,
  PromptReceipt,
  QueueItem,
  QueueMode,
  QueueState,
  QueueStatus,
  SessionEntry,
  SkillInvokeOptions,
  SuspendedTurnState,
  ThreadData,
  ToolContext,
  ToolDef,
} from "./types.js";

interface PendingResolver {
  resolve: () => void;
  reject: (err: unknown) => void;
}

const DEFAULT_COLLECT_WINDOW_MS = 5000;
const AUTO_CONTINUE_PROMPT =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";

let nextId = 1;
function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
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
  private status: QueueStatus = "idle";
  private pending: QueueItem[] = [];
  private collectBuffer: QueueItem[] = [];
  private collectTimer: ReturnType<typeof setTimeout> | null = null;
  private blockedGateId: string | undefined;
  private activeItem: QueueItem | null = null;
  private activeStartedResolver: PendingResolver | null = null;
  private gates = new GateManager();
  private mode: QueueMode;
  private aborted = false;
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
    | { gateId: string; resolution?: DecisionResolution }
    | undefined;
  /** Token usage from the most recent assistant message, captured at turn_end. */
  private lastAssistantUsage:
    | { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
    | undefined;
  /** True while a reactive (overflow) compaction is rerunning the failed turn. */
  private overflowRetryInProgress = false;
  /**
   * Set after compactThread runs; cleared by the next runItem before
   * checking shouldCompactProactive. Prevents recursive compaction loops
   * where each compaction's auto-continue immediately re-triggers
   * compaction (e.g. when the summary itself plus the system prompt
   * still exceeds usable on a small-context model).
   */
  private skipNextProactiveCheck = false;

  constructor(session: Session, data: ThreadData) {
    this.session = session;
    this.id = data.id;
    this.key = data.key;
    this.mode = data.queueMode;
    this.agent = this.buildAgent();
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
      void this.session.emit({
        type: "decision_gate_resolved",
        threadId: this.id,
        gateId,
        resolution,
      });
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
    const resolved: DecisionGate = {
      ...existing,
      status: "resolved",
      updatedAt: Date.now(),
    };
    await store.saveDecisionGate(this.session.id, this.id, resolved);
    await store.updateDecisionGateEntry(this.session.id, this.id, gateId, {
      gate: resolved,
      resolution,
      resolvedAt: new Date(resolution.resolvedAt).toISOString(),
    });
  }

  withdrawDecision(gateId: string, reason: DecisionWithdrawReason): boolean {
    const ok = this.gates.withdraw(gateId, reason);
    if (ok) {
      void this.session.emit({
        type: "decision_gate_withdrawn",
        threadId: this.id,
        gateId,
        reason,
      });
    }
    return ok;
  }

  async submitPrompt(content: PromptContent, opts: PromptOptions): Promise<PromptReceipt> {
    const item: QueueItem = {
      id: uid("q"),
      threadId: this.id,
      content,
      author: opts.author,
      channel: opts.channel,
      replyTarget: opts.replyTarget,
      model: opts.model,
      role: opts.role,
      metadata: opts.metadata,
      createdAt: Date.now(),
    };
    const mode = opts.queueMode ?? this.mode;

    if (mode === "steer") {
      // Withdraw any pending gate, abort the active run, clear the queue.
      await this.steer(item);
      return {
        sessionId: this.session.id,
        threadId: this.id,
        queueItemId: item.id,
        status: this.status === "running" ? "running" : "queued",
      };
    }

    if (mode === "collect") {
      this.collectBuffer.push(item);
      if (this.collectTimer === null) {
        const windowMs = this.session.options.collectWindowMs ?? DEFAULT_COLLECT_WINDOW_MS;
        this.collectTimer = setTimeout(() => {
          this.flushCollectBuffer().catch((e) =>
            this.emitError("collect_flush_failed", String(e)),
          );
        }, windowMs);
        const t = this.collectTimer as { unref?: () => void };
        if (typeof t.unref === "function") t.unref();
      }
      void this.persistQueueState();
      return {
        sessionId: this.session.id,
        threadId: this.id,
        queueItemId: item.id,
        status: "queued",
      };
    }

    // default: followup
    this.pending.push(item);
    void this.persistQueueState();
    void this.tickQueue();
    return {
      sessionId: this.session.id,
      threadId: this.id,
      queueItemId: item.id,
      status: this.status === "idle" ? "running" : "queued",
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
    });
  }

  async abort(): Promise<void> {
    this.aborted = true;
    // Withdraw any pending gates owned by this thread.
    for (const g of this.pendingDecisionGates()) {
      this.withdrawDecision(g.id, "abort");
    }
    this.pending = [];
    this.collectBuffer = [];
    if (this.collectTimer) {
      clearTimeout(this.collectTimer);
      this.collectTimer = null;
    }
    if (this.agent.state.isStreaming) {
      this.agent.abort();
      await this.agent.waitForIdle();
    }
    this.activeItem = null;
    this.setStatus("idle");
    void this.persistQueueState();
  }

  async pause(): Promise<void> {
    this.setStatus("paused");
    void this.persistQueueState();
  }

  async resume(): Promise<void> {
    if (this.status === "paused") {
      this.setStatus("idle");
      void this.persistQueueState();
      void this.tickQueue();
    }
  }

  /**
   * Used by Engine.restoreSession to seed replay state before re-running a
   * blocked tool. When the tool calls requestDecision with a matching
   * resumeKey, the engine returns the stored resolution immediately.
   */
  setReplayContext(
    ctx: { gateId: string; resolution?: DecisionResolution } | undefined,
  ): void {
    this.suspendedDecisionForReplay = ctx;
  }

  /**
   * Re-run a suspended tool with seeded suspendedDecision, push its result
   * onto the agent transcript, then continue the agent loop. Called by
   * Session.resumeBlockedThreadIfReady when the gate has been resolved.
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
    this.setReplayContext({ gateId: suspended.gateId, resolution });
    // The deterministic gate ID is derived from
    // (sessionId, threadId, queueItemId, resumeKey). During replay, the
    // tool's requestDecision call recomputes this from the active queue
    // item — so we must mirror the original queueItemId here, otherwise
    // the short-circuit won't match and the tool will try to open a
    // brand-new gate.
    const priorActive = this.activeItem;
    this.activeItem = {
      id: suspended.queueItemId,
      threadId: this.id,
      content: "",
      createdAt: suspended.createdAt,
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
      this.activeItem = priorActive;
      this.emitError(
        "replay_tool_failed",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    this.activeItem = priorActive;
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
    await this.session.providers.store.clearSuspendedTurn(this.session.id, this.id);
    this.setStatus("running");
    try {
      await this.agent.continue();
      await this.agent.waitForIdle();
    } catch (err) {
      this.emitError(
        "replay_continue_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (this.readStatus() === "running") this.setStatus("idle");
  }

  /**
   * Re-arm the GateManager for a still-pending gate after restart, so a
   * future resolveDecision triggers replay.
   */
  armPendingGateForRestart(gate: DecisionGate, suspended: SuspendedTurnState): void {
    this.blockedGateId = gate.id;
    this.setStatus("blocked_on_decision_gate");
    this.gates
      .register(gate, () => {
        // expiry handler: replay never runs for an expired gate
      })
      .then((resolution) => {
        void this.replayBlocked({ suspended, resolution });
      })
      .catch((err) => {
        this.emitError(
          "replay_after_pending_gate_failed",
          err instanceof Error ? err.message : String(err),
        );
      });
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
    this.agent.state.messages = entriesToAgentMessages(entries, this.session.options.model);
  }

  setMode(mode: QueueMode): void {
    this.mode = mode;
  }

  toThreadData(): ThreadData {
    return {
      id: this.id,
      sessionId: this.session.id,
      key: this.key,
      status: this.status === "paused" ? "paused" : "active",
      activeLeafEntryId: undefined,
      queueMode: this.mode,
      model: undefined,
      summary: undefined,
      createdAt: 0,
      updatedAt: Date.now(),
    };
  }

  async readEntries(opts?: MessageQuery): Promise<SessionEntry[]> {
    return this.session.providers.store.getEntries(this.session.id, this.id, opts);
  }

  // ── internals ───────────────────────────────────────────────────

  private async steer(item: QueueItem): Promise<void> {
    // Withdraw any pending gate from the superseded turn first.
    const pendingGate = this.blockedGateId;
    if (pendingGate) {
      this.withdrawDecision(pendingGate, "steer");
      this.blockedGateId = undefined;
    }
    if (this.agent.state.isStreaming) {
      this.agent.abort();
      await this.agent.waitForIdle();
    }
    this.pending = [];
    this.collectBuffer = [];
    if (this.collectTimer) {
      clearTimeout(this.collectTimer);
      this.collectTimer = null;
    }
    this.pending.push(item);
    void this.persistQueueState();
    void this.tickQueue();
  }

  private async flushCollectBuffer(): Promise<void> {
    if (this.collectTimer) {
      clearTimeout(this.collectTimer);
      this.collectTimer = null;
    }
    if (this.collectBuffer.length === 0) return;
    const items = this.collectBuffer;
    this.collectBuffer = [];

    const merged: QueueItem = {
      id: uid("q-merged"),
      threadId: this.id,
      content: items.map((it, i) => `[${i + 1}] ${promptText(it.content)}`).join("\n\n"),
      author: items[0].author,
      channel: items[0].channel,
      replyTarget: items[0].replyTarget,
      model: items[0].model,
      metadata: { mergedFrom: items.map((i) => i.id) },
      createdAt: Date.now(),
    };
    this.pending.push(merged);
    void this.persistQueueState();
    void this.tickQueue();
  }

  private async tickQueue(): Promise<void> {
    if (this.status === "paused") return;
    if (this.status === "running" || this.status === "blocked_on_decision_gate") return;
    const next = this.pending.shift();
    if (!next) {
      this.setStatus("idle");
      return;
    }
    this.activeItem = next;
    this.setStatus("running");
    void this.persistQueueState();
    try {
      await this.runItem(next);
    } catch (err) {
      this.emitError("run_failed", String(err));
    }
    this.activeItem = null;
    if (this.readStatus() === "running") this.setStatus("idle");
    void this.persistQueueState();
    if (this.pending.length > 0 && this.readStatus() !== "paused") void this.tickQueue();
  }

  /**
   * Reads `this.status` through a method call to defeat TS's control-flow
   * narrowing across awaits — `setStatus("running")` makes TS think the
   * property type is the narrow literal forever, even after async work that
   * could call back into setStatus with other values.
   */
  private readStatus(): QueueStatus {
    return this.status;
  }

  private async runItem(item: QueueItem): Promise<void> {
    const text = promptText(item.content);
    this.aborted = false;
    this.currentAssistantMessageId = undefined;
    this.currentAssistantParts = [];
    this.currentToolCalls.clear();

    // Persist user message entry. QueueItem.metadata flows through onto the
    // entry so synthetic flags like compaction_continue survive into the DAG
    // for client UIs and for later restoration.
    const userEntry: MessageEntry = {
      id: uid("e"),
      sessionId: this.session.id,
      threadId: this.id,
      parentId: null,
      type: "message",
      role: "user",
      content: text,
      author: item.author,
      channel: item.channel,
      metadata: item.metadata,
      createdAt: Date.now(),
    };
    await this.session.providers.store.appendEntries(this.session.id, this.id, [userEntry]);

    // Build the AgentTool list with closures over this turn's ToolContext.
    this.agent.state.tools = this.buildTools();

    // Apply role overlay (system-prompt overlay + optional model override) for
    // this one turn. Restored unconditionally in finally.
    const roleOverlay = this.applyRoleForTurn(item);
    try {
      try {
        await this.runAgent(text);
      } catch (err) {
        this.emitError("agent_failed", err instanceof Error ? err.message : String(err));
      }

      // Proactive compaction: if this turn pushed us past usable, run a
      // compaction pass before yielding back to the queue. Reactive
      // compaction (overflow retry) is handled inline in runAgent.
      if (this.shouldCompactProactive()) {
        try {
          await this.compactThread({ mode: "proactive" });
        } catch (err) {
          this.emitError(
            "compaction_failed",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } finally {
      this.restoreRoleAfterTurn(roleOverlay);
    }
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
    const baseSystemPrompt = this.agent.state.systemPrompt;
    const overlaid = baseSystemPrompt
      ? `${baseSystemPrompt}\n\n${role.content}`
      : role.content;
    this.agent.state.systemPrompt = overlaid;

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
      systemPrompt: baseSystemPrompt,
      model: priorModel,
    };
  }

  private restoreRoleAfterTurn(overlay: RoleOverlay): void {
    if (!overlay.restore) return;
    if (overlay.systemPrompt !== undefined) {
      this.agent.state.systemPrompt = overlay.systemPrompt;
    }
    if (overlay.model !== undefined) {
      this.agent.state.model = overlay.model;
    }
  }

  /** Run one prompt cycle. On context-overflow error, compact and retry once. */
  private async runAgent(text: string): Promise<void> {
    await this.agent.prompt({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });
    await this.agent.waitForIdle();

    const last = this.agent.state.messages[this.agent.state.messages.length - 1];
    if (
      !this.overflowRetryInProgress &&
      last &&
      last.role === "assistant" &&
      last.stopReason === "error" &&
      isContextOverflow(last, this.session.options.model.contextWindow)
    ) {
      this.overflowRetryInProgress = true;
      try {
        await this.compactThread({ mode: "reactive" });
        // Drop the failed assistant message from the agent transcript and retry.
        this.agent.state.messages = this.agent.state.messages.slice(0, -1);
        await this.agent.prompt({
          role: "user",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        });
        await this.agent.waitForIdle();
      } finally {
        this.overflowRetryInProgress = false;
      }
    }
  }

  private shouldCompactProactive(): boolean {
    if (this.skipNextProactiveCheck) {
      this.skipNextProactiveCheck = false;
      return false;
    }
    const cfg = this.session.options.compaction;
    if (cfg?.enabled === false) return false;
    const usage = this.lastAssistantUsage;
    if (!usage) return false;
    const usable = usableTokens(this.session.options.model, cfg);
    if (usable === 0) return false;
    return usage.total >= usable;
  }

  /**
   * Run a compaction pass: prune cheap stale tool outputs, then if the
   * result still doesn't fit, summarize older messages into a
   * CompactionEntry. Persist DAG updates and rewrite agent.state.messages
   * so the next turn sees a smaller context.
   */
  async compactThread(opts: { mode: "proactive" | "reactive" }): Promise<void> {
    const cfg = this.session.options.compaction;
    if (cfg?.enabled === false) return;
    const session = this.session;
    const store = session.providers.store;
    const model = cfg?.summarizerModel ?? session.options.model;

    // Load full DAG for the thread.
    const entries = await store.getEntries(session.id, this.id);

    // Step 1: pruning pass (cheap, no LLM).
    const protectedTools = new Set<string>();
    for (const t of [...session.builtinTools, ...(session.options.tools ?? [])]) {
      if (t.protectedFromPruning) protectedTools.add(t.name);
    }
    const prunePlan = planPrune({ entries, cfg, protectedTools });
    if (prunePlan.willCommit) {
      const mutable = entries.map((e) => structuredClone(e)) as SessionEntry[];
      applyPrune(mutable, prunePlan);
      // Persist each elided entry back to the store via updateEntry.
      for (const entry of mutable) {
        if (!prunePlan.toElide.has(entry.id)) continue;
        await store.updateEntry(session.id, this.id, entry);
      }
      // Apply to the live agent transcript:
      this.applyElisionsToAgentMessages(prunePlan);
    }

    // Step 2: cut-point selection.
    const cut = selectCutPoint({ entries, model: session.options.model, cfg });
    if (cut.cutIndex === 0 || cut.cutIndex === entries.length) {
      // Nothing to compact: either the tail already fits everything, or
      // there's no tail to preserve. The pruning pass above may have been
      // sufficient on its own.
      return;
    }

    const head = entries.slice(0, cut.cutIndex);
    if (head.length === 0) return;

    // Step 3: summarize.
    await session.emit({ type: "compaction_start", threadId: this.id });
    let summaryResult: SummarizeResult;
    try {
      const previousSummary = findMostRecentCompaction(entries)?.summary;
      summaryResult = await summarize({
        headEntries: head,
        model,
        toolOutputMaxChars: cfg?.toolOutputMaxChars,
        previousSummary,
      });
    } catch (err) {
      await session.emit({ type: "compaction_end", threadId: this.id });
      throw err;
    }

    // Step 4: persist CompactionEntry.
    const compactionEntry: CompactionEntry = {
      id: uid("c"),
      sessionId: session.id,
      threadId: this.id,
      parentId: head[head.length - 1].id,
      type: "compaction",
      summary: summaryResult.summary,
      coveredEntryIds: head.map((e) => e.id),
      tokenCountBefore: estimateTotalTokens(head),
      tokenCountAfter: estimateTokens(summaryResult.summary),
      fileContext: extractFileContext(head),
      createdAt: Date.now(),
    };
    await store.appendEntries(session.id, this.id, [compactionEntry]);

    // Step 5: rewrite agent.state.messages. The simplest and most
    // correct path is to rebuild from the now-augmented DAG.
    const updatedEntries = await store.getEntries(session.id, this.id);
    this.agent.state.messages = entriesToAgentMessages(updatedEntries, {
      api: session.options.model.api,
      provider: session.options.model.provider,
      id: session.options.model.id,
    });

    await session.emit({ type: "compaction_end", threadId: this.id });

    // Step 6: auto-continue (proactive only). Inject a synthetic user
    // message tagged with metadata.compaction_continue so client UIs can
    // hide it. Pushed onto the thread's queue so the agent picks it up on
    // the next tickQueue cycle (which runs after runItem returns).
    if (opts.mode === "proactive" && cfg?.autoContinue !== false) {
      const followUp: QueueItem = {
        id: uid("q"),
        threadId: this.id,
        content: AUTO_CONTINUE_PROMPT,
        metadata: { compaction_continue: true, synthetic: true },
        createdAt: Date.now(),
      };
      this.pending.unshift(followUp);
      void this.persistQueueState();
    }

    // Cool-down: skip the next proactive check so the auto-continue turn
    // doesn't immediately re-trigger compaction on a small-context model.
    this.skipNextProactiveCheck = true;
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

  private buildAgent(): Agent {
    const agent = new Agent({
      initialState: {
        model: this.session.options.model,
        systemPrompt: this.session.options.systemPrompt ?? "",
      },
      // Filter out custom AgentMessage types (decision_gate, compaction, etc.)
      // before the LLM sees them. They live in the engine DAG, not in LLM context.
      convertToLlm: (messages: AgentMessage[]): Message[] => {
        return messages.filter(
          (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
        ) as Message[];
      },
    });
    agent.subscribe((event, _signal) => this.handleAgentEvent(event));
    return agent;
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
    return {
      userId: session.options.userId,
      orgId: session.options.orgId,
      sessionId: session.id,
      threadId: this.id,
      sessionPurpose: session.options.purpose,
      cwd: session.options.workspace,
      credentials: session.credentialProvider(),
      sandbox: session.sandbox,
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
          queueItemId: this.activeItem?.id ?? "",
          resumeKey: req.resumeKey,
        };
        // Restart-safe replay: if running with a suspendedDecision and the
        // gate ID matches, return the stored resolution without re-persisting.
        const sc = shouldShortCircuit({
          ctx: gateCtx,
          suspendedDecision: this.suspendedDecisionForReplay,
        });
        if (sc.match) {
          this.suspendedDecisionForReplay = undefined; // one-shot
          return sc.resolution;
        }
        const gate = fromRequest(req, gateCtx);
        await session.providers.store.saveDecisionGate(session.id, this.id, gate);
        const gateEntry: SessionEntry = {
          id: uid("e"),
          sessionId: session.id,
          threadId: this.id,
          parentId: null,
          type: "decision_gate",
          gate,
          createdAt: Date.now(),
        };
        await session.providers.store.appendEntries(session.id, this.id, [gateEntry]);

        // checkpoint the suspended turn — use real toolName + toolArgs so
        // restoreSession can replay this exact tool call.
        await session.providers.store.saveSuspendedTurn(session.id, this.id, {
          sessionId: session.id,
          threadId: this.id,
          queueItemId: this.activeItem?.id ?? "",
          gateId: gate.id,
          model: session.options.model.id,
          toolCallId,
          toolName,
          toolArgs,
          resumeKey: req.resumeKey ?? gate.id,
          attempt: 1,
          createdAt: Date.now(),
        });

        this.blockedGateId = gate.id;
        this.setStatus("blocked_on_decision_gate");
        await session.emit({
          type: "status",
          threadId: this.id,
          status: "blocked_on_decision_gate",
        });
        await session.emit({ type: "decision_gate", threadId: this.id, gate });

        try {
          const resolution = await this.gates.register(gate, async (gateId) => {
            await session.providers.store.updateDecisionGateEntry(
              session.id,
              this.id,
              gateId,
              { resolvedAt: new Date().toISOString(), gate: { ...gate, status: "expired" } },
            );
            await session.emit({ type: "decision_gate_expired", threadId: this.id, gateId });
          });
          // Mark gate resolved in store and update DAG entry
          const resolved: DecisionGate = { ...gate, status: "resolved", updatedAt: Date.now() };
          await session.providers.store.saveDecisionGate(session.id, this.id, resolved);
          await session.providers.store.updateDecisionGateEntry(session.id, this.id, gate.id, {
            gate: resolved,
            resolution,
            resolvedAt: new Date(resolution.resolvedAt).toISOString(),
          });
          this.blockedGateId = undefined;
          this.setStatus("running");
          await session.providers.store.clearSuspendedTurn(session.id, this.id);
          return resolution;
        } catch (err) {
          // Withdrawn or expired: persist the terminal status, then propagate.
          const reason =
            err instanceof Error && err.name === "DecisionGateWithdrawnError"
              ? (err as { reason?: DecisionWithdrawReason }).reason ?? "cancel"
              : undefined;
          const status = reason ? "withdrawn" : "expired";
          const terminal: DecisionGate = { ...gate, status, updatedAt: Date.now() };
          await session.providers.store.saveDecisionGate(session.id, this.id, terminal);
          await session.providers.store.updateDecisionGateEntry(session.id, this.id, gate.id, {
            gate: terminal,
            withdrawnReason: reason,
          });
          this.blockedGateId = undefined;
          await session.providers.store.clearSuspendedTurn(session.id, this.id);
          throw err;
        }
      },
      threadRead: async (key, opts) => {
        const sibling = await this.session.threadByKey(key);
        if (!sibling) return [];
        return sibling.readEntries(opts);
      },
    };
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "agent_start":
        await this.session.emit({ type: "thread_start", threadId: this.id });
        await this.session.emit({ type: "status", threadId: this.id, status: "thinking" });
        break;
      case "message_start": {
        if (event.message.role === "assistant") {
          this.currentAssistantMessageId = uid("e");
          this.currentAssistantParts = [];
          this.currentToolCalls.clear();
          this.currentAssistantEntry = undefined;
          await this.session.emit({
            type: "message_start",
            threadId: this.id,
            messageId: this.currentAssistantMessageId,
            role: "assistant",
          });
        }
        break;
      }
      case "message_update": {
        const ev = event.assistantMessageEvent;
        if (ev.type === "text_delta") {
          await this.session.emit({
            type: "text_delta",
            threadId: this.id,
            text: ev.delta,
          });
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
          const text = textOf(event.message);
          // Compose parts: leading text + tool calls (already tracked)
          const parts: MessagePart[] = [];
          if (text) parts.push({ type: "text", text });
          for (const p of this.currentAssistantParts) parts.push(p);

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
            createdAt: Date.now(),
          };
          await this.session.providers.store.appendEntries(this.session.id, this.id, [entry]);
          // Hold a reference so tool_execution_end can re-persist as each
          // tool completes (`parts` is shared by reference; mutating a
          // tool_call's status flows through to this entry's parts array).
          this.currentAssistantEntry = entry;
          await this.session.emit({
            type: "message_end",
            threadId: this.id,
            messageId: entry.id,
            reason:
              event.message.stopReason === "aborted"
                ? "abort"
                : event.message.stopReason === "error"
                ? "error"
                : "end_turn",
          });
        }
        break;
      }
      case "tool_execution_start":
        this.toolCtxOverlay.gateId = undefined;
        await this.session.emit({
          type: "tool_start",
          threadId: this.id,
          tool: event.toolName,
          args: event.args ?? {},
        });
        await this.session.emit({ type: "status", threadId: this.id, status: "tool_calling" });
        break;
      case "tool_execution_end": {
        const part = this.currentToolCalls.get(event.toolCallId);
        if (part && part.type === "tool_call") {
          part.status = event.isError ? "error" : "completed";
          part.result = event.result;
        }
        // Re-persist the entry now that this tool's status/result has been
        // mutated. Without this, sqlite still has status="running" + no
        // result; on reload the chat shows tool cards stuck mid-execution.
        if (this.currentAssistantEntry) {
          await this.session.providers.store.updateEntry(
            this.session.id,
            this.id,
            this.currentAssistantEntry,
          );
        }
        const resultText = renderToolResult(event.result);
        await this.session.emit({
          type: "tool_end",
          threadId: this.id,
          tool: event.toolName,
          result: resultText,
          isError: event.isError,
        });
        break;
      }
      case "turn_end": {
        const stopReason =
          event.message.role === "assistant" ? event.message.stopReason : undefined;
        const errorMessage =
          event.message.role === "assistant" ? event.message.errorMessage : undefined;
        if (event.message.role === "assistant") {
          const u = event.message.usage;
          this.lastAssistantUsage = {
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
            total: u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite,
          };
        }
        if (errorMessage) {
          await this.session.emit({
            type: "error",
            threadId: this.id,
            code: stopReason ?? "agent_error",
            error: errorMessage,
            recoverable: stopReason !== "error",
          });
        }
        const reason: "end_turn" | "error" | "abort" =
          stopReason === "aborted"
            ? "abort"
            : stopReason === "error"
            ? "error"
            : "end_turn";
        await this.session.emit({ type: "turn_end", threadId: this.id, reason });
        await this.session.emit({ type: "status", threadId: this.id, status: "idle" });
        break;
      }
      default:
        break;
    }
  }

  private setStatus(status: QueueStatus): void {
    this.status = status;
  }

  private async persistQueueState(): Promise<void> {
    const state: QueueState = {
      threadId: this.id,
      mode: this.mode,
      status: this.status,
      activeItemId: this.activeItem?.id,
      pending: [...this.pending],
      collectBuffer: this.collectBuffer.length > 0 ? [...this.collectBuffer] : undefined,
      blockedGateId: this.blockedGateId,
    };
    await this.session.providers.store.saveQueueState(this.session.id, this.id, state);
    await this.session.emit({ type: "queue_state", threadId: this.id, state });
  }

  private emitError(code: string, message: string): void {
    void this.session.emit({
      type: "error",
      threadId: this.id,
      code,
      error: message,
      recoverable: true,
    });
  }
}

function promptText(content: PromptContent): string {
  if (typeof content === "string") return content;
  return content.text ?? "";
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
  systemPrompt?: string;
  model?: PiModel;
}

/**
 * Resolve a role's `model` frontmatter value to a pi-ai Model instance.
 * Supports `provider/model` form (e.g. "anthropic/claude-haiku-4-5") and
 * bare model ids that exist under any registered provider. Returns
 * undefined when the id can't be resolved — caller emits a warning rather
 * than failing the turn.
 */
function resolveRoleModel(spec: string): PiModel | undefined {
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const provider = spec.slice(0, slash);
    const modelId = spec.slice(slash + 1);
    return getModel(provider as never, modelId as never);
  }
  // Bare ids: try anthropic first, then a small set of common providers.
  // Plugins that use other providers should set provider/model explicitly.
  const tryProviders = ["anthropic", "openai", "google"] as const;
  for (const p of tryProviders) {
    const m = getModel(p, spec as never);
    if (m) return m;
  }
  return undefined;
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
 * Convert engine DAG entries to pi-agent-core AgentMessages, honoring the
 * most recent CompactionEntry (drop covered entries, inject summary as a
 * `<previous-context>` user message) and elided tool results (replace with
 * a placeholder text block on the assistant side).
 *
 * Pure function — kept here rather than inside Thread so it's
 * testable and reusable from places like Engine.restoreSession.
 */
export function entriesToAgentMessages(
  entries: readonly SessionEntry[],
  modelHint: { api: string; provider: string; id: string },
): AgentMessage[] {
  // 1. Find the most recent CompactionEntry. Everything in its coveredEntryIds is dropped.
  let activeCompaction: { summary: string; covered: Set<string> } | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "compaction") {
      activeCompaction = { summary: e.summary, covered: new Set(e.coveredEntryIds) };
      break;
    }
  }

  const out: AgentMessage[] = [];
  if (activeCompaction) {
    out.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `<previous-context>\n${activeCompaction.summary}\n</previous-context>`,
        },
      ],
      timestamp: 0,
    });
  }

  for (const e of entries) {
    if (e.type !== "message") continue;
    if (activeCompaction?.covered.has(e.id)) continue;

    if (e.role === "user") {
      out.push({
        role: "user",
        content: [{ type: "text", text: e.content }],
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
            arguments: (p.args as Record<string, unknown>) ?? {},
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
    }
  }
  return out;
}
