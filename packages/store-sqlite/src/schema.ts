import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

export const engineSessions = sqliteTable(
  "engine_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    workspace: text("workspace").notNull(),
    purpose: text("purpose").notNull(),
    status: text("status").notNull(),
    sandboxId: text("sandbox_id"),
    snapshotId: text("snapshot_id"),
    parentSessionId: text("parent_session_id"),
    /** Persisted session-default model id (e.g. "claude-haiku-4-5"). Null
     *  means "use the host's global default". Mutated via Session.setModel. */
    model: text("model"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("engine_sessions_user").on(t.userId),
    index("engine_sessions_status").on(t.status),
  ],
);

export const engineThreads = sqliteTable(
  "engine_threads",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    key: text("key").notNull(),
    status: text("status").notNull(),
    activeLeafEntryId: text("active_leaf_entry_id"),
    queueMode: text("queue_mode").notNull(),
    model: text("model"),
    summary: text("summary"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("engine_threads_session").on(t.sessionId),
    index("engine_threads_session_key").on(t.sessionId, t.key),
  ],
);

export const engineEntries = sqliteTable(
  "engine_entries",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id").notNull(),
    parentId: text("parent_id"),
    entryType: text("entry_type").notNull(),
    role: text("role"),
    content: text("content"),
    parts: text("parts"),
    author: text("author"),
    channel: text("channel"),
    model: text("model"),
    summary: text("summary"),
    coveredEntryIds: text("covered_entry_ids"),
    tokenCountBefore: integer("token_count_before"),
    tokenCountAfter: integer("token_count_after"),
    fileContext: text("file_context"),
    branchRootId: text("branch_root_id"),
    branchLeafId: text("branch_leaf_id"),
    gateId: text("gate_id"),
    resolvedAt: text("resolved_at"),
    resolution: text("resolution"),
    withdrawnReason: text("withdrawn_reason"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("engine_entries_thread").on(t.sessionId, t.threadId, t.createdAt),
    index("engine_entries_gate").on(t.gateId),
  ],
);

export const engineQueueItems = sqliteTable(
  "engine_queue_items",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id").notNull(),
    status: text("status").notNull(),
    mode: text("mode").notNull(),
    content: text("content").notNull(),
    author: text("author"),
    channel: text("channel"),
    replyTarget: text("reply_target"),
    model: text("model"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("engine_queue_items_thread").on(t.sessionId, t.threadId, t.status)],
);

export const engineQueueState = sqliteTable(
  "engine_queue_state",
  {
    threadId: text("thread_id").notNull(),
    sessionId: text("session_id").notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    activeItemId: text("active_item_id"),
    pending: text("pending").notNull(),
    collectBuffer: text("collect_buffer"),
    blockedGateId: text("blocked_gate_id"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.threadId] })],
);

export const engineDecisionGates = sqliteTable(
  "engine_decision_gates",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    actions: text("actions").notNull(),
    origin: text("origin"),
    context: text("context"),
    resolution: text("resolution"),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("engine_decision_gates_thread").on(t.sessionId, t.threadId, t.status)],
);

export const engineDecisionGateRefs = sqliteTable(
  "engine_decision_gate_refs",
  {
    id: text("id").primaryKey(),
    gateId: text("gate_id").notNull(),
    channelType: text("channel_type").notNull(),
    ref: text("ref").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("engine_decision_gate_refs_gate").on(t.gateId)],
);

export const engineSuspendedTurns = sqliteTable(
  "engine_suspended_turns",
  {
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id").notNull(),
    queueItemId: text("queue_item_id").notNull(),
    gateId: text("gate_id").notNull(),
    model: text("model").notNull(),
    leafEntryId: text("leaf_entry_id"),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    toolArgs: text("tool_args").notNull(),
    resumeKey: text("resume_key").notNull(),
    attempt: integer("attempt").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.threadId] }),
    index("engine_suspended_turns_gate").on(t.gateId),
  ],
);
