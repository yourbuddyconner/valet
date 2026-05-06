import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { Session } from "./session.js";
import { toAgentTool } from "./tool-bridge.js";
import { fromRequest, GateManager } from "./decision-gate.js";
import type {
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
  ThreadData,
  ToolContext,
  ToolDef,
} from "./types.js";

interface PendingResolver {
  resolve: () => void;
  reject: (err: unknown) => void;
}

const DEFAULT_COLLECT_WINDOW_MS = 5000;

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
  private toolCtxOverlay: { gateId?: string } = {};

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
      void this.session.emit({
        type: "decision_gate_resolved",
        threadId: this.id,
        gateId,
        resolution,
      });
    }
    return ok;
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

    // Persist user message entry
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
      createdAt: Date.now(),
    };
    await this.session.providers.store.appendEntries(this.session.id, this.id, [userEntry]);

    // Build the AgentTool list with closures over this turn's ToolContext.
    this.agent.state.tools = this.buildTools();

    try {
      await this.agent.prompt({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      });
      await this.agent.waitForIdle();
    } catch (err) {
      this.emitError("agent_failed", err instanceof Error ? err.message : String(err));
    }

    // Persist any assistant message that landed in agent state we haven't already.
    // (We rely on subscribe handlers to append; this is a safety net if nothing did.)
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
      toAgentTool(def, (signal, toolCallId) => this.buildToolContext(signal, toolCallId)),
    );
  }

  private buildToolContext(signal: AbortSignal, toolCallId: string): ToolContext {
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
      requestDecision: async (req: DecisionGateRequest): Promise<DecisionResolution> => {
        const gate = fromRequest(req, {
          sessionId: session.id,
          threadId: this.id,
          queueItemId: this.activeItem?.id ?? "",
          resumeKey: req.resumeKey ?? "",
        });
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

        // checkpoint the suspended turn
        await session.providers.store.saveSuspendedTurn(session.id, this.id, {
          sessionId: session.id,
          threadId: this.id,
          queueItemId: this.activeItem?.id ?? "",
          gateId: gate.id,
          model: session.options.model.id,
          toolCallId,
          toolName: req.title,
          toolArgs: {},
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
        await this.session.emit({
          type: "turn_end",
          threadId: this.id,
          reason: stopReason === "aborted" ? "abort" : "end_turn",
        });
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
