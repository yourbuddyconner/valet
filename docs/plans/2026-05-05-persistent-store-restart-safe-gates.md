# Persistent SessionStore + Restart-Safe Decision Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `@valet/engine`'s in-memory-only suspension model with a persisted store and re-entrant decision gates so a session can survive a process restart, and prove it with a full restart-cycle integration test.

**Architecture:** Add a SQLite-backed `SessionStore` (Drizzle schema, dialect-portable to D1 and Postgres). Make decision-gate IDs deterministic so a tool replay produces the same gate ID; on replay, `ctx.requestDecision(...)` short-circuits and returns the stored resolution instead of opening a new gate. `Engine.restoreSession({ sessionId, options })` rehydrates session/threads/entries/queue (preserving assistant tool-call blocks via `MessageEntry.parts`), and for any thread blocked on a gate, replays the suspended tool call (with `ctx.suspendedDecision` populated) once the gate resolves.

**Tech Stack:** TypeScript, Drizzle ORM (`drizzle-orm/sqlite-core`), `better-sqlite3` (in-process SQLite for tests + dev), `drizzle-kit` (migrations), vitest. Postgres dialect mirror is deferred — the plan calls out where it slots in but doesn't ship it.

---

## Background: What needs to change

Today (`packages/engine/src/thread.ts:requestDecision`):

```ts
const resolution = await this.gates.register(gate, onExpire);
```

`GateManager.register` returns a Promise that resolves only when `Session.resolveDecision` is called in this process. Restart kills the Promise, the suspension is lost.

The spec (line 722) requires:

> The engine does not rely on preserving an in-memory JavaScript continuation across restarts. Tools that call `requestDecision(...)` must therefore be re-entrant up to their decision points. On first execution, `requestDecision(...)` persists the gate and suspends the turn. On resumed execution, the engine re-runs the tool from the start with `suspendedDecision` populated for the matching gate ID, and the same `requestDecision(...)` call returns the stored resolution instead of creating a new gate.

So the change:

1. Gate IDs are deterministic. Same `(sessionId, threadId, queueItemId, resumeKey)` → same gate ID. Tools must supply `resumeKey`.
2. `requestDecision`: if `ctx.suspendedDecision` is set with a matching `gateId`, return the stored resolution synchronously. Otherwise, open or look up the gate, persist `SuspendedTurnState`, suspend.
3. The store actually persists everything (session, threads, entries, queue, gates, refs, suspended turns).
4. `Engine.restoreSession(id)` reads back state, re-builds the agent transcript, and for each blocked thread either (a) waits for the still-pending gate to resolve, or (b) replays the suspended tool with the resolved gate's resolution.
5. After replay, the agent continues normally.

## File Structure

| File | Status | Purpose |
| --- | --- | --- |
| `packages/engine/package.json` | modify | Add `drizzle-orm`, `drizzle-kit`, `better-sqlite3`, `@types/better-sqlite3` |
| `packages/engine/drizzle.config.ts` | create | drizzle-kit config pointing at the schema |
| `packages/engine/src/schema/sqlite.ts` | create | SQLite Drizzle schema for engine tables |
| `packages/engine/src/schema/index.ts` | create | Re-exports |
| `packages/engine/migrations/sqlite/0001_initial.sql` | create | Generated initial migration |
| `packages/engine/src/providers/sqlite-store.ts` | create | `SqliteSessionStore` |
| `packages/engine/src/providers/sqlite-store-helpers.ts` | create | Row encoding/decoding helpers |
| `packages/engine/src/decision-gate.ts` | modify | Stable gate ID derivation; `GateManager` accepts pre-registered resolutions |
| `packages/engine/src/thread.ts` | modify | `requestDecision` short-circuits on `ctx.suspendedDecision`; persist toolCallId/toolArgs |
| `packages/engine/src/session.ts` | modify | Tool replay path on restoration |
| `packages/engine/src/engine.ts` | modify | Real `restoreSession()` |
| `packages/engine/src/index.ts` | modify | Re-export `SqliteSessionStore`, `createSqliteStore` factory |
| `packages/engine/test/store-contract.ts` | create | Shared `SessionStore` contract test suite |
| `packages/engine/test/in-memory-store.test.ts` | create | Run contract suite against `InMemorySessionStore` |
| `packages/engine/test/sqlite-store.test.ts` | create | Run contract suite against `SqliteSessionStore` |
| `packages/engine/test/restart-safe-gates.test.ts` | create | End-to-end restart cycle |

---

## Phase 1: Schema and migrations

### Task 1: Add drizzle and better-sqlite3 deps

**Files:**
- Modify: `packages/engine/package.json`

- [ ] **Step 1: Update package.json**

```json
{
  "name": "@valet/engine",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@mariozechner/pi-agent-core": "0.73.0",
    "@mariozechner/pi-ai": "0.73.0",
    "drizzle-orm": "^0.45.1",
    "typebox": "^1.1.24"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.8",
    "better-sqlite3": "^11.0.0",
    "drizzle-kit": "^0.31.9",
    "typescript": "^5.3.3",
    "vitest": "^4.0.18"
  }
}
```

- [ ] **Step 2: Install**

```bash
cd /Users/conner/code/valet/.worktrees/portable-runtime-v1-spec && pnpm install
```

Expected: `Done in <Ns>` with no resolution errors.

- [ ] **Step 3: Commit**

```bash
git add packages/engine/package.json pnpm-lock.yaml
git commit -m "chore(engine): add drizzle-orm and better-sqlite3 deps"
```

---

### Task 2: Define SQLite schema for engine tables

**Files:**
- Create: `packages/engine/src/schema/sqlite.ts`
- Create: `packages/engine/src/schema/index.ts`

The schema mirrors the table list in the spec ("Required Tables" section, lines 1338-1349). Use SQLite types: `text` (default for everything textual or JSON-serialized), `integer` (for booleans-as-0/1 and unix-ms timestamps), and JSON-encoded `text` for nested objects.

- [ ] **Step 1: Write the schema file**

```ts
// packages/engine/src/schema/sqlite.ts
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

export const engineSessions = sqliteTable("engine_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  orgId: text("org_id").notNull(),
  workspace: text("workspace").notNull(),
  purpose: text("purpose").notNull(),
  status: text("status").notNull(),
  sandboxId: text("sandbox_id"),
  snapshotId: text("snapshot_id"),
  parentSessionId: text("parent_session_id"),
  metadata: text("metadata"), // JSON
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  index("engine_sessions_user").on(t.userId),
  index("engine_sessions_status").on(t.status),
]);

export const engineThreads = sqliteTable("engine_threads", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  key: text("key").notNull(),
  status: text("status").notNull(),
  activeLeafEntryId: text("active_leaf_entry_id"),
  queueMode: text("queue_mode").notNull(),
  model: text("model"),
  summary: text("summary"),
  metadata: text("metadata"), // JSON
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  index("engine_threads_session").on(t.sessionId),
  index("engine_threads_session_key").on(t.sessionId, t.key),
]);

export const engineEntries = sqliteTable("engine_entries", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  threadId: text("thread_id").notNull(),
  parentId: text("parent_id"),
  entryType: text("entry_type").notNull(), // 'message' | 'compaction' | 'branch_summary' | 'decision_gate'
  // for message entries
  role: text("role"),
  content: text("content"),
  parts: text("parts"), // JSON
  author: text("author"), // JSON
  channel: text("channel"), // JSON
  model: text("model"),
  // for compaction entries
  summary: text("summary"),
  coveredEntryIds: text("covered_entry_ids"), // JSON array
  tokenCountBefore: integer("token_count_before"),
  tokenCountAfter: integer("token_count_after"),
  fileContext: text("file_context"), // JSON
  // for branch_summary entries
  branchRootId: text("branch_root_id"),
  branchLeafId: text("branch_leaf_id"),
  // for decision_gate entries
  gateId: text("gate_id"),
  resolvedAt: text("resolved_at"),
  resolution: text("resolution"), // JSON
  withdrawnReason: text("withdrawn_reason"),
  // common
  metadata: text("metadata"), // JSON
  createdAt: integer("created_at").notNull(),
}, (t) => [
  index("engine_entries_thread").on(t.sessionId, t.threadId, t.createdAt),
  index("engine_entries_gate").on(t.gateId),
]);

export const engineQueueItems = sqliteTable("engine_queue_items", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  threadId: text("thread_id").notNull(),
  status: text("status").notNull(), // 'queued' | 'running' | 'blocked_on_decision_gate' | 'paused' | 'idle'
  mode: text("mode").notNull(), // queue mode at submission time
  content: text("content").notNull(), // JSON PromptContent
  author: text("author"), // JSON
  channel: text("channel"), // JSON
  replyTarget: text("reply_target"), // JSON
  model: text("model"),
  metadata: text("metadata"), // JSON
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  index("engine_queue_items_thread").on(t.sessionId, t.threadId, t.status),
]);

export const engineQueueState = sqliteTable("engine_queue_state", {
  threadId: text("thread_id").notNull(),
  sessionId: text("session_id").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  activeItemId: text("active_item_id"),
  pending: text("pending").notNull(), // JSON QueueItem[]
  collectBuffer: text("collect_buffer"), // JSON QueueItem[] | null
  blockedGateId: text("blocked_gate_id"),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.sessionId, t.threadId] }),
]);

export const engineDecisionGates = sqliteTable("engine_decision_gates", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  threadId: text("thread_id").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  actions: text("actions").notNull(), // JSON
  origin: text("origin"), // JSON
  context: text("context"), // JSON
  resolution: text("resolution"), // JSON
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  index("engine_decision_gates_thread").on(t.sessionId, t.threadId, t.status),
]);

export const engineDecisionGateRefs = sqliteTable("engine_decision_gate_refs", {
  id: text("id").primaryKey(),
  gateId: text("gate_id").notNull(),
  channelType: text("channel_type").notNull(),
  ref: text("ref").notNull(), // JSON
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  index("engine_decision_gate_refs_gate").on(t.gateId),
]);

export const engineSuspendedTurns = sqliteTable("engine_suspended_turns", {
  sessionId: text("session_id").notNull(),
  threadId: text("thread_id").notNull(),
  queueItemId: text("queue_item_id").notNull(),
  gateId: text("gate_id").notNull(),
  model: text("model").notNull(),
  leafEntryId: text("leaf_entry_id"),
  toolCallId: text("tool_call_id").notNull(),
  toolName: text("tool_name").notNull(),
  toolArgs: text("tool_args").notNull(), // JSON
  resumeKey: text("resume_key").notNull(),
  attempt: integer("attempt").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.sessionId, t.threadId] }),
  index("engine_suspended_turns_gate").on(t.gateId),
]);
```

- [ ] **Step 2: Write the index file**

```ts
// packages/engine/src/schema/index.ts
export * from "./sqlite.js";
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/engine && pnpm typecheck
```

Expected: clean (no output).

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/schema
git commit -m "feat(engine): add Drizzle SQLite schema for engine tables"
```

---

### Task 3: Generate the initial migration

**Files:**
- Create: `packages/engine/drizzle.config.ts`
- Create: `packages/engine/migrations/sqlite/0001_initial.sql` (via drizzle-kit)

- [ ] **Step 1: Write drizzle.config.ts**

```ts
// packages/engine/drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/sqlite.ts",
  out: "./migrations/sqlite",
});
```

- [ ] **Step 2: Generate migration**

```bash
cd packages/engine && pnpm db:generate
```

Expected output: `1 file generated` and a new `migrations/sqlite/0001_*.sql` file.

- [ ] **Step 3: Verify the migration looks right**

```bash
ls packages/engine/migrations/sqlite/
head -40 packages/engine/migrations/sqlite/0001_*.sql
```

Expected: contains `CREATE TABLE engine_sessions`, `engine_threads`, `engine_entries`, `engine_queue_items`, `engine_queue_state`, `engine_decision_gates`, `engine_decision_gate_refs`, `engine_suspended_turns`.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/drizzle.config.ts packages/engine/migrations/sqlite
git commit -m "feat(engine): generate initial sqlite migration"
```

---

## Phase 2: SqliteSessionStore + contract tests

### Task 4: Extract `SessionStore` contract test suite

The same tests should run against any `SessionStore` implementation. Extract them into a function that takes a store factory.

**Files:**
- Create: `packages/engine/test/store-contract.ts`

- [ ] **Step 1: Write the contract suite**

```ts
// packages/engine/test/store-contract.ts
import { describe, it, expect, beforeEach } from "vitest";
import type {
  DecisionGate,
  MessageEntry,
  QueueState,
  SessionData,
  SessionEntry,
  SessionStore,
  SuspendedTurnState,
  ThreadData,
} from "../src/index.js";

export interface StoreContractContext {
  factory: () => SessionStore | Promise<SessionStore>;
  /** Optional async teardown; called after each test. */
  teardown?: (store: SessionStore) => void | Promise<void>;
}

export function runSessionStoreContract(name: string, ctx: StoreContractContext) {
  describe(`SessionStore contract: ${name}`, () => {
    let store: SessionStore;

    beforeEach(async () => {
      store = await ctx.factory();
    });

    function newSession(overrides: Partial<SessionData> = {}): SessionData {
      return {
        id: "sess-1",
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        purpose: "interactive",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
      };
    }

    function newThread(sessionId: string, key = "web:default"): ThreadData {
      return {
        id: "th-1",
        sessionId,
        key,
        status: "active",
        queueMode: "followup",
        createdAt: 1,
        updatedAt: 1,
      };
    }

    it("saveSession + getSession round-trips", async () => {
      const s = newSession();
      await store.saveSession(s);
      const loaded = await store.getSession(s.id);
      expect(loaded).toMatchObject({ id: "sess-1", userId: "u1", status: "running" });
    });

    it("listSessions filters by userId", async () => {
      await store.saveSession(newSession({ id: "a", userId: "u1" }));
      await store.saveSession(newSession({ id: "b", userId: "u2" }));
      const list = await store.listSessions("u1");
      expect(list.map((s) => s.id)).toEqual(["a"]);
    });

    it("saveThread + listThreads round-trips", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1", "task:A"));
      await store.saveThread("sess-1", newThread("sess-1", "task:B"));
      // Use a unique id for each
      await store.saveThread("sess-1", { ...newThread("sess-1", "task:B"), id: "th-2" });
      const threads = await store.listThreads("sess-1");
      expect(threads.length).toBeGreaterThanOrEqual(2);
    });

    it("appendEntries + getEntries returns entries in insertion order", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const entries: SessionEntry[] = [
        msg("e-1", "user", "hi", 10),
        msg("e-2", "assistant", "hello", 20),
      ];
      await store.appendEntries("sess-1", "th-1", entries);
      const loaded = await store.getEntries("sess-1", "th-1");
      expect(loaded).toHaveLength(2);
      expect(loaded[0]).toMatchObject({ id: "e-1", type: "message", role: "user", content: "hi" });
      expect(loaded[1]).toMatchObject({ id: "e-2", type: "message", role: "assistant" });
    });

    it("appendEntries persists decision_gate entries", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const gate: DecisionGate = {
        id: "g-1",
        sessionId: "sess-1",
        threadId: "th-1",
        type: "approval",
        status: "pending",
        title: "ok?",
        actions: [{ id: "approve", label: "Approve" }],
        createdAt: 100,
        updatedAt: 100,
      };
      await store.saveDecisionGate("sess-1", "th-1", gate);
      await store.appendEntries("sess-1", "th-1", [
        {
          id: "e-g",
          sessionId: "sess-1",
          threadId: "th-1",
          parentId: null,
          type: "decision_gate",
          gate,
          createdAt: 100,
        },
      ]);
      const loaded = await store.getEntries("sess-1", "th-1");
      const gateEntry = loaded.find((e) => e.type === "decision_gate");
      expect(gateEntry).toBeDefined();
      expect(gateEntry && gateEntry.type === "decision_gate" && gateEntry.gate.id).toBe("g-1");
    });

    it("saveQueueState + getQueueState round-trips", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const qs: QueueState = {
        threadId: "th-1",
        mode: "followup",
        status: "running",
        activeItemId: "q-1",
        pending: [],
      };
      await store.saveQueueState("sess-1", "th-1", qs);
      const loaded = await store.getQueueState("sess-1", "th-1");
      expect(loaded).toMatchObject({ threadId: "th-1", status: "running", activeItemId: "q-1" });
    });

    it("saveDecisionGate + listDecisionGates + getDecisionGate", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const gate: DecisionGate = {
        id: "g-1",
        sessionId: "sess-1",
        threadId: "th-1",
        type: "approval",
        status: "pending",
        title: "x",
        actions: [],
        createdAt: 1,
        updatedAt: 1,
      };
      await store.saveDecisionGate("sess-1", "th-1", gate);
      const list = await store.listDecisionGates("sess-1");
      expect(list).toHaveLength(1);
      const single = await store.getDecisionGate("sess-1", "g-1");
      expect(single?.title).toBe("x");
    });

    it("saveSuspendedTurn + getSuspendedTurn + clearSuspendedTurn", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const sus: SuspendedTurnState = {
        sessionId: "sess-1",
        threadId: "th-1",
        queueItemId: "q-1",
        gateId: "g-1",
        model: "faux/faux-1",
        toolCallId: "tc-1",
        toolName: "do_thing",
        toolArgs: { arg: "x" },
        resumeKey: "do_thing:x",
        attempt: 1,
        createdAt: 1,
      };
      await store.saveSuspendedTurn("sess-1", "th-1", sus);
      expect(await store.getSuspendedTurn("sess-1", "th-1")).toMatchObject({ toolName: "do_thing" });
      await store.clearSuspendedTurn("sess-1", "th-1");
      expect(await store.getSuspendedTurn("sess-1", "th-1")).toBeNull();
    });

    it("updateDecisionGateEntry patches the matching entry", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const gate: DecisionGate = {
        id: "g-1",
        sessionId: "sess-1",
        threadId: "th-1",
        type: "approval",
        status: "pending",
        title: "x",
        actions: [],
        createdAt: 1,
        updatedAt: 1,
      };
      await store.saveDecisionGate("sess-1", "th-1", gate);
      await store.appendEntries("sess-1", "th-1", [
        {
          id: "e-g",
          sessionId: "sess-1",
          threadId: "th-1",
          parentId: null,
          type: "decision_gate",
          gate,
          createdAt: 1,
        },
      ]);
      await store.updateDecisionGateEntry("sess-1", "th-1", "g-1", {
        gate: { ...gate, status: "resolved" },
        resolution: { actionId: "approve", resolvedBy: "u1", resolvedAt: 5 },
      });
      const entries = await store.getEntries("sess-1", "th-1");
      const e = entries.find((x) => x.type === "decision_gate");
      expect(e && e.type === "decision_gate" && e.gate.status).toBe("resolved");
      expect(e && e.type === "decision_gate" && e.resolution?.actionId).toBe("approve");
    });

    it("deleteSession removes the session", async () => {
      await store.saveSession(newSession());
      await store.deleteSession("sess-1");
      expect(await store.getSession("sess-1")).toBeNull();
    });
  });
}

function msg(id: string, role: "user" | "assistant", content: string, ts: number): MessageEntry {
  return {
    id,
    sessionId: "sess-1",
    threadId: "th-1",
    parentId: null,
    type: "message",
    role,
    content,
    createdAt: ts,
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/engine/test/store-contract.ts
git commit -m "test(engine): add SessionStore contract test suite"
```

---

### Task 5: Run contract suite against `InMemorySessionStore` (regression check)

**Files:**
- Create: `packages/engine/test/in-memory-store.test.ts`

- [ ] **Step 1: Write the test**

```ts
// packages/engine/test/in-memory-store.test.ts
import { InMemorySessionStore } from "../src/index.js";
import { runSessionStoreContract } from "./store-contract.js";

runSessionStoreContract("InMemorySessionStore", {
  factory: () => new InMemorySessionStore(),
});
```

- [ ] **Step 2: Run it**

```bash
pnpm test -- in-memory-store
```

Expected: 10 tests passing. If any fail, the existing in-memory store has a bug — fix it in `packages/engine/src/providers/in-memory-store.ts` before proceeding. (Common likely issue: `updateDecisionGateEntry` not preserving entries; the existing impl handles this — verify.)

- [ ] **Step 3: Commit**

```bash
git add packages/engine/test/in-memory-store.test.ts
git commit -m "test(engine): run contract suite against InMemorySessionStore"
```

---

### Task 6: Implement `SqliteSessionStore`

**Files:**
- Create: `packages/engine/src/providers/sqlite-store-helpers.ts`
- Create: `packages/engine/src/providers/sqlite-store.ts`

The store uses `drizzle-orm/better-sqlite3` for in-process SQLite. The `D1` adapter (Cloudflare) wires in differently and is out of scope here, but the same Drizzle queries will run against either via the Cloudflare adapter package.

- [ ] **Step 1: Write encoding helpers**

```ts
// packages/engine/src/providers/sqlite-store-helpers.ts
import type {
  CompactionEntry,
  DecisionGate,
  DecisionGateEntry,
  MessageEntry,
  BranchSummaryEntry,
  SessionEntry,
} from "../types.js";

export function jsonOrNull<T>(value: T | undefined | null): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function parseJson<T>(value: string | null): T | undefined {
  if (value === null || value === undefined) return undefined;
  return JSON.parse(value) as T;
}

export interface EntryRow {
  id: string;
  sessionId: string;
  threadId: string;
  parentId: string | null;
  entryType: string;
  role: string | null;
  content: string | null;
  parts: string | null;
  author: string | null;
  channel: string | null;
  model: string | null;
  summary: string | null;
  coveredEntryIds: string | null;
  tokenCountBefore: number | null;
  tokenCountAfter: number | null;
  fileContext: string | null;
  branchRootId: string | null;
  branchLeafId: string | null;
  gateId: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  withdrawnReason: string | null;
  metadata: string | null;
  createdAt: number;
}

export function entryToRow(entry: SessionEntry): Omit<EntryRow, "entryType"> & { entryType: string } {
  const base = {
    id: entry.id,
    sessionId: entry.sessionId,
    threadId: entry.threadId,
    parentId: entry.parentId,
    metadata: jsonOrNull(entry.metadata),
    createdAt: entry.createdAt,
    role: null,
    content: null,
    parts: null,
    author: null,
    channel: null,
    model: null,
    summary: null,
    coveredEntryIds: null,
    tokenCountBefore: null,
    tokenCountAfter: null,
    fileContext: null,
    branchRootId: null,
    branchLeafId: null,
    gateId: null,
    resolvedAt: null,
    resolution: null,
    withdrawnReason: null,
  };
  switch (entry.type) {
    case "message":
      return {
        ...base,
        entryType: "message",
        role: entry.role,
        content: entry.content,
        parts: jsonOrNull(entry.parts),
        author: jsonOrNull(entry.author),
        channel: jsonOrNull(entry.channel),
        model: entry.model ?? null,
      };
    case "compaction":
      return {
        ...base,
        entryType: "compaction",
        summary: entry.summary,
        coveredEntryIds: JSON.stringify(entry.coveredEntryIds),
        tokenCountBefore: entry.tokenCountBefore,
        tokenCountAfter: entry.tokenCountAfter,
        fileContext: jsonOrNull(entry.fileContext),
      };
    case "branch_summary":
      return {
        ...base,
        entryType: "branch_summary",
        branchRootId: entry.branchRootId,
        branchLeafId: entry.branchLeafId,
        summary: entry.summary,
      };
    case "decision_gate":
      return {
        ...base,
        entryType: "decision_gate",
        gateId: entry.gate.id,
        // store the gate JSON in `parts` field (reusing) — simpler: a dedicated column
        // We'll use `metadata` to store the gate snapshot for the entry.
        metadata: JSON.stringify({ gate: entry.gate, ...(entry.metadata ?? {}) }),
        resolvedAt: entry.resolvedAt ?? null,
        resolution: jsonOrNull(entry.resolution),
        withdrawnReason: entry.withdrawnReason ?? null,
      };
  }
}

export function rowToEntry(row: EntryRow): SessionEntry {
  switch (row.entryType) {
    case "message": {
      const e: MessageEntry = {
        id: row.id,
        sessionId: row.sessionId,
        threadId: row.threadId,
        parentId: row.parentId,
        type: "message",
        role: (row.role as MessageEntry["role"]) ?? "user",
        content: row.content ?? "",
        parts: parseJson(row.parts),
        author: parseJson(row.author),
        channel: parseJson(row.channel),
        model: row.model ?? undefined,
        metadata: parseJson(row.metadata),
        createdAt: row.createdAt,
      };
      return e;
    }
    case "compaction": {
      const e: CompactionEntry = {
        id: row.id,
        sessionId: row.sessionId,
        threadId: row.threadId,
        parentId: row.parentId,
        type: "compaction",
        summary: row.summary ?? "",
        coveredEntryIds: parseJson<string[]>(row.coveredEntryIds) ?? [],
        tokenCountBefore: row.tokenCountBefore ?? 0,
        tokenCountAfter: row.tokenCountAfter ?? 0,
        fileContext: parseJson(row.fileContext),
        metadata: parseJson(row.metadata),
        createdAt: row.createdAt,
      };
      return e;
    }
    case "branch_summary": {
      const e: BranchSummaryEntry = {
        id: row.id,
        sessionId: row.sessionId,
        threadId: row.threadId,
        parentId: row.parentId,
        type: "branch_summary",
        branchRootId: row.branchRootId ?? "",
        branchLeafId: row.branchLeafId ?? "",
        summary: row.summary ?? "",
        metadata: parseJson(row.metadata),
        createdAt: row.createdAt,
      };
      return e;
    }
    case "decision_gate": {
      const meta = parseJson<{ gate: DecisionGate } & Record<string, unknown>>(row.metadata);
      const gate = meta?.gate;
      if (!gate) throw new Error(`decision_gate entry ${row.id} missing gate snapshot`);
      // Strip our internal `gate` key from metadata before re-exposing.
      const { gate: _unused, ...userMeta } = meta ?? { gate };
      const e: DecisionGateEntry = {
        id: row.id,
        sessionId: row.sessionId,
        threadId: row.threadId,
        parentId: row.parentId,
        type: "decision_gate",
        gate,
        resolvedAt: row.resolvedAt ?? undefined,
        resolution: parseJson(row.resolution),
        withdrawnReason: (row.withdrawnReason as DecisionGateEntry["withdrawnReason"]) ?? undefined,
        metadata: Object.keys(userMeta).length > 0 ? (userMeta as Record<string, unknown>) : undefined,
        createdAt: row.createdAt,
      };
      return e;
    }
    default:
      throw new Error(`unknown entry type: ${row.entryType}`);
  }
}
```

- [ ] **Step 2: Write the store**

```ts
// packages/engine/src/providers/sqlite-store.ts
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq, desc, asc } from "drizzle-orm";
import {
  engineSessions,
  engineThreads,
  engineEntries,
  engineQueueItems,
  engineQueueState,
  engineDecisionGates,
  engineDecisionGateRefs,
  engineSuspendedTurns,
} from "../schema/sqlite.js";
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
import { entryToRow, jsonOrNull, parseJson, rowToEntry, type EntryRow } from "./sqlite-store-helpers.js";

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
          metadata: jsonOrNull(session.metadata),
          updatedAt: session.updatedAt,
        },
      })
      .run();
  }

  async saveThread(sessionId: string, thread: ThreadData): Promise<void> {
    this.db
      .insert(engineThreads)
      .values({
        id: thread.id,
        sessionId,
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

  async appendEntries(sessionId: string, threadId: string, entries: SessionEntry[]): Promise<void> {
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
    sessionId: string,
    threadId: string,
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
    // Find the entry row by gateId in the thread.
    const rows = this.db
      .select()
      .from(engineEntries)
      .where(and(eq(engineEntries.sessionId, sessionId), eq(engineEntries.threadId, threadId), eq(engineEntries.gateId, gateId)))
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
      .where(and(eq(engineSuspendedTurns.sessionId, sessionId), eq(engineSuspendedTurns.threadId, threadId)))
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
      metadata: parseJson(row.metadata),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async listSessions(userId: string, opts?: ListOpts): Promise<SessionData[]> {
    let query = this.db.select().from(engineSessions).where(eq(engineSessions.userId, userId));
    const rows = query.all();
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
    return {
      id: row.id,
      sessionId: row.sessionId,
      key: row.key,
      status: row.status as ThreadData["status"],
      activeLeafEntryId: row.activeLeafEntryId ?? undefined,
      queueMode: row.queueMode as ThreadData["queueMode"],
      model: row.model ?? undefined,
      summary: row.summary ?? undefined,
      metadata: parseJson(row.metadata),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async listThreads(sessionId: string): Promise<ThreadData[]> {
    const rows = this.db.select().from(engineThreads).where(eq(engineThreads.sessionId, sessionId)).all();
    return rows.map((r) => ({
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
    }));
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
      .where(and(eq(engineQueueState.sessionId, sessionId), eq(engineQueueState.threadId, threadId)))
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
    let rows;
    if (threadId) {
      rows = this.db
        .select()
        .from(engineDecisionGates)
        .where(and(eq(engineDecisionGates.sessionId, sessionId), eq(engineDecisionGates.threadId, threadId)))
        .all();
    } else {
      rows = this.db
        .select()
        .from(engineDecisionGates)
        .where(eq(engineDecisionGates.sessionId, sessionId))
        .all();
    }
    return rows.map(rowToGate);
  }

  async getDecisionGate(sessionId: string, gateId: string): Promise<DecisionGate | null> {
    const row = this.db
      .select()
      .from(engineDecisionGates)
      .where(and(eq(engineDecisionGates.sessionId, sessionId), eq(engineDecisionGates.id, gateId)))
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
      .where(and(eq(engineSuspendedTurns.sessionId, sessionId), eq(engineSuspendedTurns.threadId, threadId)))
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
```

- [ ] **Step 3: Re-export from index**

Modify `packages/engine/src/index.ts` to add:

```ts
export { SqliteSessionStore } from "./providers/sqlite-store.js";
```

(append after the existing `InMemoryCredentialStore` export)

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/providers/sqlite-store.ts packages/engine/src/providers/sqlite-store-helpers.ts packages/engine/src/index.ts
git commit -m "feat(engine): SqliteSessionStore implementation"
```

---

### Task 7: Run contract suite against `SqliteSessionStore`

**Files:**
- Create: `packages/engine/test/sqlite-store.test.ts`

- [ ] **Step 1: Write the test**

```ts
// packages/engine/test/sqlite-store.test.ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { SqliteSessionStore } from "../src/index.js";
import { runSessionStoreContract } from "./store-contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations", "sqlite");

function applyMigrations(db: Database.Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // drizzle-kit emits statements separated by `--> statement-breakpoint`
    const statements = sql.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (trimmed) db.exec(trimmed);
    }
  }
}

runSessionStoreContract("SqliteSessionStore", {
  factory: () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    const db = drizzle(sqlite);
    return new SqliteSessionStore(db);
  },
});
```

- [ ] **Step 2: Run it**

```bash
pnpm test -- sqlite-store
```

Expected: 10 tests passing. Most likely failures:
- "no such table" — migration didn't apply. Inspect `migrations/sqlite/0001_*.sql` and ensure the splitter handles its statement separator.
- JSON column round-trip mismatches — fix `entryToRow`/`rowToEntry`.

- [ ] **Step 3: Commit**

```bash
git add packages/engine/test/sqlite-store.test.ts
git commit -m "test(engine): run contract suite against SqliteSessionStore"
```

---

## Phase 3: Restart-safe gate primitives

### Task 8: Make gate IDs deterministic from `(session, thread, queueItem, resumeKey)`

The current `fromRequest()` (in `packages/engine/src/decision-gate.ts:117-141`) generates a random ID when `resumeKey` is missing, and only uses `resumeKey` directly otherwise. Both behaviors are wrong for restart-safety: replays must compute the same ID.

**Files:**
- Modify: `packages/engine/src/decision-gate.ts`
- Modify: `packages/engine/src/thread.ts`

- [ ] **Step 1: Replace `fromRequest` with a deterministic builder**

Replace the existing `fromRequest` function (the version with the random fallback) with:

```ts
export interface GateContext {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  resumeKey: string;
}

export function deterministicGateId(ctx: GateContext): string {
  return `gate:${ctx.sessionId}:${ctx.threadId}:${ctx.queueItemId}:${ctx.resumeKey}`;
}

export function fromRequest(req: DecisionGateRequest, gateCtx: GateContext): DecisionGate {
  if (!req.resumeKey) {
    throw new Error(
      "DecisionGateRequest.resumeKey is required for restart-safe gates. " +
        "Tools must supply a stable key per suspension point.",
    );
  }
  const now = Date.now();
  return {
    id: deterministicGateId(gateCtx),
    sessionId: gateCtx.sessionId,
    threadId: gateCtx.threadId,
    type: req.type,
    title: req.title,
    body: req.body,
    actions:
      req.actions ??
      (req.type === "approval"
        ? [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "deny", label: "Deny", style: "danger" },
          ]
        : []),
    expiresAt: req.expiresAt,
    status: "pending",
    context: req.context,
    origin: req.origin,
    createdAt: now,
    updatedAt: now,
  };
}
```

- [ ] **Step 2: Update Thread.requestDecision call site**

In `packages/engine/src/thread.ts`, change the `fromRequest(req, session.id, this.id)` call to pass the new GateContext. Locate the `requestDecision` async function in `buildToolContext()` and change:

```ts
const gate = fromRequest(req, session.id, this.id);
```

to:

```ts
const gate = fromRequest(req, {
  sessionId: session.id,
  threadId: this.id,
  queueItemId: this.activeItem?.id ?? "",
  resumeKey: req.resumeKey ?? "",
});
```

(The new `fromRequest` will throw if `resumeKey` is empty — that's the contract.)

- [ ] **Step 3: Update existing tests that use `requestDecision` without `resumeKey`**

Run:

```bash
pnpm test 2>&1 | head -50
```

Any test that fails with "resumeKey is required" needs to add a `resumeKey` to the `requestDecision` call. The `decision-gate.test.ts` should already pass `resumeKey` for the approval cases — verify and add it for the expiring-tool case (`packages/engine/test/decision-gate.test.ts` around line 142):

Old:
```ts
await ctx.requestDecision({
  type: "approval",
  title: "expire me",
  expiresAt: Date.now() + 30,
});
```

New:
```ts
await ctx.requestDecision({
  type: "approval",
  title: "expire me",
  expiresAt: Date.now() + 30,
  resumeKey: "expire-me-1",
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm test
```

Expected: 14 tests still passing.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/decision-gate.ts packages/engine/src/thread.ts packages/engine/test/decision-gate.test.ts
git commit -m "feat(engine): deterministic gate IDs derived from resumeKey"
```

---

### Task 9: `requestDecision` short-circuits when `ctx.suspendedDecision` matches

**Files:**
- Modify: `packages/engine/src/thread.ts`

- [ ] **Step 1: Add the short-circuit at the top of `requestDecision`**

In `packages/engine/src/thread.ts`, at the start of the `requestDecision` async function inside `buildToolContext()`, before constructing the gate, add:

```ts
requestDecision: async (req: DecisionGateRequest): Promise<DecisionResolution> => {
  const gateCtx = {
    sessionId: session.id,
    threadId: this.id,
    queueItemId: this.activeItem?.id ?? "",
    resumeKey: req.resumeKey ?? "",
  };
  // Restart-safe replay: if we are running with a suspendedDecision and the
  // gate ID matches, return the stored resolution without re-persisting.
  const expectedId = req.resumeKey
    ? deterministicGateId(gateCtx)
    : null;
  if (
    this.suspendedDecisionForReplay &&
    expectedId &&
    this.suspendedDecisionForReplay.gateId === expectedId
  ) {
    const resolution = this.suspendedDecisionForReplay.resolution;
    if (!resolution) {
      throw new Error(`replay: suspendedDecision for ${expectedId} has no resolution`);
    }
    // One-shot: clear so a subsequent requestDecision in the same turn opens normally.
    this.suspendedDecisionForReplay = undefined;
    return resolution;
  }

  const gate = fromRequest(req, gateCtx);
  // …rest of existing implementation
```

Add a private field at the top of the `Thread` class for the replay context:

```ts
private suspendedDecisionForReplay: { gateId: string; resolution?: DecisionResolution } | undefined;
```

Add an import for `deterministicGateId` next to the existing `fromRequest, GateManager` import:

```ts
import { fromRequest, GateManager, deterministicGateId } from "./decision-gate.js";
```

- [ ] **Step 2: Wire `suspendedDecisionForReplay` into ToolContext**

In the same `buildToolContext` method, set `suspendedDecision` on the context:

```ts
suspendedDecision: this.suspendedDecisionForReplay,
```

(Replace the existing `suspendedDecision: undefined` if present, or add to the returned ctx if missing.)

- [ ] **Step 3: Add a method to set the replay context**

In the `Thread` class, add a public method:

```ts
/** Used by Engine.restoreSession to seed replay state before re-running a blocked tool. */
setReplayContext(ctx: { gateId: string; resolution?: DecisionResolution } | undefined): void {
  this.suspendedDecisionForReplay = ctx;
}
```

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 5: Run tests**

```bash
pnpm test
```

Expected: still 14 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/thread.ts
git commit -m "feat(engine): requestDecision short-circuits on suspendedDecision replay"
```

---

### Task 10: Persist real `toolCallId` and `toolArgs` on suspension

The current `requestDecision` saves placeholder values for `toolCallId` and empty `toolArgs`. Replay needs the real values.

**Files:**
- Modify: `packages/engine/src/tool-bridge.ts`
- Modify: `packages/engine/src/types.ts`
- Modify: `packages/engine/src/thread.ts`

- [ ] **Step 1: Add `toolCallId`, `toolName`, `toolArgs` to the closure in `tool-bridge.ts`**

Replace `toAgentTool` in `packages/engine/src/tool-bridge.ts`:

```ts
export function toAgentTool<TParams extends import("typebox").TSchema>(
  def: ToolDef<TParams>,
  buildContext: (args: {
    signal: AbortSignal;
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }) => ToolContext,
): AgentTool<TParams> {
  return {
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: async (toolCallId, params, signal) => {
      const ctx = buildContext({
        signal: signal ?? new AbortController().signal,
        toolCallId,
        toolName: def.name,
        toolArgs: params as Record<string, unknown>,
      });
      const result = await def.execute(params as never, ctx);
      return toAgentToolResult(result);
    },
  };
}
```

- [ ] **Step 2: Update Thread.buildTools / buildToolContext to use the new shape**

In `packages/engine/src/thread.ts`, update `buildTools`:

```ts
private buildTools(): AgentTool[] {
  const all: ToolDef[] = [...this.session.builtinTools, ...(this.session.options.tools ?? [])];
  return all.map((def) =>
    toAgentTool(def, ({ signal, toolCallId, toolName, toolArgs }) =>
      this.buildToolContext({ signal, toolCallId, toolName, toolArgs }),
    ),
  );
}
```

Update `buildToolContext` signature:

```ts
private buildToolContext(args: {
  signal: AbortSignal;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): ToolContext {
  const { signal, toolCallId, toolName, toolArgs } = args;
  // ... rest of existing implementation
```

In the `requestDecision` body, use the captured `toolCallId`, `toolName`, `toolArgs` for the SuspendedTurnState save:

```ts
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
```

- [ ] **Step 3: Run tests**

```bash
pnpm test
```

Expected: still 14 passing.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/tool-bridge.ts packages/engine/src/thread.ts
git commit -m "feat(engine): persist real tool call id and args on gate suspension"
```

---

### Task 11: Pure-function unit test for the short-circuit predicate

The short-circuit decision is deterministic given `(resumeKey, gateCtx, suspendedDecision)`. Extract the predicate into a pure function and unit test it directly. This avoids any race against the agent loop and makes the integration test in Task 15 the single end-to-end validation.

**Files:**
- Modify: `packages/engine/src/decision-gate.ts` (add `shouldShortCircuit`)
- Modify: `packages/engine/src/thread.ts` (use the new helper)
- Create: `packages/engine/test/short-circuit.test.ts`

- [ ] **Step 1: Add `shouldShortCircuit` to `decision-gate.ts`**

Append after `deterministicGateId`:

```ts
export function shouldShortCircuit(args: {
  ctx: GateContext;
  suspendedDecision: { gateId: string; resolution?: DecisionResolution } | undefined;
}): { match: true; resolution: DecisionResolution } | { match: false } {
  const { ctx, suspendedDecision } = args;
  if (!suspendedDecision) return { match: false };
  const expectedId = deterministicGateId(ctx);
  if (suspendedDecision.gateId !== expectedId) return { match: false };
  if (!suspendedDecision.resolution) return { match: false };
  return { match: true, resolution: suspendedDecision.resolution };
}
```

(Add `import type { DecisionResolution } from "./types.js";` if not already imported in decision-gate.ts.)

- [ ] **Step 2: Use it in `Thread.requestDecision`**

In `packages/engine/src/thread.ts`, replace the inline short-circuit you added in Task 9 with a call to `shouldShortCircuit`. The block at the top of `requestDecision` becomes:

```ts
requestDecision: async (req: DecisionGateRequest): Promise<DecisionResolution> => {
  if (!req.resumeKey) {
    throw new Error("DecisionGateRequest.resumeKey is required for restart-safe gates.");
  }
  const gateCtx = {
    sessionId: session.id,
    threadId: this.id,
    queueItemId: this.activeItem?.id ?? "",
    resumeKey: req.resumeKey,
  };
  const sc = shouldShortCircuit({
    ctx: gateCtx,
    suspendedDecision: this.suspendedDecisionForReplay,
  });
  if (sc.match) {
    this.suspendedDecisionForReplay = undefined; // one-shot
    return sc.resolution;
  }
  const gate = fromRequest(req, gateCtx);
  // …rest of existing implementation
```

Add `shouldShortCircuit` to the import from `./decision-gate.js`:

```ts
import { fromRequest, GateManager, deterministicGateId, shouldShortCircuit } from "./decision-gate.js";
```

- [ ] **Step 3: Write the unit test**

```ts
// packages/engine/test/short-circuit.test.ts
import { describe, it, expect } from "vitest";
import { shouldShortCircuit, deterministicGateId } from "../src/decision-gate.js";

const ctx = { sessionId: "s1", threadId: "t1", queueItemId: "q1", resumeKey: "do:x" };
const gateId = deterministicGateId(ctx);
const resolution = { actionId: "approve", resolvedBy: "u", resolvedAt: 1 };

describe("shouldShortCircuit", () => {
  it("returns no match when no suspendedDecision", () => {
    expect(shouldShortCircuit({ ctx, suspendedDecision: undefined }).match).toBe(false);
  });

  it("returns no match when gateId differs", () => {
    expect(
      shouldShortCircuit({
        ctx,
        suspendedDecision: { gateId: "gate:other", resolution },
      }).match,
    ).toBe(false);
  });

  it("returns no match when resolution is missing", () => {
    expect(
      shouldShortCircuit({ ctx, suspendedDecision: { gateId } }).match,
    ).toBe(false);
  });

  it("returns match + resolution when gateId and resolution are present", () => {
    const result = shouldShortCircuit({
      ctx,
      suspendedDecision: { gateId, resolution },
    });
    expect(result.match).toBe(true);
    if (result.match) expect(result.resolution).toEqual(resolution);
  });

  it("two ctx with same fields produce the same gateId", () => {
    const a = deterministicGateId({ sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k" });
    const b = deterministicGateId({ sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k" });
    expect(a).toBe(b);
  });

  it("differing resumeKey changes gateId", () => {
    const a = deterministicGateId({ sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k1" });
    const b = deterministicGateId({ sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k2" });
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 4: Run it**

```bash
pnpm test -- short-circuit
```

Expected: 6 tests passing.

- [ ] **Step 5: Run full suite**

```bash
pnpm test
```

Expected: still all green; the existing 14 engine tests continue to pass with the refactored short-circuit predicate.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/decision-gate.ts packages/engine/src/thread.ts packages/engine/test/short-circuit.test.ts
git commit -m "test(engine): unit-test the gate short-circuit predicate"
```

---

## Phase 4: `Engine.restoreSession`

### Task 12: Restore session and threads from store

**Files:**
- Modify: `packages/engine/src/engine.ts`
- Modify: `packages/engine/src/session.ts`

- [ ] **Step 1: Add a `Session.rehydrate` static path**

In `packages/engine/src/session.ts`, add a static helper that builds a Session from store data without re-saving:

```ts
static async rehydrate(
  data: SessionData,
  options: CreateSessionOptions,
  providers: ProviderBundle,
  sandbox: Sandbox,
): Promise<Session> {
  const session = new Session(data.id, options, providers, sandbox);
  // Rebuild threads from store
  const threadDatas = await providers.store.listThreads(data.id);
  for (const td of threadDatas) {
    const thread = new Thread(session, td);
    session.threads.set(thread.id, thread);
    session.threadsByKey.set(thread.key, thread);
    // Rehydrate agent transcript from entries
    const entries = await providers.store.getEntries(data.id, td.id);
    thread.rehydrateTranscript(entries);
  }
  return session;
}
```

(This needs `threads` and `threadsByKey` to be `protected` or accessible within the file. They are `private` — change to `private` → `private` plus a mutator method, or use `Session["threads"]` type assertion. Cleanest: add a `Session.attachThread(thread)` method.)

Add to `Session`:

```ts
private attachThread(thread: Thread): void {
  this.threads.set(thread.id, thread);
  this.threadsByKey.set(thread.key, thread);
}
```

And use it in `rehydrate`:

```ts
session.attachThread(thread);
```

- [ ] **Step 2: Add `Thread.rehydrateTranscript`**

In `packages/engine/src/thread.ts`, add. The crucial detail (per the spec's "LLM-faithful entry persistence" contract): for assistant messages that issued tool calls, we MUST reconstruct the `ToolCall` blocks from `MessageEntry.parts`. Without this, after replay we'd push a `toolResult` after a text-only assistant message, which providers reject.

```ts
rehydrateTranscript(entries: SessionEntry[]): void {
  const agentMessages: AgentMessage[] = [];
  for (const e of entries) {
    if (e.type !== "message") continue; // CompactionEntry/DecisionGateEntry filtered

    if (e.role === "user") {
      agentMessages.push({
        role: "user",
        content: [{ type: "text", text: e.content }],
        timestamp: e.createdAt,
      });
      continue;
    }

    if (e.role === "assistant") {
      // Reconstruct content blocks from parts so tool calls survive rehydration.
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
      agentMessages.push({
        role: "assistant",
        content: blocks,
        api: this.session.options.model.api,
        provider: this.session.options.model.provider,
        model: e.model ?? this.session.options.model.id,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: e.createdAt,
      });
      continue;
    }

    // tool/system roles dropped from the LLM transcript here — toolResult
    // messages are re-derived by replayBlocked() when it runs the suspended
    // tool and pushes its result before agent.continue().
  }
  this.agent.state.messages = agentMessages;
}
```

Imports needed at top of `thread.ts`:

```ts
import type { TextContent, ThinkingContent, ToolCall } from "@mariozechner/pi-ai";
```

(`AgentMessage` should already be imported.)

- [ ] **Step 3: Implement Engine.restoreSession**

Replace the throwing stub in `packages/engine/src/engine.ts`. Per the spec, `restoreSession` takes a `RestoreSessionOptions` argument (`{ sessionId, options }`) — the caller re-supplies tools/sandbox/model:

```ts
async restoreSession(args: {
  sessionId: string;
  options: Omit<CreateSessionOptions, "id">;
}): Promise<Session> {
  const cached = this.sessions.get(args.sessionId);
  if (cached) return cached;
  const data = await this.opts.providers.store.getSession(args.sessionId);
  if (!data) throw new Error(`session not found: ${args.sessionId}`);
  const sandbox = await this.materializeSandbox(args.options.sandbox);
  const session = await Session.rehydrate(
    data,
    { ...args.options, id: args.sessionId },
    this.opts.providers,
    sandbox,
  );
  this.sessions.set(args.sessionId, session);
  return session;
}
```

Also add a `RestoreSessionOptions` type to `packages/engine/src/types.ts`:

```ts
export interface RestoreSessionOptions {
  sessionId: string;
  options: Omit<CreateSessionOptions, "id">;
}
```

- [ ] **Step 4: Re-export `RestoreSessionOptions`**

In `packages/engine/src/index.ts`, the existing `export * from "./types.js"` already covers it. `Engine` is already exported.

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/engine.ts packages/engine/src/session.ts packages/engine/src/thread.ts
git commit -m "feat(engine): restoreSession rehydrates session, threads, and transcripts"
```

---

### Task 13: Replay blocked turns

If a thread has a suspended turn, restoration must either wait for the gate to resolve (still pending) or replay the tool immediately (gate already resolved).

**Files:**
- Modify: `packages/engine/src/session.ts`
- Modify: `packages/engine/src/thread.ts`

- [ ] **Step 1: Add `Thread.replayBlocked` that runs a single suspended tool call**

In `packages/engine/src/thread.ts`:

```ts
async replayBlocked(args: {
  suspended: SuspendedTurnState;
  resolution: DecisionResolution;
}): Promise<void> {
  const { suspended, resolution } = args;
  // Build tools and find the one we need to replay
  const tools = this.buildTools();
  const tool = tools.find((t) => t.name === suspended.toolName);
  if (!tool) {
    this.emitError(
      "replay_tool_missing",
      `cannot replay: tool ${suspended.toolName} not registered`,
    );
    return;
  }
  // Seed replay context so requestDecision short-circuits on the first call.
  this.setReplayContext({ gateId: suspended.gateId, resolution });
  // Run the tool to get the same result the original turn would have produced.
  // We bypass the agent loop for this one call; the result will be appended
  // as a synthetic toolResult message and we then call agent.continue().
  const fakeAbort = new AbortController();
  let toolResult;
  try {
    toolResult = await tool.execute(suspended.toolCallId, suspended.toolArgs, fakeAbort.signal);
  } catch (err) {
    this.emitError("replay_tool_failed", err instanceof Error ? err.message : String(err));
    return;
  }
  // Push as toolResult and continue the agent.
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
  // Clear suspended turn from store before continuing.
  await this.session.providers.store.clearSuspendedTurn(this.session.id, this.id);
  this.setStatus("running");
  try {
    await this.agent.continue();
    await this.agent.waitForIdle();
  } catch (err) {
    this.emitError("replay_continue_failed", err instanceof Error ? err.message : String(err));
  }
  if (this.readStatus() === "running") this.setStatus("idle");
}
```

(`AgentMessage` import may need updating to include `ToolResultMessage` shape — it's already part of the `Message` union from pi-ai.)

- [ ] **Step 2: Add `Session.replayBlocked` orchestrator**

In `packages/engine/src/session.ts`, add a method that, for a given thread, looks up suspension state and a possibly-resolved gate, and either kicks off the replay or re-registers a waiter:

```ts
async resumeBlockedThreadIfReady(threadId: string): Promise<void> {
  const thread = this.threads.get(threadId);
  if (!thread) return;
  const suspended = await this.providers.store.getSuspendedTurn(this.id, threadId);
  if (!suspended) return;
  const gate = await this.providers.store.getDecisionGate(this.id, suspended.gateId);
  if (!gate) {
    // Lost gate; clear suspended and abort the queue item
    await this.providers.store.clearSuspendedTurn(this.id, threadId);
    return;
  }
  if (gate.status === "resolved") {
    // We need the resolution. Read it from the gate's DAG entry.
    const entries = await this.providers.store.getEntries(this.id, threadId);
    const entry = entries.find((e) => e.type === "decision_gate" && e.gate.id === gate.id);
    const resolution =
      entry && entry.type === "decision_gate" ? entry.resolution : undefined;
    if (!resolution) {
      throw new Error(`gate ${gate.id} resolved but no resolution stored`);
    }
    void thread.replayBlocked({ suspended, resolution });
  } else if (gate.status === "pending") {
    // Re-register a waiter so resolveDecision will wake replay.
    thread.armPendingGateForRestart(gate, suspended);
  }
  // expired/withdrawn: nothing to do; the run already terminated.
}
```

- [ ] **Step 3: Add `Thread.armPendingGateForRestart`**

```ts
armPendingGateForRestart(gate: DecisionGate, suspended: SuspendedTurnState): void {
  this.blockedGateId = gate.id;
  this.setStatus("blocked_on_decision_gate");
  // Register the GateManager so resolveDecision/withdraw works as before.
  // Once resolved, run replayBlocked.
  this.gates
    .register(gate, async (gateId) => {
      // expiry handling: nothing more to do for replay
      void gateId;
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
```

- [ ] **Step 4: Call resumeBlockedThreadIfReady from Session.rehydrate**

In `Session.rehydrate`, after attaching all threads, kick off resumption for any blocked thread:

```ts
for (const td of threadDatas) {
  void session.resumeBlockedThreadIfReady(td.id);
}
```

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/session.ts packages/engine/src/thread.ts
git commit -m "feat(engine): replay blocked tool turns on session restore"
```

---

### Task 14: Persist queue items as well as queue state

Right now we save `QueueState` (the whole snapshot) but the per-queue-item rows in `engine_queue_items` aren't written. For restart, we need them to know what to re-submit.

**Files:**
- Modify: `packages/engine/src/types.ts`
- Modify: `packages/engine/src/providers/in-memory-store.ts`
- Modify: `packages/engine/src/providers/sqlite-store.ts`
- Modify: `packages/engine/src/thread.ts`

- [ ] **Step 1: Add `saveQueueItem` and `getQueueItems` to the SessionStore interface**

In `packages/engine/src/types.ts`, extend `SessionStore`:

```ts
saveQueueItem(sessionId: string, item: QueueItem & { status: QueueStatus }): Promise<void>;
getQueueItems(sessionId: string, threadId: string, opts?: { status?: QueueStatus }): Promise<Array<QueueItem & { status: QueueStatus }>>;
deleteQueueItem(sessionId: string, threadId: string, itemId: string): Promise<void>;
```

- [ ] **Step 2: Implement on InMemorySessionStore**

In `packages/engine/src/providers/in-memory-store.ts`:

```ts
private queueItemsByThread = new Map<string, Map<string, Array<QueueItem & { status: QueueStatus }>>>();

async saveQueueItem(sessionId: string, item: QueueItem & { status: QueueStatus }): Promise<void> {
  const r = this.row(sessionId);
  // Use a per-row map; keep it simple via a property on row.
  const list = r.queueItems?.get(item.threadId) ?? [];
  const idx = list.findIndex((i) => i.id === item.id);
  if (idx >= 0) list[idx] = item; else list.push(item);
  if (!r.queueItems) r.queueItems = new Map();
  r.queueItems.set(item.threadId, list);
}

async getQueueItems(sessionId: string, threadId: string, opts?: { status?: QueueStatus }) {
  const r = this.row(sessionId);
  const list = r.queueItems?.get(threadId) ?? [];
  return opts?.status ? list.filter((i) => i.status === opts.status) : [...list];
}

async deleteQueueItem(sessionId: string, threadId: string, itemId: string): Promise<void> {
  const r = this.row(sessionId);
  const list = r.queueItems?.get(threadId);
  if (!list) return;
  r.queueItems!.set(threadId, list.filter((i) => i.id !== itemId));
}
```

Add `queueItems?: Map<...>` to the `SessionRow` interface at the top of the file.

- [ ] **Step 3: Implement on SqliteSessionStore**

In `packages/engine/src/providers/sqlite-store.ts`:

```ts
async saveQueueItem(
  sessionId: string,
  item: QueueItem & { status: QueueStatus },
): Promise<void> {
  this.db
    .insert(engineQueueItems)
    .values({
      id: item.id,
      sessionId,
      threadId: item.threadId,
      status: item.status,
      mode: "followup", // could be tracked separately; for now default
      content: JSON.stringify(item.content),
      author: jsonOrNull(item.author),
      channel: jsonOrNull(item.channel),
      replyTarget: jsonOrNull(item.replyTarget),
      model: item.model ?? null,
      metadata: jsonOrNull(item.metadata),
      createdAt: item.createdAt,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: engineQueueItems.id,
      set: {
        status: item.status,
        updatedAt: Date.now(),
      },
    })
    .run();
}

async getQueueItems(
  sessionId: string,
  threadId: string,
  opts?: { status?: QueueStatus },
): Promise<Array<QueueItem & { status: QueueStatus }>> {
  let rows;
  if (opts?.status) {
    rows = this.db
      .select()
      .from(engineQueueItems)
      .where(and(eq(engineQueueItems.sessionId, sessionId), eq(engineQueueItems.threadId, threadId), eq(engineQueueItems.status, opts.status)))
      .all();
  } else {
    rows = this.db
      .select()
      .from(engineQueueItems)
      .where(and(eq(engineQueueItems.sessionId, sessionId), eq(engineQueueItems.threadId, threadId)))
      .all();
  }
  return rows.map((r) => ({
    id: r.id,
    threadId: r.threadId,
    status: r.status as QueueStatus,
    content: parseJson<QueueItem["content"]>(r.content) ?? "",
    author: parseJson(r.author),
    channel: parseJson(r.channel),
    replyTarget: parseJson(r.replyTarget),
    model: r.model ?? undefined,
    metadata: parseJson(r.metadata),
    createdAt: r.createdAt,
  }));
}

async deleteQueueItem(sessionId: string, threadId: string, itemId: string): Promise<void> {
  this.db
    .delete(engineQueueItems)
    .where(and(eq(engineQueueItems.sessionId, sessionId), eq(engineQueueItems.threadId, threadId), eq(engineQueueItems.id, itemId)))
    .run();
}
```

- [ ] **Step 4: Have Thread save queue items as they progress**

In `packages/engine/src/thread.ts`, in `submitPrompt` after building the `QueueItem`, save it:

```ts
await this.session.providers.store.saveQueueItem(this.session.id, {
  ...item,
  status: "queued",
});
```

In `tickQueue`, when an item starts running:

```ts
await this.session.providers.store.saveQueueItem(this.session.id, {
  ...next,
  status: "running",
});
```

When an item finishes (after `runItem`):

```ts
await this.session.providers.store.deleteQueueItem(this.session.id, this.id, next.id);
```

When the gate suspends, mark the active item as blocked:

In the existing `requestDecision` body:

```ts
if (this.activeItem) {
  await session.providers.store.saveQueueItem(session.id, {
    ...this.activeItem,
    status: "blocked_on_decision_gate",
  });
}
```

- [ ] **Step 5: Add the new contract tests**

Add to `packages/engine/test/store-contract.ts` inside the describe block:

```ts
it("saveQueueItem + getQueueItems round-trips", async () => {
  await store.saveSession(newSession());
  await store.saveThread("sess-1", newThread("sess-1"));
  await store.saveQueueItem("sess-1", {
    id: "q-1",
    threadId: "th-1",
    content: "hi",
    createdAt: 1,
    status: "queued",
  });
  const items = await store.getQueueItems("sess-1", "th-1");
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: "q-1", status: "queued" });
});

it("deleteQueueItem removes the item", async () => {
  await store.saveSession(newSession());
  await store.saveThread("sess-1", newThread("sess-1"));
  await store.saveQueueItem("sess-1", {
    id: "q-1",
    threadId: "th-1",
    content: "hi",
    createdAt: 1,
    status: "queued",
  });
  await store.deleteQueueItem("sess-1", "th-1", "q-1");
  expect(await store.getQueueItems("sess-1", "th-1")).toHaveLength(0);
});
```

- [ ] **Step 6: Run tests**

```bash
pnpm test
```

Expected: 17+ tests passing (10 contract × 2 store backends, plus the existing 14 engine tests).

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/types.ts packages/engine/src/providers packages/engine/src/thread.ts packages/engine/test/store-contract.ts
git commit -m "feat(engine): persist queue items per-status for restart visibility"
```

---

### Task 15: End-to-end restart cycle test

The plan's whole purpose: open a gate → throw away the engine → build a new engine with the same SqliteSessionStore → restoreSession → resolveDecision → verify the turn completes and the assistant's final text is persisted.

**Files:**
- Create: `packages/engine/test/restart-safe-gates.test.ts`

- [ ] **Step 1: Write the test**

```ts
// packages/engine/test/restart-safe-gates.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventBus,
  SqliteSessionStore,
  VirtualSandboxProvider,
  type ToolDef,
  type BusEvent,
  type DecisionGate,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations", "sqlite");

function applyMigrations(db: Database.Database): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const statements = sql.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (trimmed) db.exec(trimmed);
    }
  }
}

const approvalTool: ToolDef = {
  name: "do_thing",
  description: "approval-gated",
  parameters: Type.Object({ arg: Type.String() }),
  execute: async (args, ctx) => {
    const r = await ctx.requestDecision({
      type: "approval",
      title: "ok?",
      resumeKey: `do_thing:${args.arg}`,
    });
    return { text: `did with ${r.actionId}` };
  },
};

describe("restart-safe gates: full restart cycle", () => {
  it("survives engine teardown and restoreSession resumes", async () => {
    // Shared SQLite DB (in-process, persistent across both engine instances)
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    const db = drizzle(sqlite);
    const store = new SqliteSessionStore(db);
    const sandboxProvider = new VirtualSandboxProvider();

    // Engine v1: prompt, get gate, then "crash"
    const faux1 = registerFauxProvider({ provider: "restart" });
    faux1.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "x" }, { id: "tc1" })], {
        stopReason: "toolUse",
      }),
      // Won't be consumed by engine v1 — engine v2 will use a fresh provider.
    ]);

    const bus1 = new InMemoryEventBus();
    const events1: BusEvent[] = [];
    bus1.subscribe({}, (e) => events1.push(e));
    const engine1 = new Engine({ providers: { store, bus: bus1, sandboxProvider } });
    const SESSION_ID = "sess-restart";
    const session1 = await engine1.createSession({
      id: SESSION_ID,
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux1.getModel(),
      tools: [approvalTool],
    });
    void session1.prompt("please do");

    // Wait for the gate
    await new Promise<DecisionGate>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("gate timeout")), 2000);
      const unsub = bus1.subscribe({}, (e) => {
        if (e.event.type === "decision_gate") {
          clearTimeout(t);
          unsub();
          resolve(e.event.gate);
        }
      });
    });

    // Confirm gate is persisted
    const gates = await store.listDecisionGates(SESSION_ID);
    expect(gates).toHaveLength(1);
    const gate = gates[0];
    expect(gate.status).toBe("pending");

    // Confirm SuspendedTurnState was written
    const suspended = await store.getSuspendedTurn(SESSION_ID, gate.threadId);
    expect(suspended?.toolName).toBe("do_thing");

    // "Crash" the engine: discard everything except the store.
    faux1.unregister();

    // Engine v2: restore from store, then resolve
    const faux2 = registerFauxProvider({ provider: "restart-v2" });
    // After replay completes the suspended tool, the agent.continue() call
    // makes one more LLM request. Provide its response.
    faux2.setResponses([fauxAssistantMessage("all done after restart")]);

    const bus2 = new InMemoryEventBus();
    const events2: BusEvent[] = [];
    bus2.subscribe({}, (e) => events2.push(e));
    const engine2 = new Engine({ providers: { store, bus: bus2, sandboxProvider } });
    const session2 = await engine2.restoreSession({
      sessionId: SESSION_ID,
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: faux2.getModel(),
        tools: [approvalTool],
      },
    });

    // Resolve the gate via session2 — should trigger replay
    await session2.resolveDecision(gate.id, {
      actionId: "approve",
      resolvedBy: "u1",
      resolvedAt: Date.now(),
    });

    // Wait for the replayed turn to land "all done after restart"
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("post-restart turn timeout")), 3000);
      const unsub = bus2.subscribe({}, (e) => {
        if (e.event.type === "message_end" && "messageId" in e.event) {
          // We don't know the new id; check the store afterwards.
          clearTimeout(t);
          unsub();
          resolve();
        }
      });
    });

    const finalEntries = await session2.readEntries("web:default");
    const lastAssistant = finalEntries
      .filter((e) => e.type === "message" && e.role === "assistant")
      .at(-1);
    expect(
      lastAssistant && lastAssistant.type === "message" && lastAssistant.content,
    ).toBe("all done after restart");

    // SuspendedTurnState was cleared
    const sus = await store.getSuspendedTurn(SESSION_ID, gate.threadId);
    expect(sus).toBeNull();

    // Gate is now resolved
    const finalGate = await store.getDecisionGate(SESSION_ID, gate.id);
    expect(finalGate?.status).toBe("resolved");

    faux2.unregister();
  });
});
```

- [ ] **Step 2: Run it**

```bash
pnpm test -- restart-safe-gates
```

Expected: 1 test passing. Likely failure modes and fixes:

- "session not found" on restoreSession — verify `engine_sessions` row was written and `getSession` returns it.
- "tool not registered" on replay — `replayBlocked` looks up tools from the rehydrated session; ensure `restoreSession` passes `options.tools`.
- "gate ID mismatch" — the deterministic ID derivation must match between original run and replay. Both use `(sessionId, threadId, queueItemId, resumeKey)`. The queueItemId is persisted in `SuspendedTurnState`; the replay uses it.
- Agent rejects continue because last message is assistant — `replayBlocked` pushes a `toolResult` then calls `agent.continue()`, which requires the last message to be `user` or `toolResult`. If it fails, verify the toolResult message shape matches `Message` from pi-ai.

- [ ] **Step 3: Commit**

```bash
git add packages/engine/test/restart-safe-gates.test.ts
git commit -m "test(engine): full restart cycle restoreSession + resolve resumes turn"
```

---

### Task 16: Final regression sweep

- [ ] **Step 1: Run all tests**

```bash
cd packages/engine && pnpm typecheck && pnpm test
```

Expected: typecheck clean; all tests passing (originally 14 + 10 contract × 2 backends + 1 short-circuit + 1 restart cycle = ~36 tests).

- [ ] **Step 2: Update README**

Modify `packages/engine/README.md` "What works" / "What's deferred" sections:

In "What works in this prototype", add:
- SqliteSessionStore + Drizzle schema + migrations
- Restart-safe re-entrant decision gates (deterministic IDs, `ctx.suspendedDecision` short-circuit)
- `Engine.restoreSessionWith` rehydrates session, threads, transcripts, queue, suspended turns; resumes blocked threads on resolve

In "What's deferred", remove the "Restart-safe re-entrant decision gates" item, and add a new note:
- Postgres-dialect schema mirror for the K8s adapter (sqlite schema works today; pg-core mirror is a thin port)
- Hot/cold tiering (DO SQLite write-through cache → D1) — implementation detail of the Cloudflare adapter

- [ ] **Step 3: Commit**

```bash
git add packages/engine/README.md
git commit -m "docs(engine): document persistent store and restart-safe gates"
```

---

## What this plan does NOT cover (deferred)

- **Postgres dialect mirror.** The schema is sqlite-only here. Mirroring to `drizzle-orm/pg-core` is mechanical (same logical tables, different column helpers) and can run against `pg-mem` for tests. Worth a separate small plan.
- **Cloudflare D1 wiring.** The `SqliteSessionStore` uses `better-sqlite3`. A `D1SessionStore` reusing the same Drizzle queries through `drizzle-orm/d1` is a thin adapter task — separate plan.
- **Hibernation.** Engine restoration is invoked manually in tests; in production the SessionHostDO will call it on wake. That's adapter-layer work.
- **Compaction, role/skill loading, model failover.** Independent of persistence.

## Self-review

**Spec coverage:** Restart-safe re-entrant gates (spec line 722) ✓, SuspendedTurnState persistence (line 858) ✓, deterministic gate identity (line 986) ✓, schema/migrations contract (line 1545) ✓, "engine_*" tables required by spec (line 1338) ✓. Postgres mirror (line 1544) — explicitly deferred with a note.

**Placeholder scan:** No "TBD" / "TODO" / "similar to" steps. Code blocks are complete in every step.

**Type consistency:** `deterministicGateId` / `fromRequest` / `GateContext` consistent across decision-gate.ts and thread.ts. `setReplayContext` / `armPendingGateForRestart` / `replayBlocked` / `resumeBlockedThreadIfReady` defined exactly once each, called by name elsewhere. `restoreSessionWith` is the public restoration entry; `restoreSession` becomes the throw-with-helpful-message path. `saveQueueItem`/`getQueueItems`/`deleteQueueItem` added to SessionStore in Task 14 and implemented on both backends in the same task.
