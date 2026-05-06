import { Thread } from "./thread.js";
import { builtinTools } from "./builtin-tools/index.js";
import type {
  CreateSessionOptions,
  CredentialOwner,
  CredentialProvider,
  DecisionGate,
  DecisionResolution,
  DecisionWithdrawReason,
  EngineEvent,
  MessageQuery,
  PromptContent,
  PromptOptions,
  PromptReceipt,
  ProviderBundle,
  QueueMode,
  Sandbox,
  SessionData,
  SessionEntry,
  ThreadData,
  ToolDef,
} from "./types.js";

let nextId = 1;
function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

export class Session {
  readonly id: string;
  readonly providers: ProviderBundle;
  readonly options: CreateSessionOptions;
  readonly sandbox: Sandbox;
  readonly builtinTools: ToolDef[] = builtinTools;
  private threads = new Map<string, Thread>();
  private threadsByKey = new Map<string, Thread>();
  private destroyed = false;

  constructor(id: string, options: CreateSessionOptions, providers: ProviderBundle, sandbox: Sandbox) {
    this.id = id;
    this.options = options;
    this.providers = providers;
    this.sandbox = sandbox;
  }

  async ensureDefaultThread(): Promise<Thread> {
    return this.thread("web:default");
  }

  thread(key?: string): Thread {
    const k = key ?? "web:default";
    const existing = this.threadsByKey.get(k);
    if (existing) return existing;
    const data: ThreadData = {
      id: uid("th"),
      sessionId: this.id,
      key: k,
      status: "active",
      queueMode: this.options.queueMode ?? "followup",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const thread = new Thread(this, data);
    this.threads.set(thread.id, thread);
    this.threadsByKey.set(k, thread);
    void this.providers.store.saveThread(this.id, data);
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

  // ── public API ──────────────────────────────────────────────────

  async prompt(content: PromptContent, opts: PromptOptions = {}): Promise<PromptReceipt> {
    return this.thread().submitPrompt(content, opts);
  }

  async resolveDecision(gateId: string, resolution: DecisionResolution): Promise<void> {
    for (const t of this.threads.values()) {
      if (t.isPendingGate(gateId)) {
        t.resolveDecision(gateId, resolution);
        return;
      }
    }
    // Fallback: gate may have already been resolved or never registered.
  }

  async withdrawDecision(gateId: string, reason: DecisionWithdrawReason): Promise<void> {
    for (const t of this.threads.values()) {
      if (t.isPendingGate(gateId)) {
        t.withdrawDecision(gateId, reason);
        return;
      }
    }
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

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await Promise.all([...this.threads.values()].map((t) => t.abort()));
    if (this.sandbox.destroy) await this.sandbox.destroy();
    await this.providers.store.deleteSession(this.id);
  }

  async pendingDecisionGates(): Promise<DecisionGate[]> {
    return this.providers.store.listDecisionGates(this.id);
  }

  async readEntries(threadKey: string, opts?: MessageQuery): Promise<SessionEntry[]> {
    const t = await this.threadByKey(threadKey);
    if (!t) return [];
    return t.readEntries(opts);
  }

  async toData(): Promise<SessionData> {
    return {
      id: this.id,
      userId: this.options.userId,
      orgId: this.options.orgId,
      workspace: this.options.workspace,
      purpose: this.options.purpose ?? "interactive",
      status: "running",
      sandboxId: this.sandbox.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  async emit(event: EngineEvent): Promise<void> {
    await this.providers.bus.publish({
      sessionId: this.id,
      threadId: "threadId" in event ? (event.threadId as string | undefined) : undefined,
      userId: this.options.userId,
      event,
      timestamp: Date.now(),
    });
  }

  // ── credential provider for tools ───────────────────────────────

  credentialProvider(): CredentialProvider {
    const owner: CredentialOwner = { type: "user", id: this.options.userId };
    const credStore = this.providers.credentials;
    const session = this;
    return {
      async get(service: string) {
        if (!credStore) return null;
        const stored = await credStore.get(owner, service);
        if (!stored) return null;
        return {
          accessToken: stored.accessToken ?? stored.apiKey ?? "",
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
        if (!credStore) throw new Error(`credential ${service} not available (no store)`);
        const stored = await credStore.get(owner, service);
        if (!stored) throw new Error(`credential ${service} not connected: ${reason}`);
        return {
          accessToken: stored.accessToken ?? stored.apiKey ?? "",
          refreshToken: stored.refreshToken,
          expiresAt: stored.expiresAt,
          scopes: stored.scopes,
          metadata: stored.metadata,
        };
      },
    };
  }
}
