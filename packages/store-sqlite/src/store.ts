import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq, asc } from "drizzle-orm";
import {
  engineSessions,
  engineThreads,
  engineEntries,
  engineQueueItems,
  engineQueueState,
  engineDecisionGates,
  engineDecisionGateRefs,
  engineSuspendedTurns,
} from "./schema.js";
import { NotFoundError } from "@valet/engine";
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
} from "@valet/engine";
import { entryToRow, jsonOrNull, parseJson, rowToEntry, type EntryRow } from "./helpers.js";

export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: BetterSQLite3Database) {}

  async saveSession(session: SessionData): Promise<void> {
    this.db
      .insert(engineSessions)
      .values({
        id: session.id,
        userId: session.userId,
        orgId: session.orgId,
        workspace: session.workspace,
        purpose: session.purpose,
        status: session.status,
        sandboxId: session.sandboxId ?? null,
        snapshotId: session.snapshotId ?? null,
        parentSessionId: session.parentSessionId ?? null,
        model: session.model ?? null,
        metadata: jsonOrNull(session.metadata),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })
      .onConflictDoUpdate({
        target: engineSessions.id,
        set: {
          status: session.status,
          sandboxId: session.sandboxId ?? null,
          snapshotId: session.snapshotId ?? null,
          model: session.model ?? null,
          metadata: jsonOrNull(session.metadata),
          updatedAt: session.updatedAt,
        },
      })
      .run();
  }

  async saveThread(_sessionId: string, thread: ThreadData): Promise<void> {
    this.db
      .insert(engineThreads)
      .values({
        id: thread.id,
        sessionId: thread.sessionId,
        key: thread.key,
        status: thread.status,
        activeLeafEntryId: thread.activeLeafEntryId ?? null,
        queueMode: thread.queueMode,
        model: thread.model ?? null,
        summary: thread.summary ?? null,
        metadata: jsonOrNull(thread.metadata),
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      })
      .onConflictDoUpdate({
        target: engineThreads.id,
        set: {
          status: thread.status,
          activeLeafEntryId: thread.activeLeafEntryId ?? null,
          queueMode: thread.queueMode,
          model: thread.model ?? null,
          summary: thread.summary ?? null,
          updatedAt: thread.updatedAt,
        },
      })
      .run();
  }

  async appendEntries(_sessionId: string, threadId: string, entries: SessionEntry[]): Promise<void> {
    for (const e of entries) {
      const row = entryToRow(e);
      this.db.insert(engineEntries).values(row).run();
    }
    if (entries.length > 0) {
      const lastId = entries[entries.length - 1].id;
      this.db
        .update(engineThreads)
        .set({ activeLeafEntryId: lastId, updatedAt: Date.now() })
        .where(eq(engineThreads.id, threadId))
        .run();
    }
  }

  async updateEntry(
    sessionId: string,
    threadId: string,
    entry: SessionEntry,
  ): Promise<void> {
    const row = entryToRow(entry);
    // Drizzle's update().set().where() returns an info object on better-sqlite3
    // with a `changes` count we can check.
    const result = this.db
      .update(engineEntries)
      .set(row)
      .where(
        and(
          eq(engineEntries.sessionId, sessionId),
          eq(engineEntries.threadId, threadId),
          eq(engineEntries.id, entry.id),
        ),
      )
      .run();
    if ((result as { changes?: number }).changes === 0) {
      throw new NotFoundError("entry", { sessionId, threadId, id: entry.id });
    }
  }

  async saveQueueState(sessionId: string, threadId: string, queue: QueueState): Promise<void> {
    this.db
      .insert(engineQueueState)
      .values({
        sessionId,
        threadId,
        mode: queue.mode,
        status: queue.status,
        activeItemId: queue.activeItemId ?? null,
        pending: JSON.stringify(queue.pending),
        collectBuffer: queue.collectBuffer ? JSON.stringify(queue.collectBuffer) : null,
        blockedGateId: queue.blockedGateId ?? null,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [engineQueueState.sessionId, engineQueueState.threadId],
        set: {
          mode: queue.mode,
          status: queue.status,
          activeItemId: queue.activeItemId ?? null,
          pending: JSON.stringify(queue.pending),
          collectBuffer: queue.collectBuffer ? JSON.stringify(queue.collectBuffer) : null,
          blockedGateId: queue.blockedGateId ?? null,
          updatedAt: Date.now(),
        },
      })
      .run();
  }

  async saveDecisionGate(sessionId: string, threadId: string, gate: DecisionGate): Promise<void> {
    this.db
      .insert(engineDecisionGates)
      .values({
        id: gate.id,
        sessionId,
        threadId,
        type: gate.type,
        status: gate.status,
        title: gate.title,
        body: gate.body ?? null,
        actions: JSON.stringify(gate.actions),
        origin: jsonOrNull(gate.origin),
        context: jsonOrNull(gate.context),
        resolution: null,
        expiresAt: gate.expiresAt ?? null,
        createdAt: gate.createdAt,
        updatedAt: gate.updatedAt,
      })
      .onConflictDoUpdate({
        target: engineDecisionGates.id,
        set: {
          status: gate.status,
          title: gate.title,
          body: gate.body ?? null,
          actions: JSON.stringify(gate.actions),
          context: jsonOrNull(gate.context),
          updatedAt: gate.updatedAt,
        },
      })
      .run();
  }

  async saveDecisionGateRef(
    _sessionId: string,
    _threadId: string,
    gateId: string,
    ref: { channelType: string; ref: DecisionGateRef },
  ): Promise<void> {
    this.db
      .insert(engineDecisionGateRefs)
      .values({
        id: `${gateId}:${ref.channelType}:${ref.ref.messageId}`,
        gateId,
        channelType: ref.channelType,
        ref: JSON.stringify(ref.ref),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
  }

  async updateDecisionGateEntry(
    sessionId: string,
    threadId: string,
    gateId: string,
    patch: Partial<DecisionGateEntry>,
  ): Promise<void> {
    const rows = this.db
      .select()
      .from(engineEntries)
      .where(
        and(
          eq(engineEntries.sessionId, sessionId),
          eq(engineEntries.threadId, threadId),
          eq(engineEntries.gateId, gateId),
        ),
      )
      .all() as EntryRow[];
    for (const row of rows) {
      const current = rowToEntry(row);
      if (current.type !== "decision_gate") continue;
      const merged: DecisionGateEntry = {
        ...current,
        ...patch,
        gate: patch.gate ?? current.gate,
      };
      const newRow = entryToRow(merged);
      this.db
        .update(engineEntries)
        .set({
          metadata: newRow.metadata,
          resolvedAt: newRow.resolvedAt,
          resolution: newRow.resolution,
          withdrawnReason: newRow.withdrawnReason,
        })
        .where(eq(engineEntries.id, row.id))
        .run();
    }
  }

  async saveSuspendedTurn(
    sessionId: string,
    threadId: string,
    s: SuspendedTurnState,
  ): Promise<void> {
    this.db
      .insert(engineSuspendedTurns)
      .values({
        sessionId,
        threadId,
        queueItemId: s.queueItemId,
        gateId: s.gateId,
        model: s.model,
        leafEntryId: s.leafMessageId ?? null,
        toolCallId: s.toolCallId,
        toolName: s.toolName,
        toolArgs: JSON.stringify(s.toolArgs),
        resumeKey: s.resumeKey,
        attempt: s.attempt,
        createdAt: s.createdAt,
      })
      .onConflictDoUpdate({
        target: [engineSuspendedTurns.sessionId, engineSuspendedTurns.threadId],
        set: {
          queueItemId: s.queueItemId,
          gateId: s.gateId,
          model: s.model,
          leafEntryId: s.leafMessageId ?? null,
          toolCallId: s.toolCallId,
          toolName: s.toolName,
          toolArgs: JSON.stringify(s.toolArgs),
          resumeKey: s.resumeKey,
          attempt: s.attempt,
        },
      })
      .run();
  }

  async clearSuspendedTurn(sessionId: string, threadId: string): Promise<void> {
    this.db
      .delete(engineSuspendedTurns)
      .where(
        and(
          eq(engineSuspendedTurns.sessionId, sessionId),
          eq(engineSuspendedTurns.threadId, threadId),
        ),
      )
      .run();
  }

  async updateSessionStatus(
    id: string,
    status: SessionStatus,
    metadata?: Partial<SessionData>,
  ): Promise<void> {
    this.db
      .update(engineSessions)
      .set({
        status,
        sandboxId: metadata?.sandboxId ?? undefined,
        snapshotId: metadata?.snapshotId ?? undefined,
        updatedAt: Date.now(),
      })
      .where(eq(engineSessions.id, id))
      .run();
  }

  async getSession(id: string): Promise<SessionData | null> {
    const row = this.db.select().from(engineSessions).where(eq(engineSessions.id, id)).get();
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      orgId: row.orgId,
      workspace: row.workspace,
      purpose: row.purpose as SessionData["purpose"],
      status: row.status as SessionData["status"],
      sandboxId: row.sandboxId ?? undefined,
      snapshotId: row.snapshotId ?? undefined,
      parentSessionId: row.parentSessionId ?? undefined,
      model: row.model ?? undefined,
      metadata: parseJson(row.metadata),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async listSessions(userId: string, opts?: ListOpts): Promise<SessionData[]> {
    const rows = this.db
      .select()
      .from(engineSessions)
      .where(eq(engineSessions.userId, userId))
      .all();
    let result: SessionData[] = rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      orgId: r.orgId,
      workspace: r.workspace,
      purpose: r.purpose as SessionData["purpose"],
      status: r.status as SessionData["status"],
      sandboxId: r.sandboxId ?? undefined,
      snapshotId: r.snapshotId ?? undefined,
      parentSessionId: r.parentSessionId ?? undefined,
      model: r.model ?? undefined,
      metadata: parseJson(r.metadata),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    if (opts?.status) result = result.filter((s) => s.status === opts.status);
    return result;
  }

  async getThread(sessionId: string, threadId: string): Promise<ThreadData | null> {
    const row = this.db
      .select()
      .from(engineThreads)
      .where(and(eq(engineThreads.sessionId, sessionId), eq(engineThreads.id, threadId)))
      .get();
    if (!row) return null;
    return rowToThread(row);
  }

  async listThreads(sessionId: string): Promise<ThreadData[]> {
    const rows = this.db
      .select()
      .from(engineThreads)
      .where(eq(engineThreads.sessionId, sessionId))
      .all();
    return rows.map(rowToThread);
  }

  async getEntries(
    sessionId: string,
    threadId: string,
    opts?: MessageQuery,
  ): Promise<SessionEntry[]> {
    let rows = this.db
      .select()
      .from(engineEntries)
      .where(and(eq(engineEntries.sessionId, sessionId), eq(engineEntries.threadId, threadId)))
      .orderBy(asc(engineEntries.createdAt))
      .all() as EntryRow[];
    if (opts?.includeCompacted === false) rows = rows.filter((r) => r.entryType !== "compaction");
    if (opts?.limit && opts.limit > 0) rows = rows.slice(-opts.limit);
    return rows.map(rowToEntry);
  }

  async getQueueState(sessionId: string, threadId: string): Promise<QueueState | null> {
    const row = this.db
      .select()
      .from(engineQueueState)
      .where(
        and(eq(engineQueueState.sessionId, sessionId), eq(engineQueueState.threadId, threadId)),
      )
      .get();
    if (!row) return null;
    return {
      threadId: row.threadId,
      mode: row.mode as QueueState["mode"],
      status: row.status as QueueState["status"],
      activeItemId: row.activeItemId ?? undefined,
      pending: parseJson(row.pending) ?? [],
      collectBuffer: parseJson(row.collectBuffer),
      blockedGateId: row.blockedGateId ?? undefined,
    };
  }

  async listDecisionGates(sessionId: string, threadId?: string): Promise<DecisionGate[]> {
    const rows = threadId
      ? this.db
          .select()
          .from(engineDecisionGates)
          .where(
            and(
              eq(engineDecisionGates.sessionId, sessionId),
              eq(engineDecisionGates.threadId, threadId),
            ),
          )
          .all()
      : this.db
          .select()
          .from(engineDecisionGates)
          .where(eq(engineDecisionGates.sessionId, sessionId))
          .all();
    return rows.map(rowToGate);
  }

  async getDecisionGate(sessionId: string, gateId: string): Promise<DecisionGate | null> {
    const row = this.db
      .select()
      .from(engineDecisionGates)
      .where(
        and(eq(engineDecisionGates.sessionId, sessionId), eq(engineDecisionGates.id, gateId)),
      )
      .get();
    return row ? rowToGate(row) : null;
  }

  async getSuspendedTurn(
    sessionId: string,
    threadId: string,
  ): Promise<SuspendedTurnState | null> {
    const row = this.db
      .select()
      .from(engineSuspendedTurns)
      .where(
        and(
          eq(engineSuspendedTurns.sessionId, sessionId),
          eq(engineSuspendedTurns.threadId, threadId),
        ),
      )
      .get();
    if (!row) return null;
    return {
      sessionId: row.sessionId,
      threadId: row.threadId,
      queueItemId: row.queueItemId,
      gateId: row.gateId,
      model: row.model,
      leafMessageId: row.leafEntryId ?? undefined,
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      toolArgs: parseJson(row.toolArgs) ?? {},
      resumeKey: row.resumeKey,
      attempt: row.attempt,
      createdAt: row.createdAt,
    };
  }

  async deleteSession(id: string): Promise<void> {
    this.db.delete(engineEntries).where(eq(engineEntries.sessionId, id)).run();
    this.db.delete(engineQueueItems).where(eq(engineQueueItems.sessionId, id)).run();
    this.db.delete(engineQueueState).where(eq(engineQueueState.sessionId, id)).run();
    this.db.delete(engineDecisionGates).where(eq(engineDecisionGates.sessionId, id)).run();
    this.db.delete(engineSuspendedTurns).where(eq(engineSuspendedTurns.sessionId, id)).run();
    this.db.delete(engineThreads).where(eq(engineThreads.sessionId, id)).run();
    this.db.delete(engineSessions).where(eq(engineSessions.id, id)).run();
  }
}

function rowToThread(r: typeof engineThreads.$inferSelect): ThreadData {
  return {
    id: r.id,
    sessionId: r.sessionId,
    key: r.key,
    status: r.status as ThreadData["status"],
    activeLeafEntryId: r.activeLeafEntryId ?? undefined,
    queueMode: r.queueMode as ThreadData["queueMode"],
    model: r.model ?? undefined,
    summary: r.summary ?? undefined,
    metadata: parseJson(r.metadata),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function rowToGate(row: typeof engineDecisionGates.$inferSelect): DecisionGate {
  return {
    id: row.id,
    sessionId: row.sessionId,
    threadId: row.threadId,
    type: row.type as DecisionGate["type"],
    status: row.status as DecisionGate["status"],
    title: row.title,
    body: row.body ?? undefined,
    actions: parseJson(row.actions) ?? [],
    origin: parseJson(row.origin),
    context: parseJson(row.context),
    expiresAt: row.expiresAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
