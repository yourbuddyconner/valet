import { ConflictError, NotFoundError, PendingCapError, StaleAttemptError, ValidationError, withSpan } from "@valet/engine";
import type {
  DecisionGate,
  DecisionGateEntry,
  DecisionGateRef,
  ListOpts,
  MessageQuery,
  Principal,
  PromptAuthor,
  PromptContent,
  QueueItem,
  SessionData,
  SessionEntry,
  SessionStatus,
  SessionStore,
  SettlePatchRef,
  SubmissionAdmissionOptions,
  SubmissionClaim,
  SubmissionOutcome,
  SuspendedTurnState,
  ThreadData,
  WriteFence,
} from "@valet/engine";
import { isPgUniqueViolation } from "./db.js";
import type { PgDb, PgQueryable } from "./db.js";
import {
  entryToRow,
  jsonOrNull,
  parseJson,
  parseJsonRequired,
  rawToEntryRow,
  rawToGateRow,
  rawToQueueItemRow,
  rawToSessionRow,
  rawToSuspendedTurnRow,
  rawToThreadRow,
  rowToEntry,
  rowToGate,
  toNum,
  toNumOrNull,
  type EntryInsertRow,
  type QueueItemRow,
  type SessionRow,
  type ThreadRow,
} from "./helpers.js";

const DEFAULT_LEASE_MS = 30_000;

function queueItemRowToItem(row: QueueItemRow): QueueItem {
  return {
    id: row.id,
    threadId: row.threadId,
    dispatchId: row.dispatchId ?? undefined,
    content: parseJsonRequired<PromptContent>(row.content),
    author: parseJson<PromptAuthor>(row.author),
    channel: parseJson(row.channel),
    replyTarget: parseJson(row.replyTarget),
    model: row.model ?? undefined,
    role: row.role ?? undefined,
    metadata: parseJson(row.metadata),
    status: row.status as QueueItem["status"],
    outcome: row.outcome
      ? { outcome: row.outcome as SubmissionOutcome["outcome"], error: row.error ?? undefined }
      : undefined,
    supersededByItemId: row.supersededByItemId ?? undefined,
    mergedIntoItemId: row.mergedIntoItemId ?? undefined,
    attemptId: row.attemptId ?? undefined,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    // Absent ≡ 0 per the QueueItem contract: map the column default back to
    // "absent" so round-trips match the in-memory backend exactly.
    credentialAttempts: row.credentialAttempts === 0 ? undefined : row.credentialAttempts,
    lastCredentialReleaseAt: row.lastCredentialReleaseAt ?? undefined,
    timeoutAt: row.timeoutAt,
    abortRequestedAt: row.abortRequestedAt ?? undefined,
    ownerId: row.ownerId ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt ?? undefined,
    settlePatch: row.settlePatch ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function queueItemInsertParams(sessionId: string, threadId: string, item: QueueItem): unknown[] {
  return [
    item.id,
    sessionId,
    threadId,
    // Normalize an empty-string dispatchId to NULL so the partial unique
    // index (WHERE dispatch_id IS NOT NULL) never dedups on "" — matching
    // the in-memory backend, which treats "" as an absent idempotency key.
    item.dispatchId || null,
    item.status,
    item.outcome?.outcome ?? null,
    item.outcome?.error ?? null,
    item.supersededByItemId ?? null,
    item.mergedIntoItemId ?? null,
    JSON.stringify(item.content),
    jsonOrNull(item.author),
    jsonOrNull(item.channel),
    jsonOrNull(item.replyTarget),
    item.model ?? null,
    item.role ?? null,
    jsonOrNull(item.metadata),
    item.attemptId ?? null,
    item.attemptCount,
    item.maxAttempts,
    item.credentialAttempts ?? 0,
    item.lastCredentialReleaseAt ?? null,
    item.timeoutAt,
    item.abortRequestedAt ?? null,
    item.ownerId ?? null,
    item.leaseExpiresAt ?? null,
    item.settlePatch?.status ?? null,
    item.settlePatch?.reason ?? null,
    item.settlePatch?.blobKey ?? null,
    item.settlePatch?.bytes ?? null,
    item.settlePatch === undefined ? null : item.settlePatch.truncated ? 1 : 0,
    item.createdAt,
    item.updatedAt,
  ];
}

const INSERT_QUEUE_ITEM_SQL = `
  INSERT INTO engine_queue_items (
    id, session_id, thread_id, dispatch_id, status, outcome, error,
    superseded_by_item_id, merged_into_item_id, content, author, channel,
    reply_target, model, role, metadata, attempt_id, attempt_count,
    max_attempts, credential_attempts, last_credential_release_at,
    timeout_at, abort_requested_at, owner_id, lease_expires_at,
    settle_patch_status, settle_patch_reason, settle_patch_blob_key,
    settle_patch_bytes, settle_patch_truncated,
    created_at, updated_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
    $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
    $31, $32
  )
`;

// Steer supersession: stamp every unsettled, not-yet-superseded item of the
// thread admitted at or before the steering item's createdAt (matches
// InMemorySessionStore.admitSubmission's steer loop exactly).
const PROMOTION_PENDING_SQL = `
  SELECT * FROM engine_queue_items
  WHERE session_id = $1 AND thread_id = $2
    AND status != 'settled' AND superseded_by_item_id IS NULL
  FOR UPDATE
`;

const STEER_CANDIDATES_SQL = `
  SELECT id FROM engine_queue_items
  WHERE session_id = $1 AND thread_id = $2 AND id != $3
    AND status != 'settled'
    AND superseded_by_item_id IS NULL
    AND created_at <= $4
`;

// claimSubmission: single-statement CAS (decision 6, bucket 1). Succeeds
// only when itemId IS the thread's runnable head (oldest 'queued',
// not-superseded item) — the subquery re-derives the head so a concurrent
// claim of a different item (or of a non-head item) loses (rowCount=0). No
// transaction/row-lock needed: this is one atomic UPDATE statement, and
// Postgres's own MVCC serializes concurrent UPDATEs against the same rows.
const CLAIM_SQL = `
  UPDATE engine_queue_items
  SET status = 'running', attempt_id = $1, owner_id = $2,
      lease_expires_at = $3, attempt_count = attempt_count + 1,
      updated_at = $4
  WHERE id = $5 AND session_id = $6 AND thread_id = $7
    AND status = 'queued' AND superseded_by_item_id IS NULL
    AND id = (
      -- Per-thread FIFO gating (spec: "Only the oldest non-superseded
      -- unsettled submission of a thread is claimable"): the head is the
      -- oldest item that is neither settled nor collecting and has not been
      -- superseded. The outer status='queued' check then requires that head
      -- to actually be the requested, still-queued item.
      SELECT id FROM engine_queue_items
      WHERE session_id = $6 AND thread_id = $7
        AND status NOT IN ('settled', 'collecting') AND superseded_by_item_id IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    )
`;

// replaceSubmissionAttempt: CAS install a new attempt (decision 6, bucket
// 1). No lease-expiry condition here — callers (reconciliation) decide
// whether a lease is expired via listExpiredSubmissions before calling
// this; the store only enforces status + prior-attempt identity (matches
// InMemorySessionStore).
const REPLACE_ATTEMPT_SQL = `
  UPDATE engine_queue_items
  SET attempt_id = $1, owner_id = $2, lease_expires_at = $3,
      attempt_count = attempt_count + 1, updated_at = $4
  WHERE id = $5 AND session_id = $6 AND thread_id = $7
    AND status IN ('running', 'blocked_on_decision_gate')
    AND attempt_id = $8
`;

// Stamp the gesture's durable target in one statement. Status and identity
// matching prevent a delayed retry from stamping a queued successor.
const ABORT_ACTIVE_SUBMISSION_SQL = `
  UPDATE engine_queue_items
  SET abort_requested_at = COALESCE(abort_requested_at, $1),
      updated_at = CASE WHEN abort_requested_at IS NULL THEN $1 ELSE updated_at END
  WHERE session_id = $2 AND thread_id = $3 AND id = $4
    AND status IN ('running', 'blocked_on_decision_gate')
  RETURNING *
`;

// Pending-cap denominator (mirrors countPendingForCap's semantics applied to
// an already-unsettled item list): unsettled, non-superseded items of the
// thread. Read inside admitSubmission's own transaction (after the per-thread
// row lock below) so the count-then-insert is atomic against concurrent
// admissions.
const PENDING_COUNT_SQL = `
  SELECT COUNT(*) as count FROM engine_queue_items
  WHERE session_id = $1 AND thread_id = $2
    AND status != 'settled' AND superseded_by_item_id IS NULL
`;

function rowId(raw: Record<string, unknown>): string {
  if (typeof raw.id !== "string") throw new Error(`expected string id, got ${typeof raw.id}`);
  return raw.id;
}

const ENTRY_COLUMNS = [
  "id",
  "session_id",
  "thread_id",
  "parent_id",
  "entry_type",
  "role",
  "content",
  "parts",
  "signal",
  "author",
  "channel",
  "model",
  "queue_item_id",
  "stop_reason",
  "summary",
  "covered_entry_ids",
  "token_count_before",
  "token_count_after",
  "file_context",
  "branch_root_id",
  "branch_leaf_id",
  "gate_id",
  "resolved_at",
  "resolution",
  "withdrawn_reason",
  "metadata",
  "usage",
  "cost",
  "attachments",
  "created_at",
] as const;

const INSERT_ENTRY_SQL = `
  INSERT INTO engine_entries (${ENTRY_COLUMNS.join(", ")})
  VALUES (${ENTRY_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})
`;

function entryInsertParams(row: EntryInsertRow): unknown[] {
  return [
    row.id,
    row.sessionId,
    row.threadId,
    row.parentId,
    row.entryType,
    row.role,
    row.content,
    row.parts,
    row.signal,
    row.author,
    row.channel,
    row.model,
    row.queueItemId,
    row.stopReason,
    row.summary,
    row.coveredEntryIds,
    row.tokenCountBefore,
    row.tokenCountAfter,
    row.fileContext,
    row.branchRootId,
    row.branchLeafId,
    row.gateId,
    row.resolvedAt,
    row.resolution,
    row.withdrawnReason,
    row.metadata,
    row.usage,
    row.cost,
    row.attachments,
    row.createdAt,
  ];
}

export class PgSessionStore implements SessionStore {
  constructor(private readonly db: PgDb) {}

  async saveSession(session: SessionData): Promise<void> {
    await this.db.query(
      `INSERT INTO engine_sessions (
         id, owner_type, owner_id, user_id, org_id, workspace, purpose, status,
         sandbox_id, snapshot_id, parent_session_id, parent_thread_id, model, reasoning,
         metadata, start_ref, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (id) DO UPDATE SET
         owner_type = EXCLUDED.owner_type,
         owner_id = EXCLUDED.owner_id,
         status = EXCLUDED.status,
         sandbox_id = EXCLUDED.sandbox_id,
         snapshot_id = EXCLUDED.snapshot_id,
         parent_thread_id = EXCLUDED.parent_thread_id,
         model = EXCLUDED.model,
         reasoning = EXCLUDED.reasoning,
         metadata = EXCLUDED.metadata,
         start_ref = EXCLUDED.start_ref,
         updated_at = EXCLUDED.updated_at`,
      [
        session.id,
        session.owner.type,
        session.owner.id,
        session.userId,
        session.orgId,
        session.workspace,
        session.purpose,
        session.status,
        session.sandboxId ?? null,
        session.snapshotId ?? null,
        session.parentSessionId ?? null,
        session.parentThreadId ?? null,
        session.model ?? null,
        session.reasoning ?? null,
        jsonOrNull(session.metadata),
        jsonOrNull(session.startRef),
        session.createdAt,
        session.updatedAt,
      ],
    );
  }

  async saveThread(_sessionId: string, thread: ThreadData): Promise<void> {
    const paused = thread.paused === undefined ? null : thread.paused ? 1 : 0;
    await this.db.query(
      `INSERT INTO engine_threads (
         id, session_id, key, status, active_leaf_entry_id, queue_mode, paused,
         model, reasoning, summary, metadata, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         queue_mode = EXCLUDED.queue_mode,
         paused = EXCLUDED.paused,
         model = EXCLUDED.model,
         reasoning = EXCLUDED.reasoning,
         summary = EXCLUDED.summary,
         updated_at = EXCLUDED.updated_at`,
      [
        thread.id,
        thread.sessionId,
        thread.key,
        thread.status,
        thread.activeLeafEntryId ?? null,
        thread.queueMode,
        paused,
        thread.model ?? null,
        thread.reasoning ?? null,
        thread.summary ?? null,
        jsonOrNull(thread.metadata),
        thread.createdAt,
        thread.updatedAt,
      ],
    );
  }

  /** Validate a fence's current attempt without locking a row (no tx). Only
   * used where the caller doesn't otherwise need the full row. */
  private async checkFenceTx(tx: PgQueryable, fence?: WriteFence): Promise<void> {
    if (!fence) return;
    const result = await tx.query("SELECT attempt_id FROM engine_queue_items WHERE id = $1 FOR UPDATE", [
      fence.itemId,
    ]);
    const raw = result.rows[0];
    const attemptId = raw && typeof raw.attempt_id === "string" ? raw.attempt_id : undefined;
    if (!raw || attemptId !== fence.attemptId) {
      throw new StaleAttemptError(fence.itemId, fence.attemptId, attemptId);
    }
  }

  /**
   * Fence check + full row lookup, scoped to (sessionId, threadId, itemId).
   * Locks the fenced queue-item row with `SELECT ... FOR UPDATE` BEFORE the
   * fence check (decision 6 of docs/specs/2026-07-15-postgres-backend-design.md)
   * so a concurrent claimSubmission/replaceSubmissionAttempt on the same row
   * serializes against this read-then-write. Mirrors
   * InMemorySessionStore's `fencedItem`: the fence must name the item's
   * current attempt AND the item identified by itemId must be the same item
   * the fence names, in the given thread.
   */
  private async lockAndCheckFence(
    tx: PgQueryable,
    sessionId: string,
    threadId: string,
    itemId: string,
    fence: WriteFence,
  ): Promise<QueueItemRow> {
    const result = await tx.query("SELECT * FROM engine_queue_items WHERE id = $1 FOR UPDATE", [fence.itemId]);
    const raw = result.rows[0];
    const row = raw ? rawToQueueItemRow(raw) : undefined;
    if (
      !row ||
      row.sessionId !== sessionId ||
      row.threadId !== threadId ||
      row.id !== fence.itemId ||
      row.id !== itemId ||
      row.attemptId !== fence.attemptId
    ) {
      throw new StaleAttemptError(fence.itemId, fence.attemptId, row?.attemptId ?? undefined);
    }
    return row;
  }

  async appendEntries(
    _sessionId: string,
    threadId: string,
    entries: SessionEntry[],
    fence?: WriteFence,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.checkFenceTx(tx, fence);
      for (const e of entries) {
        const row = entryToRow(e);
        await tx.query(INSERT_ENTRY_SQL, entryInsertParams(row));
      }
      if (entries.length > 0) {
        const lastId = entries[entries.length - 1].id;
        await tx.query("UPDATE engine_threads SET active_leaf_entry_id = $1, updated_at = $2 WHERE id = $3", [
          lastId,
          Date.now(),
          threadId,
        ]);
      }
    });
  }

  async updateEntry(sessionId: string, threadId: string, entry: SessionEntry, fence?: WriteFence): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.checkFenceTx(tx, fence);
      const row = entryToRow(entry);
      const result = await tx.query(
        `UPDATE engine_entries SET
           parent_id = $1, entry_type = $2, role = $3, content = $4, parts = $5,
           signal = $6, author = $7, channel = $8, model = $9, queue_item_id = $10,
           stop_reason = $11, summary = $12, covered_entry_ids = $13,
           token_count_before = $14, token_count_after = $15, file_context = $16,
           branch_root_id = $17, branch_leaf_id = $18, gate_id = $19,
           resolved_at = $20, resolution = $21, withdrawn_reason = $22,
           metadata = $23, usage = $24, cost = $25, attachments = $26, created_at = $27
         WHERE session_id = $28 AND thread_id = $29 AND id = $30`,
        [
          row.parentId,
          row.entryType,
          row.role,
          row.content,
          row.parts,
          row.signal,
          row.author,
          row.channel,
          row.model,
          row.queueItemId,
          row.stopReason,
          row.summary,
          row.coveredEntryIds,
          row.tokenCountBefore,
          row.tokenCountAfter,
          row.fileContext,
          row.branchRootId,
          row.branchLeafId,
          row.gateId,
          row.resolvedAt,
          row.resolution,
          row.withdrawnReason,
          row.metadata,
          row.usage,
          row.cost,
          row.attachments,
          row.createdAt,
          sessionId,
          threadId,
          entry.id,
        ],
      );
      if (result.rowCount === 0) {
        throw new NotFoundError("entry", { sessionId, threadId, id: entry.id });
      }
    });
  }

  async saveDecisionGate(sessionId: string, threadId: string, gate: DecisionGate): Promise<void> {
    await this.db.query(
      `INSERT INTO engine_decision_gates (
         id, session_id, thread_id, queue_item_id, resume_key, ordinal, type,
         status, title, body, actions, origin, context, resolution, expires_at,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         title = EXCLUDED.title,
         body = EXCLUDED.body,
         actions = EXCLUDED.actions,
         context = EXCLUDED.context,
         resolution = EXCLUDED.resolution,
         updated_at = EXCLUDED.updated_at`,
      [
        gate.id,
        sessionId,
        threadId,
        gate.queueItemId,
        gate.resumeKey,
        gate.ordinal,
        gate.type,
        gate.status,
        gate.title,
        gate.body ?? null,
        JSON.stringify(gate.actions),
        jsonOrNull(gate.origin),
        jsonOrNull(gate.context),
        jsonOrNull(gate.resolution),
        gate.expiresAt ?? null,
        gate.createdAt,
        gate.updatedAt,
      ],
    );
  }

  async saveDecisionGateRef(
    _sessionId: string,
    _threadId: string,
    gateId: string,
    ref: { channelType: string; ref: DecisionGateRef },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO engine_decision_gate_refs (id, gate_id, channel_type, ref, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [JSON.stringify([gateId, ref.channelType, ref.ref.channelId, ref.ref.messageId]), gateId, ref.channelType, JSON.stringify(ref.ref), Date.now(), Date.now()],
    );
  }

  async updateDecisionGateEntry(
    sessionId: string,
    threadId: string,
    gateId: string,
    patch: Partial<DecisionGateEntry>,
  ): Promise<void> {
    const result = await this.db.query(
      "SELECT * FROM engine_entries WHERE session_id = $1 AND thread_id = $2 AND gate_id = $3",
      [sessionId, threadId, gateId],
    );
    for (const raw of result.rows) {
      const row = rawToEntryRow(raw);
      const current = rowToEntry(row);
      if (current.type !== "decision_gate") continue;
      const merged: DecisionGateEntry = {
        ...current,
        ...patch,
        gate: patch.gate ?? current.gate,
      };
      const newRow = entryToRow(merged);
      await this.db.query(
        "UPDATE engine_entries SET metadata = $1, resolved_at = $2, resolution = $3, withdrawn_reason = $4 WHERE id = $5",
        [newRow.metadata, newRow.resolvedAt, newRow.resolution, newRow.withdrawnReason, row.id],
      );
    }
  }

  async saveSuspendedTurn(
    sessionId: string,
    threadId: string,
    s: SuspendedTurnState,
    fence?: WriteFence,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.checkFenceTx(tx, fence);
      await tx.query(
        `INSERT INTO engine_suspended_turns (
           session_id, thread_id, queue_item_id, gate_id, model, leaf_entry_id,
           tool_call_id, tool_name, tool_args, resume_key, ordinal, attempt, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (session_id, thread_id) DO UPDATE SET
           queue_item_id = EXCLUDED.queue_item_id,
           gate_id = EXCLUDED.gate_id,
           model = EXCLUDED.model,
           leaf_entry_id = EXCLUDED.leaf_entry_id,
           tool_call_id = EXCLUDED.tool_call_id,
           tool_name = EXCLUDED.tool_name,
           tool_args = EXCLUDED.tool_args,
           resume_key = EXCLUDED.resume_key,
           ordinal = EXCLUDED.ordinal,
           attempt = EXCLUDED.attempt`,
        [
          sessionId,
          threadId,
          s.queueItemId,
          s.gateId,
          s.model,
          s.leafMessageId ?? null,
          s.toolCallId,
          s.toolName,
          JSON.stringify(s.toolArgs),
          s.resumeKey,
          s.ordinal,
          s.attempt,
          s.createdAt,
        ],
      );
    });
  }

  async clearSuspendedTurn(sessionId: string, threadId: string, fence?: WriteFence): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.checkFenceTx(tx, fence);
      await tx.query("DELETE FROM engine_suspended_turns WHERE session_id = $1 AND thread_id = $2", [
        sessionId,
        threadId,
      ]);
    });
  }

  async updateSessionStatus(id: string, status: SessionStatus, metadata?: Partial<SessionData>): Promise<void> {
    await this.db.query(
      `UPDATE engine_sessions SET status = $1, sandbox_id = COALESCE($2, sandbox_id),
         snapshot_id = COALESCE($3, snapshot_id), updated_at = $4 WHERE id = $5`,
      [status, metadata?.sandboxId ?? null, metadata?.snapshotId ?? null, Date.now(), id],
    );
  }

  async getSession(id: string): Promise<SessionData | null> {
    const result = await this.db.query("SELECT * FROM engine_sessions WHERE id = $1", [id]);
    const raw = result.rows[0];
    return raw ? rowToSession(rawToSessionRow(raw)) : null;
  }

  async listSessions(userId: string, opts?: ListOpts): Promise<SessionData[]> {
    const result = await this.db.query("SELECT * FROM engine_sessions WHERE user_id = $1", [userId]);
    let list = result.rows.map((r) => rowToSession(rawToSessionRow(r)));
    if (opts?.status) list = list.filter((s) => s.status === opts.status);
    return list;
  }

  async getThreadSnapshot(
    sessionId: string,
    threadId: string,
  ): Promise<{ thread: ThreadData; entries: SessionEntry[] } | null> {
    return this.db.transaction(async (tx) => {
      // Lock the thread row before reading entries. appendEntries updates this
      // row last, so the pair is either wholly before or wholly after an append.
      const threadResult = await tx.query(
        "SELECT * FROM engine_threads WHERE session_id = $1 AND id = $2 FOR SHARE",
        [sessionId, threadId],
      );
      const rawThread = threadResult.rows[0];
      if (!rawThread) return null;
      const entryResult = await tx.query(
        "SELECT * FROM engine_entries WHERE session_id = $1 AND thread_id = $2 ORDER BY created_at ASC, seq ASC",
        [sessionId, threadId],
      );
      return {
        thread: rowToThread(rawToThreadRow(rawThread)),
        entries: entryResult.rows.map(rawToEntryRow).map(rowToEntry),
      };
    });
  }

  async getThread(sessionId: string, threadId: string): Promise<ThreadData | null> {
    const result = await this.db.query("SELECT * FROM engine_threads WHERE session_id = $1 AND id = $2", [
      sessionId,
      threadId,
    ]);
    const raw = result.rows[0];
    return raw ? rowToThread(rawToThreadRow(raw)) : null;
  }

  async listThreads(sessionId: string): Promise<ThreadData[]> {
    const result = await this.db.query("SELECT * FROM engine_threads WHERE session_id = $1", [sessionId]);
    return result.rows.map((r) => rowToThread(rawToThreadRow(r)));
  }

  async getEntries(sessionId: string, threadId: string, opts?: MessageQuery): Promise<SessionEntry[]> {
    return withSpan(
      "store.entries.read",
      { "valet.session.id": sessionId, "valet.thread.id": threadId },
      async (span) => {
        // created_at (epoch-ms) is the primary sort, but same-millisecond ties are
        // routine within one turn, so seq — a monotonic insertion counter — breaks
        // them in insertion order (TKAI-303). Without it Postgres may return a tie
        // in any order, which surfaced as chat bubbles rendering out of sequence.
        const result = await this.db.query(
          "SELECT * FROM engine_entries WHERE session_id = $1 AND thread_id = $2 ORDER BY created_at ASC, seq ASC",
          [sessionId, threadId],
        );
        let rows = result.rows.map(rawToEntryRow);
        if (opts?.includeCompacted === false) rows = rows.filter((r) => r.entryType !== "compaction");
        if (opts?.limit && opts.limit > 0) rows = rows.slice(-opts.limit);
        span.setAttribute("valet.entries.loaded", rows.length);
        if (span.isRecording()) {
          span.setAttribute("valet.entries.parts_bytes", rows.reduce(
            (bytes, row) => bytes + (row.parts === null ? 0 : Buffer.byteLength(row.parts, "utf8")), 0,
          ));
        }
        return rows.map(rowToEntry);
      },
    );
  }

  async listDecisionGates(sessionId: string, threadId?: string, status?: DecisionGate["status"]): Promise<DecisionGate[]> {
    const params = [sessionId];
    const conditions = ["session_id = $1"];
    if (threadId !== undefined) {
      params.push(threadId);
      conditions.push(`thread_id = $${params.length}`);
    }
    if (status !== undefined) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    const result = await this.db.query(`SELECT * FROM engine_decision_gates WHERE ${conditions.join(" AND ")}`, params);
    return result.rows.map((r) => rowToGate(rawToGateRow(r)));
  }

  async getDecisionGate(sessionId: string, gateId: string): Promise<DecisionGate | null> {
    const result = await this.db.query("SELECT * FROM engine_decision_gates WHERE session_id = $1 AND id = $2", [
      sessionId,
      gateId,
    ]);
    const raw = result.rows[0];
    return raw ? rowToGate(rawToGateRow(raw)) : null;
  }

  async listDecisionGatesForQueueItem(
    sessionId: string,
    threadId: string,
    queueItemId: string,
  ): Promise<DecisionGate[]> {
    const result = await this.db.query(
      `SELECT * FROM engine_decision_gates
       WHERE session_id = $1 AND thread_id = $2 AND queue_item_id = $3`,
      [sessionId, threadId, queueItemId],
    );
    return result.rows.map((raw) => rowToGate(rawToGateRow(raw)));
  }

  async getLatestGateForResume(
    sessionId: string,
    threadId: string,
    queueItemId: string,
    resumeKey: string,
  ): Promise<DecisionGate | null> {
    const result = await this.db.query(
      `SELECT * FROM engine_decision_gates
       WHERE session_id = $1 AND thread_id = $2 AND queue_item_id = $3 AND resume_key = $4
       ORDER BY ordinal DESC LIMIT 1`,
      [sessionId, threadId, queueItemId, resumeKey],
    );
    const raw = result.rows[0];
    return raw ? rowToGate(rawToGateRow(raw)) : null;
  }

  async getSuspendedTurn(sessionId: string, threadId: string): Promise<SuspendedTurnState | null> {
    const result = await this.db.query(
      "SELECT * FROM engine_suspended_turns WHERE session_id = $1 AND thread_id = $2",
      [sessionId, threadId],
    );
    const raw = result.rows[0];
    if (!raw) return null;
    const row = rawToSuspendedTurnRow(raw);
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
      ordinal: row.ordinal,
      attempt: row.attempt,
      createdAt: row.createdAt,
    };
  }

  // === Submission lifecycle (durable execution) ===

  /**
   * Resolves the dispatchId dedup outcome once an existing row with the
   * same (sessionId, dispatchId) is found: same content → return it
   * (idempotent replay), different content → ConflictError. Shared by the
   * in-transaction pre-check (the common case: same thread, or a prior
   * admission already visible) and the post-unique-violation fallback in
   * `admitSubmission` (the cross-thread race: two threads' admissions each
   * lock a different `engine_threads` row, so neither serializes against
   * the other, and both can pass the pre-check before either inserts).
   */
  private resolveDispatchDedup(raw: Record<string, unknown>, item: QueueItem): QueueItem {
    const existingItem = queueItemRowToItem(rawToQueueItemRow(raw));
    const sameContent = JSON.stringify(existingItem.content) === JSON.stringify(item.content);
    if (sameContent) return existingItem;
    throw new ConflictError(`dispatchId ${item.dispatchId} already admitted with different content`, {
      dispatchId: item.dispatchId,
      existingItemId: existingItem.id,
    });
  }

  async admitSubmission(
    sessionId: string,
    threadId: string,
    item: QueueItem,
    opts?: SubmissionAdmissionOptions,
  ): Promise<{ item: QueueItem; admitted: boolean; supersededItemIds: string[] }> {
    let deduped: QueueItem | null;
    let admittedItem: QueueItem | null;
    let supersededItemIds: string[];
    try {
      ({ deduped, admittedItem, supersededItemIds } = await this.db.transaction(
        async (tx): Promise<{
          deduped: QueueItem | null;
          admittedItem: QueueItem | null;
          supersededItemIds: string[];
        }> => {
          // Serialize admissions for this thread. The dispatchId dedup check,
          // pending-cap count, and insert must all observe the same snapshot
          // as a concurrent admission for the same thread — analogous to
          // decision 6's event-seq translation, which locks a stable
          // always-present row (there, engine_sessions; here, engine_threads,
          // which saveThread guarantees exists before any queue item can be
          // admitted) rather than a not-yet-existing queue-item row.
          await tx.query("SELECT id FROM engine_threads WHERE id = $1 FOR UPDATE", [threadId]);

          if (item.dispatchId) {
            const existing = await tx.query(
              "SELECT * FROM engine_queue_items WHERE session_id = $1 AND dispatch_id = $2",
              [sessionId, item.dispatchId],
            );
            const raw = existing.rows[0];
            if (raw) {
              return {
                deduped: this.resolveDispatchDedup(raw, item),
                admittedItem: null,
                supersededItemIds: [],
              };
            }
          }

          if (opts?.maxPending !== undefined) {
            const countResult = await tx.query(PENDING_COUNT_SQL, [sessionId, threadId]);
            const count = toNum(countResult.rows[0]?.count, "count");
            if (count >= opts.maxPending) {
              throw new PendingCapError(threadId, opts.maxPending);
            }
          }

          const promotionScope = opts?.steerScope === "active-and-source";
          if (promotionScope && (!opts.steer || !opts.promoteFromItemId)) {
            throw new ValidationError("Promotion steering requires steer and promoteFromItemId.");
          }
          let lockedPending: QueueItem[] = [];
          if (promotionScope) {
            // Lock every runnable candidate before inserting the promoted
            // head. A claim that won first is observed as running and gets
            // superseded; a claim that lost waits, then sees the new head.
            const pending = await tx.query(PROMOTION_PENDING_SQL, [sessionId, threadId]);
            lockedPending = pending.rows.map((raw) =>
              queueItemRowToItem(rawToQueueItemRow(raw)),
            );
          }

          if (opts?.promoteFromItemId) {
            let srcItem: QueueItem | null | undefined;
            if (promotionScope) {
              srcItem = lockedPending.find(
                (candidate) => candidate.id === opts.promoteFromItemId,
              );
            } else {
              const source = await tx.query(
                "SELECT * FROM engine_queue_items WHERE session_id = $1 AND id = $2 FOR UPDATE",
                [sessionId, opts.promoteFromItemId],
              );
              const raw = source.rows[0];
              srcItem = raw ? queueItemRowToItem(rawToQueueItemRow(raw)) : null;
            }
            if (
              !srcItem ||
              srcItem.threadId !== threadId ||
              srcItem.status !== "queued" ||
              srcItem.supersededByItemId
            ) {
              throw new ValidationError(
                "That message is no longer queued. Send a new message, or wait for the current turn to finish.",
              );
            }
          }

          const queuedCreatedAt = promotionScope
            ? lockedPending
                .filter((candidate) => candidate.status === "queued")
                .map((candidate) => candidate.createdAt)
            : [];
          // Queue order is createdAt + id. Move the successor just ahead
          // of the oldest queued sibling; the validated source guarantees a
          // non-empty set.
          const promotedCreatedAt = promotionScope
            ? Math.min(...queuedCreatedAt) - 1
            : item.createdAt;
          const itemToInsert: QueueItem = { ...item, createdAt: promotedCreatedAt };
          await tx.query(
            INSERT_QUEUE_ITEM_SQL,
            queueItemInsertParams(sessionId, threadId, itemToInsert),
          );

          const superseded: string[] = [];
          if (opts?.steer) {
            const ids = promotionScope
              ? lockedPending
                  .filter(
                    (candidate) =>
                      candidate.id === opts.promoteFromItemId ||
                      candidate.status === "running" ||
                      candidate.status === "blocked_on_decision_gate",
                  )
                  .map((candidate) => candidate.id)
              : (
                  await tx.query(STEER_CANDIDATES_SQL, [
                    sessionId,
                    threadId,
                    itemToInsert.id,
                    itemToInsert.createdAt,
                  ])
                ).rows.map(rowId);
            if (ids.length > 0) {
              await tx.query(
                `UPDATE engine_queue_items SET superseded_by_item_id = $1, updated_at = $2 WHERE id = ANY($3::text[])`,
                [item.id, Date.now(), ids],
              );
              superseded.push(...ids);
            }
          }
          return { deduped: null, admittedItem: itemToInsert, supersededItemIds: superseded };
        },
      ));
    } catch (err) {
      // Cross-thread dispatch-dedup race: this admission's own thread lock
      // (engine_threads WHERE id = threadId) doesn't serialize against a
      // concurrent admission on a *different* thread of the same session,
      // so two admissions racing the same dispatchId on different threads
      // can both pass the pre-check above and both attempt the insert. The
      // `(session_id, dispatch_id)` partial unique index is what actually
      // arbitrates the race; the loser here re-reads the winner's row and
      // dedups against it idempotently — same outcome sqlite's whole-DB
      // lock gave for free, just reached via the constraint instead of a
      // pre-check when the two calls fall on the same thread.
      if (item.dispatchId && isPgUniqueViolation(err)) {
        const existing = await this.db.query(
          "SELECT * FROM engine_queue_items WHERE session_id = $1 AND dispatch_id = $2",
          [sessionId, item.dispatchId],
        );
        const raw = existing.rows[0];
        if (raw) {
          return { item: this.resolveDispatchDedup(raw, item), admitted: false, supersededItemIds: [] };
        }
      }
      throw err;
    }

    if (deduped) {
      return { item: deduped, admitted: false, supersededItemIds: [] };
    }
    return { item: { ...(admittedItem ?? item) }, admitted: true, supersededItemIds };
  }

  async claimSubmission(claim: SubmissionClaim): Promise<QueueItem | null> {
    const now = Date.now();
    const result = await this.db.query(CLAIM_SQL, [
      claim.attemptId,
      claim.ownerId,
      now + (claim.leaseDurationMs ?? DEFAULT_LEASE_MS),
      now,
      claim.itemId,
      claim.sessionId,
      claim.threadId,
    ]);
    if (result.rowCount === 0) return null;
    return this.getQueueItem(claim.sessionId, claim.itemId);
  }

  async replaceSubmissionAttempt(
    sessionId: string,
    threadId: string,
    itemId: string,
    claim: SubmissionClaim,
    opts: { expectedAttemptId: string },
  ): Promise<QueueItem | null> {
    const now = Date.now();
    const result = await this.db.query(REPLACE_ATTEMPT_SQL, [
      claim.attemptId,
      claim.ownerId,
      now + (claim.leaseDurationMs ?? DEFAULT_LEASE_MS),
      now,
      itemId,
      sessionId,
      threadId,
      opts.expectedAttemptId,
    ]);
    if (result.rowCount === 0) return null;
    return this.getQueueItem(sessionId, itemId);
  }

  async insertAttemptMarker(itemId: string, attemptId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO engine_attempt_markers (item_id, attempt_id, created_at)
       VALUES ($1, $2, $3) ON CONFLICT (item_id, attempt_id) DO NOTHING`,
      [itemId, attemptId, Date.now()],
    );
  }

  async deleteAttemptMarker(itemId: string, attemptId: string): Promise<void> {
    await this.db.query("DELETE FROM engine_attempt_markers WHERE item_id = $1 AND attempt_id = $2", [
      itemId,
      attemptId,
    ]);
  }

  async hasAttemptMarker(itemId: string, attemptId: string): Promise<boolean> {
    const result = await this.db.query(
      "SELECT 1 FROM engine_attempt_markers WHERE item_id = $1 AND attempt_id = $2 LIMIT 1",
      [itemId, attemptId],
    );
    return result.rows.length > 0;
  }

  async renewLeases(ownerId: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    const now = Date.now();
    await this.db.query(
      `UPDATE engine_queue_items SET lease_expires_at = $1, updated_at = $2
       WHERE owner_id = $3 AND id = ANY($4::text[])`,
      [now + DEFAULT_LEASE_MS, now, ownerId, itemIds],
    );
  }

  async listExpiredSubmissions(now: number): Promise<QueueItem[]> {
    const result = await this.db.query(
      `SELECT * FROM engine_queue_items
       WHERE status IN ('running', 'blocked_on_decision_gate')
         AND lease_expires_at IS NOT NULL AND lease_expires_at < $1`,
      [now],
    );
    return result.rows.map((r) => queueItemRowToItem(rawToQueueItemRow(r)));
  }

  async listUnsettledSubmissions(sessionId: string): Promise<QueueItem[]> {
    const result = await this.db.query("SELECT * FROM engine_queue_items WHERE session_id = $1 AND status != 'settled'", [
      sessionId,
    ]);
    return result.rows.map((r) => queueItemRowToItem(rawToQueueItemRow(r)));
  }

  async listSessionIdsWithUnsettledSubmissions(): Promise<string[]> {
    const result = await this.db.query("SELECT DISTINCT session_id FROM engine_queue_items WHERE status != 'settled'");
    return result.rows.map((r) => {
      const v = r.session_id;
      if (typeof v !== "string") throw new Error("expected string session_id");
      return v;
    });
  }

  async listSettledSubmissionsBefore(sessionId: string, cutoff: number): Promise<QueueItem[]> {
    const result = await this.db.query(
      "SELECT * FROM engine_queue_items WHERE session_id = $1 AND status = 'settled' AND updated_at < $2",
      [sessionId, cutoff],
    );
    return result.rows.map((r) => queueItemRowToItem(rawToQueueItemRow(r)));
  }

  async getQueueItem(sessionId: string, itemId: string): Promise<QueueItem | null> {
    const result = await this.db.query("SELECT * FROM engine_queue_items WHERE session_id = $1 AND id = $2", [
      sessionId,
      itemId,
    ]);
    const raw = result.rows[0];
    return raw ? queueItemRowToItem(rawToQueueItemRow(raw)) : null;
  }

  async latestActivityAt(sessionId: string): Promise<number | null> {
    // MAX(updated_at) is NULL when the session has no queue items — toNumOrNull
    // maps that to null. updated_at is a bigint ms column, so it must funnel
    // through toNum* (never a raw cast) per the store's numeric-column rule.
    const result = await this.db.query(
      "SELECT MAX(updated_at) as latest FROM engine_queue_items WHERE session_id = $1",
      [sessionId],
    );
    return toNumOrNull(result.rows[0]?.latest, "latest");
  }

  async listAllUnsettledSubmissions(sessionIds?: readonly string[]): Promise<(QueueItem & { sessionId: string })[]> {
    if (sessionIds !== undefined) {
      const items: (QueueItem & { sessionId: string })[] = [];
      const ids = [...new Set(sessionIds)];
      for (let offset = 0; offset < ids.length; offset += 1_000) {
        const batch = ids.slice(offset, offset + 1_000);
        const result = await this.db.query(
          `SELECT * FROM engine_queue_items WHERE status != 'settled' AND session_id IN (${batch.map((_, i) => `$${i + 1}`).join(",")})`,
          batch,
        );
        for (const r of result.rows) {
          const row = rawToQueueItemRow(r);
          items.push({ ...queueItemRowToItem(row), sessionId: row.sessionId });
        }
      }
      return items;
    }
    const result = await this.db.query("SELECT * FROM engine_queue_items WHERE status != 'settled'");
    return result.rows.map((r) => {
      const row = rawToQueueItemRow(r);
      return { ...queueItemRowToItem(row), sessionId: row.sessionId };
    });
  }

  async forceSettle(
    sessionId: string,
    itemId: string,
    outcome: "failed" | "aborted",
    error?: string,
  ): Promise<QueueItem> {
    const now = Date.now();
    return this.db.transaction(async (tx) => {
      const existing = await tx.query("SELECT * FROM engine_queue_items WHERE session_id = $1 AND id = $2 FOR UPDATE", [
        sessionId,
        itemId,
      ]);
      const raw = existing.rows[0];
      if (!raw) throw new NotFoundError("queue item", { sessionId, itemId });
      const row = rawToQueueItemRow(raw);
      if (row.status === "settled") {
        throw new ConflictError(`queue item ${itemId} is already settled`, { sessionId, itemId });
      }
      await tx.query(
        `UPDATE engine_queue_items SET status = 'settled', outcome = $1, error = $2, updated_at = $3
         WHERE session_id = $4 AND id = $5`,
        [outcome, error ?? null, now, sessionId, itemId],
      );
      await tx.query("DELETE FROM engine_attempt_markers WHERE item_id = $1", [itemId]);
      const final = await tx.query("SELECT * FROM engine_queue_items WHERE session_id = $1 AND id = $2", [
        sessionId,
        itemId,
      ]);
      const finalRaw = final.rows[0];
      if (!finalRaw) throw new NotFoundError("queue item", { sessionId, itemId });
      return queueItemRowToItem(rawToQueueItemRow(finalRaw));
    });
  }

  async requestAbort(sessionId: string, threadId?: string, queueItemId?: string): Promise<void> {
    const now = Date.now();
    if (queueItemId) {
      await this.db.query(
        `UPDATE engine_queue_items SET abort_requested_at = $1, updated_at = $2
         WHERE session_id = $3 AND id = $4 AND ($5::text IS NULL OR thread_id = $5)
           AND status != 'settled' AND abort_requested_at IS NULL`,
        [now, now, sessionId, queueItemId, threadId ?? null],
      );
    } else     if (threadId) {
      await this.db.query(
        `UPDATE engine_queue_items SET abort_requested_at = $1, updated_at = $2
         WHERE session_id = $3 AND thread_id = $4 AND status != 'settled' AND abort_requested_at IS NULL`,
        [now, now, sessionId, threadId],
      );
    } else {
      await this.db.query(
        `UPDATE engine_queue_items SET abort_requested_at = $1, updated_at = $2
         WHERE session_id = $3 AND status != 'settled' AND abort_requested_at IS NULL`,
        [now, now, sessionId],
      );
    }
  }

  async requestAbortActiveSubmission(
    sessionId: string,
    threadId: string,
    queueItemId: string,
  ): Promise<QueueItem | null> {
    const result = await this.db.query(ABORT_ACTIVE_SUBMISSION_SQL, [
      Date.now(),
      sessionId,
      threadId,
      queueItemId,
    ]);
    const raw = result.rows[0];
    return raw ? queueItemRowToItem(rawToQueueItemRow(raw)) : null;
  }

  async reserveSettlement(
    sessionId: string,
    threadId: string,
    itemId: string,
    outcome: SubmissionOutcome,
    fence: WriteFence,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.lockAndCheckFence(tx, sessionId, threadId, itemId, fence);
      if (row.status === "terminalizing" || row.status === "settled") {
        const existing: SubmissionOutcome | undefined = row.outcome
          ? { outcome: row.outcome as SubmissionOutcome["outcome"], error: row.error ?? undefined }
          : undefined;
        const sameOutcome = JSON.stringify(existing) === JSON.stringify(outcome);
        if (sameOutcome) return; // idempotent re-reserve
        throw new ConflictError(`queue item ${itemId} already reserved with a different outcome`, {
          itemId,
          existingOutcome: existing,
          newOutcome: outcome,
        });
      }
      await tx.query(
        `UPDATE engine_queue_items SET status = 'terminalizing', outcome = $1, error = $2, updated_at = $3 WHERE id = $4`,
        [outcome.outcome, outcome.error ?? null, Date.now(), itemId],
      );
    });
  }

  async finalizeSettlement(
    sessionId: string,
    threadId: string,
    itemId: string,
    fence: WriteFence,
    patchRef?: SettlePatchRef,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.lockAndCheckFence(tx, sessionId, threadId, itemId, fence);
      if (row.status === "settled") return; // idempotent
      if (patchRef) {
        await tx.query(
          `UPDATE engine_queue_items SET status = 'settled',
             settle_patch_status = $1, settle_patch_reason = $2,
             settle_patch_blob_key = $3, settle_patch_bytes = $4,
             settle_patch_truncated = $5, updated_at = $6
           WHERE id = $7`,
          [
            patchRef.status,
            patchRef.reason ?? null,
            patchRef.blobKey ?? null,
            patchRef.bytes ?? null,
            patchRef.truncated ? 1 : 0,
            Date.now(),
            itemId,
          ],
        );
        return;
      }
      await tx.query(`UPDATE engine_queue_items SET status = 'settled', updated_at = $1 WHERE id = $2`, [
        Date.now(),
        itemId,
      ]);
    });
  }

  async settleUnclaimed(
    sessionId: string,
    threadId: string,
    itemId: string,
    outcome: SubmissionOutcome,
    opts?: { mergedIntoItemId?: string },
  ): Promise<boolean> {
    const mergedIntoItemId = outcome.outcome === "merged" ? (opts?.mergedIntoItemId ?? null) : null;
    // Never-claimed items definitionally ran no tools — stamp the settle-patch
    // skip so offline readers can tell "no work" from "predates patch capture".
    const result = await this.db.query(
      `UPDATE engine_queue_items
       SET status = 'settled', outcome = $1, error = $2,
           merged_into_item_id = COALESCE($3, merged_into_item_id),
           settle_patch_status = 'skipped', settle_patch_reason = 'no_work',
           updated_at = $4
       WHERE id = $5 AND session_id = $6 AND thread_id = $7 AND status IN ('collecting', 'queued')`,
      [outcome.outcome, outcome.error ?? null, mergedIntoItemId, Date.now(), itemId, sessionId, threadId],
    );
    return result.rowCount > 0;
  }

  async releaseSubmission(
    sessionId: string,
    threadId: string,
    itemId: string,
    fence: WriteFence,
    credential?: { attempts: number; lastReleaseAt: number },
  ): Promise<boolean> {
    // CAS release + marker delete must be atomic: a crash between the two
    // would leave a queued item with a live-looking attempt marker (InMemory
    // is already atomic; PG must match). The marker is deleted ONLY when the
    // CAS matched — a stale caller's release is a full no-op that touches no
    // marker at all. `superseded_by_item_id IS NULL` and
    // `abort_requested_at IS NULL` are part of the CAS: a superseded item
    // released to `queued` would be an orphan (skipped by the claim head),
    // and an abort stamped mid-window must settle `aborted` under the
    // current attempt rather than flickering running→queued→aborted on the
    // queue-state stream — both refuse and report the miss to the caller.
    // `attempt_count` is DECREMENTED (floor 0) in the CREDENTIAL branch only:
    // a keyless release cycle never consumed run budget (must not trip the
    // stuck-head signal or exhaust decideReconciliation's maxAttempts), and
    // those cycles are separately bounded by the durable credential budget.
    // A plain release (reconciliation's fresh re-run of a crashed pre-stream
    // attempt) keeps the increment — otherwise a deterministically
    // crash-looping item oscillates attempt_count net-zero and NEVER exhausts
    // the generic retry budget.
    // The matched flag is RETURNED from the transaction callback, never
    // hoisted into outer state: the node-postgres wrapper retries the whole
    // callback on serialization failures (40P01), and a mutated outer
    // variable would leak a stale first-try value across the retry.
    return this.db.transaction(async (tx) => {
      // The durable credential budget rides the same CAS UPDATE: counters
      // land iff the release lands (no partial write on a refused CAS).
      const result = credential
        ? await tx.query(
            `UPDATE engine_queue_items
             SET status = 'queued', attempt_id = NULL, owner_id = NULL, lease_expires_at = NULL,
                 attempt_count = GREATEST(attempt_count - 1, 0),
                 credential_attempts = $6, last_credential_release_at = $7, updated_at = $1
             WHERE id = $2 AND session_id = $3 AND thread_id = $4 AND status = 'running' AND attempt_id = $5
               AND superseded_by_item_id IS NULL AND abort_requested_at IS NULL`,
            [
              Date.now(),
              itemId,
              sessionId,
              threadId,
              fence.attemptId,
              credential.attempts,
              credential.lastReleaseAt,
            ],
          )
        : await tx.query(
            `UPDATE engine_queue_items
             SET status = 'queued', attempt_id = NULL, owner_id = NULL, lease_expires_at = NULL, updated_at = $1
             WHERE id = $2 AND session_id = $3 AND thread_id = $4 AND status = 'running' AND attempt_id = $5
               AND superseded_by_item_id IS NULL AND abort_requested_at IS NULL`,
            [Date.now(), itemId, sessionId, threadId, fence.attemptId],
          );
      if (result.rowCount === 0) return false;
      await tx.query("DELETE FROM engine_attempt_markers WHERE item_id = $1 AND attempt_id = $2", [
        itemId,
        fence.attemptId,
      ]);
      return true;
    });
  }

  async setSubmissionBlocked(
    sessionId: string,
    threadId: string,
    itemId: string,
    blocked: boolean,
    fence: WriteFence,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.lockAndCheckFence(tx, sessionId, threadId, itemId, fence);
      const expected: QueueItem["status"] = blocked ? "running" : "blocked_on_decision_gate";
      if (row.status !== expected) {
        throw new ConflictError(
          `cannot set blocked=${blocked} on queue item ${itemId} in status '${row.status}' (requires '${expected}')`,
          { itemId, status: row.status, blocked },
        );
      }
      const nextStatus: QueueItem["status"] = blocked ? "blocked_on_decision_gate" : "running";
      await tx.query(`UPDATE engine_queue_items SET status = $1, updated_at = $2 WHERE id = $3`, [
        nextStatus,
        Date.now(),
        itemId,
      ]);
    });
  }

  async deleteSession(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Lock every queue-item row of the session before deleting so a
      // concurrent single-statement CAS (claimSubmission, settleUnclaimed,
      // etc.) either lands before this transaction opens or blocks until it
      // commits (rowCount=0 or NotFoundError on the now-deleted item) —
      // never interleaves.
      await tx.query("SELECT id FROM engine_queue_items WHERE session_id = $1 FOR UPDATE", [id]);
      await tx.query(
        "DELETE FROM engine_attempt_markers WHERE item_id IN (SELECT id FROM engine_queue_items WHERE session_id = $1)",
        [id],
      );
      await tx.query("DELETE FROM engine_entries WHERE session_id = $1", [id]);
      await tx.query("DELETE FROM engine_queue_items WHERE session_id = $1", [id]);
      await tx.query("DELETE FROM engine_decision_gates WHERE session_id = $1", [id]);
      await tx.query("DELETE FROM engine_suspended_turns WHERE session_id = $1", [id]);
      await tx.query("DELETE FROM engine_threads WHERE session_id = $1", [id]);
      await tx.query("DELETE FROM engine_events WHERE session_id = $1", [id]);
      await tx.query("DELETE FROM engine_sessions WHERE id = $1", [id]);
    });
  }
}

function rowToSession(r: SessionRow): SessionData {
  return {
    id: r.id,
    owner: { type: r.ownerType as Principal["type"], id: r.ownerId },
    userId: r.userId,
    orgId: r.orgId,
    workspace: r.workspace,
    purpose: r.purpose as SessionData["purpose"],
    status: r.status as SessionData["status"],
    sandboxId: r.sandboxId ?? undefined,
    snapshotId: r.snapshotId ?? undefined,
    parentSessionId: r.parentSessionId ?? undefined,
    parentThreadId: r.parentThreadId ?? undefined,
    model: r.model ?? undefined,
    reasoning: r.reasoning ?? undefined,
    metadata: parseJson(r.metadata),
    startRef: parseJson(r.startRef),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function rowToThread(r: ThreadRow): ThreadData {
  return {
    id: r.id,
    sessionId: r.sessionId,
    key: r.key,
    status: r.status as ThreadData["status"],
    activeLeafEntryId: r.activeLeafEntryId ?? undefined,
    queueMode: r.queueMode as ThreadData["queueMode"],
    paused: r.paused === null || r.paused === undefined ? undefined : Boolean(r.paused),
    model: r.model ?? undefined,
    reasoning: r.reasoning ?? undefined,
    summary: r.summary ?? undefined,
    metadata: parseJson(r.metadata),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
