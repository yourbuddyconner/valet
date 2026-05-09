import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

// ─── Identity ───────────────────────────────────────────────────────────────

export const orgs = sqliteTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  role: text("role", { enum: ["admin", "member"] }).notNull(),
  createdAt: integer("created_at").notNull(),
});

export const orgMembers = sqliteTable(
  "org_members",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

// ─── Agent sessions ─────────────────────────────────────────────────────────
//
// One row per session the user creates from the UI. The engine maintains its
// own internal state in `engine_sessions`/`engine_threads`/`engine_entries`
// (managed by @valet/store-sqlite). This table holds only what the UI cares
// about: human-visible metadata, workspace path, status.

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    workspace: text("workspace").notNull(),
    title: text("title"),
    status: text("status", {
      enum: ["active", "archived", "deleted"],
    })
      .notNull()
      .default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("agent_sessions_user").on(t.userId),
    index("agent_sessions_status").on(t.status),
  ],
);

// Threads — the UI groups messages by thread. The engine has its own thread
// concept too; here we mirror just the fields the chat list needs.
export const sessionThreads = sqliteTable(
  "session_threads",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    title: text("title"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("session_threads_session").on(t.sessionId)],
);

// Messages — the visible chat log. Each row is a single message the UI
// renders. `parts` is JSON-encoded MessagePart[] (text/tool_use/tool_result).
// `content` is the flat-string projection for legacy/simple consumers.
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id"),
    role: text("role", {
      enum: ["user", "assistant", "system", "tool"],
    }).notNull(),
    content: text("content").notNull(),
    parts: text("parts"),
    authorId: text("author_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("messages_session").on(t.sessionId),
    index("messages_thread").on(t.threadId),
    index("messages_created").on(t.createdAt),
  ],
);

// ─── Inferred row types ─────────────────────────────────────────────────────

export type OrgRow = typeof orgs.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type OrgMemberRow = typeof orgMembers.$inferSelect;
export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type SessionThreadRow = typeof sessionThreads.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
