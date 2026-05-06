import { NotFoundError } from "../errors.js";
import type {
  DecisionGate,
  DecisionGateEntry,
  DecisionGateRef,
  ListOpts,
  MessageQuery,
  QueueState,
  SessionData,
  SessionEntry,
  SessionStatus,
  SessionStore,
  SuspendedTurnState,
  ThreadData,
} from "../types.js";

interface SessionRow {
  data: SessionData;
  threads: Map<string, ThreadData>;
  entriesByThread: Map<string, SessionEntry[]>;
  queueByThread: Map<string, QueueState>;
  gates: Map<string, DecisionGate>;
  gateRefs: Map<string, Array<{ channelType: string; ref: DecisionGateRef }>>;
  suspendedByThread: Map<string, SuspendedTurnState>;
}

export class InMemorySessionStore implements SessionStore {
  private rows = new Map<string, SessionRow>();

  private row(sessionId: string): SessionRow {
    const row = this.rows.get(sessionId);
    if (!row) throw new Error(`session not found: ${sessionId}`);
    return row;
  }

  async saveSession(session: SessionData): Promise<void> {
    const existing = this.rows.get(session.id);
    if (existing) {
      existing.data = session;
      return;
    }
    this.rows.set(session.id, {
      data: session,
      threads: new Map(),
      entriesByThread: new Map(),
      queueByThread: new Map(),
      gates: new Map(),
      gateRefs: new Map(),
      suspendedByThread: new Map(),
    });
  }

  async saveThread(sessionId: string, thread: ThreadData): Promise<void> {
    const r = this.row(sessionId);
    r.threads.set(thread.id, thread);
    if (!r.entriesByThread.has(thread.id)) r.entriesByThread.set(thread.id, []);
  }

  async appendEntries(
    sessionId: string,
    threadId: string,
    entries: SessionEntry[],
  ): Promise<void> {
    const r = this.row(sessionId);
    const list = r.entriesByThread.get(threadId) ?? [];
    list.push(...entries);
    r.entriesByThread.set(threadId, list);
    // Update activeLeafEntryId for convenience
    const t = r.threads.get(threadId);
    if (t && entries.length > 0) {
      t.activeLeafEntryId = entries[entries.length - 1].id;
      t.updatedAt = Date.now();
    }
  }

  async updateEntry(
    sessionId: string,
    threadId: string,
    entry: SessionEntry,
  ): Promise<void> {
    const r = this.row(sessionId);
    const list = r.entriesByThread.get(threadId) ?? [];
    const idx = list.findIndex((e) => e.id === entry.id);
    if (idx < 0) {
      throw new NotFoundError("entry", { sessionId, threadId, id: entry.id });
    }
    list[idx] = entry;
  }

  async saveQueueState(sessionId: string, threadId: string, queue: QueueState): Promise<void> {
    this.row(sessionId).queueByThread.set(threadId, queue);
  }

  async saveDecisionGate(sessionId: string, _threadId: string, gate: DecisionGate): Promise<void> {
    this.row(sessionId).gates.set(gate.id, { ...gate });
  }

  async saveDecisionGateRef(
    sessionId: string,
    _threadId: string,
    gateId: string,
    ref: { channelType: string; ref: DecisionGateRef },
  ): Promise<void> {
    const r = this.row(sessionId);
    const refs = r.gateRefs.get(gateId) ?? [];
    refs.push(ref);
    r.gateRefs.set(gateId, refs);
  }

  async updateDecisionGateEntry(
    sessionId: string,
    threadId: string,
    gateId: string,
    patch: Partial<DecisionGateEntry>,
  ): Promise<void> {
    const r = this.row(sessionId);
    const entries = r.entriesByThread.get(threadId) ?? [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.type === "decision_gate" && e.gate.id === gateId) {
        entries[i] = { ...e, ...patch, gate: patch.gate ?? e.gate };
      }
    }
  }

  async saveSuspendedTurn(
    sessionId: string,
    threadId: string,
    suspended: SuspendedTurnState,
  ): Promise<void> {
    this.row(sessionId).suspendedByThread.set(threadId, suspended);
  }

  async clearSuspendedTurn(sessionId: string, threadId: string): Promise<void> {
    this.row(sessionId).suspendedByThread.delete(threadId);
  }

  async updateSessionStatus(
    id: string,
    status: SessionStatus,
    metadata?: Partial<SessionData>,
  ): Promise<void> {
    const r = this.rows.get(id);
    if (!r) return;
    r.data = { ...r.data, ...metadata, status, updatedAt: Date.now() };
  }

  async getSession(id: string): Promise<SessionData | null> {
    return this.rows.get(id)?.data ?? null;
  }

  async listSessions(userId: string, opts?: ListOpts): Promise<SessionData[]> {
    const all = [...this.rows.values()].map((r) => r.data).filter((s) => s.userId === userId);
    if (opts?.status) return all.filter((s) => s.status === opts.status);
    return all;
  }

  async getThread(sessionId: string, threadId: string): Promise<ThreadData | null> {
    return this.row(sessionId).threads.get(threadId) ?? null;
  }

  async listThreads(sessionId: string): Promise<ThreadData[]> {
    return [...this.row(sessionId).threads.values()];
  }

  async getEntries(
    sessionId: string,
    threadId: string,
    opts?: MessageQuery,
  ): Promise<SessionEntry[]> {
    const all = this.row(sessionId).entriesByThread.get(threadId) ?? [];
    let result = all;
    if (opts?.includeCompacted === false) {
      result = result.filter((e) => e.type !== "compaction");
    }
    if (opts?.limit && opts.limit > 0) {
      result = result.slice(-opts.limit);
    }
    return [...result];
  }

  async getQueueState(sessionId: string, threadId: string): Promise<QueueState | null> {
    return this.row(sessionId).queueByThread.get(threadId) ?? null;
  }

  async listDecisionGates(sessionId: string, threadId?: string): Promise<DecisionGate[]> {
    const all = [...this.row(sessionId).gates.values()];
    if (threadId) return all.filter((g) => g.threadId === threadId);
    return all;
  }

  async getDecisionGate(sessionId: string, gateId: string): Promise<DecisionGate | null> {
    return this.row(sessionId).gates.get(gateId) ?? null;
  }

  async getSuspendedTurn(
    sessionId: string,
    threadId: string,
  ): Promise<SuspendedTurnState | null> {
    return this.row(sessionId).suspendedByThread.get(threadId) ?? null;
  }

  async deleteSession(id: string): Promise<void> {
    this.rows.delete(id);
  }
}
