---
# valet-mj3a
title: "Memory Journal and Auto-Load"
status: todo
type: epic
priority: high
tags:
    - memory
    - orchestrator
    - agent-tools
    - context
depends_on:
    - valet-mf5v
created_at: 2026-02-28T00:00:00Z
updated_at: 2026-02-28T00:00:00Z
---

Add three features on top of the memory file system facade (bean mf5v): **daily journal auto-creation**, **automatic memory loading at session start**, and **pinned/evergreen files**. Together these give the orchestrator ambient context without requiring explicit `mem_read` calls at the start of every conversation — it wakes up already knowing who it's talking to and what happened yesterday.

## Problem

Today the orchestrator starts every conversation with zero context. The system prompt tells it to call `memory_read` at the start of tasks that might have prior context, but:

1. **The agent has to decide when to read.** It often doesn't — especially for quick follow-ups or when it doesn't know what to search for. First messages from Slack are particularly bad: the agent gets a message, has no idea who the user is or what projects they work on, and has to make a `memory_read` call before it can respond intelligently.

2. **There's no "what happened recently" context.** The agent can search for keywords, but it can't ask "what did I do yesterday?" without knowing what to search for. OpenClaw solves this with daily log files that are auto-loaded.

3. **Important memories can be evicted.** The 200-memory cap with lowest-relevance pruning means a user's core preferences can be pushed out by a flood of project-specific memories. There's no way to mark memories as "never prune this."

### What OpenClaw gets right

- **Daily logs** (`memory/YYYY-MM-DD.md`): Append-only. Today's and yesterday's are auto-loaded at session start. The agent always has recent context.
- **Evergreen files** (`MEMORY.md`): Always loaded, never subject to temporal decay. Core preferences persist.
- **Pre-compaction flush**: Before context compression, the agent is prompted to write important information to memory files. This prevents context loss during long sessions.

We can do all three. Our DB-backed storage makes the implementation cleaner than OpenClaw's file-watching approach.

## Design

### 1. Daily Journal

#### Auto-creation

When the orchestrator session starts (or restarts), the system checks if today's journal file exists. If not, it creates `journal/YYYY-MM-DD.md` with a minimal header:

```markdown
# 2026-02-28

```

The file is created with `pinned = 0` (journals are prunable) and `relevance = 1.0`.

This happens in the SessionAgentDO's orchestrator startup path — the same code that currently spawns the orchestrator session and injects the system prompt. No new cron job or trigger needed.

#### Agent interaction

The agent appends to today's journal using `mem_patch`:

```
mem_patch("journal/2026-02-28.md", [
  { op: "append", content: "\n\n## 14:30 — Deployed Slack fixes\n\n- Fixed channel reply using org-level bot token\n- Mention resolution via bots.info API" }
])
```

One tool call, no read required. The `append` operation is the natural fit for journals — the agent never needs to see the existing content just to add an entry. This is why `mem_patch` exists (bean mf5v).

#### Journal cleanup

Journals older than 30 days are candidates for auto-pruning (they're not pinned). The existing cap-based pruning handles this naturally — old, low-relevance journals get evicted when the memory store fills up. No separate cleanup job needed.

If the agent decides a journal entry contains durable knowledge (e.g., an architectural decision made that day), it should extract that into a persistent file (`projects/valet/decisions.md`) and let the journal be pruned eventually.

### 2. Auto-Load Memories at Session Start

#### What gets loaded

When the orchestrator session starts, the system automatically reads and injects a set of memories into the initial system prompt context. This replaces the current pattern where the agent has to manually call `memory_read` at the beginning of each conversation.

**Always loaded (pinned files):**

All files with `pinned = 1` are loaded into the system prompt. These are the user's core preferences and important persistent context.

Query: `SELECT path, content FROM orchestrator_memory_files WHERE user_id = ? AND pinned = 1 ORDER BY path`

**Always loaded (recent journals):**

Today's and yesterday's journal entries are loaded.

Query: `SELECT path, content FROM orchestrator_memory_files WHERE user_id = ? AND path IN ('journal/YYYY-MM-DD.md', 'journal/YYYY-MM-DDminus1.md')`

**Total injection budget: 8,000 tokens.** If pinned files + journals exceed this, truncate journals first (they're less important than preferences). If pinned files alone exceed 8,000 tokens, truncate the least-recently-accessed pinned files. This budget is a constant in the codebase, easily tunable.

#### How it's injected

The loaded memories are formatted as a "memory snapshot" block appended to the orchestrator system prompt:

```markdown
---

## Memory Snapshot (auto-loaded)

The following files were loaded from your memory at session start. You do NOT need to call `mem_read` for these — they're already in context.

### preferences/coding-style.md
Prefers TypeScript, pnpm, Hono for APIs. Uses kebab-case for files, camelCase for variables.

### preferences/communication.md
Prefers concise responses. No emojis unless asked. Direct and technical.

### projects/valet/repo.md
GitHub: https://github.com/connerswann/valet.git
Stack: Cloudflare Workers + D1 + React + Modal
Deploy: `make deploy` from project root

### journal/2026-02-28.md
# 2026-02-28

## 10:00 — Fixed Slack mentions
Deployed mention resolution using bots.info API. Bot mentions now show @Valet instead of raw user IDs.

### journal/2026-02-27.md
# 2026-02-27

## 15:30 — Slack channel integration
Implemented org-level bot token for Slack replies. Thread routing via composite channelId.
```

This block is appended once at session start and doesn't update during the session. The agent can call `mem_read` at any time for fresh data — the snapshot is just the starting context.

#### Implementation location

The memory snapshot injection happens in the orchestrator startup path in `SessionAgentDO`. Currently, the orchestrator session startup:

1. Creates the session
2. Builds the system prompt from `orchestrator-persona.ts`
3. Spawns the sandbox with the prompt

Step 2 is where we add the memory snapshot. The function `buildOrchestratorPrompt(env, userId)` needs to:
- Query pinned files
- Query recent journals
- Format into the snapshot block
- Append to the base persona prompt
- Respect the token budget

This function lives in `orchestrator-persona.ts` and is async (it needs DB access).

### 3. Pinned / Evergreen Files

#### What gets pinned

Files are pinned based on their path:

- **`preferences/*`** — auto-pinned on write. Any file under `preferences/` gets `pinned = 1`.
- **Any file the agent explicitly pins** — via a path convention: `_pinned/` prefix or a future `mem_pin` tool. For V1, auto-pinning `preferences/` is sufficient. The agent can manually set `pinned` by writing to `preferences/` or by the system prompt instructing it to store durable info there.

#### Pinned files and pruning

The cap logic (from bean mf5v) is:

```
total_non_pinned = COUNT(*) WHERE user_id = ? AND pinned = 0
if total_non_pinned > MEMORY_CAP:
  DELETE lowest-relevance, oldest-accessed non-pinned files
```

Pinned files are invisible to the pruning system. A user could theoretically have 50 pinned files and 200 unpinned files without any pruning. The cap only governs the unpinned pool.

#### Pinning in the schema

The `pinned` column already exists in the mf5v schema. This bean adds:
- Auto-pin logic in `writeMemoryFile()` — if path starts with `preferences/`, set `pinned = 1`
- Exclusion from pruning in the cap-check query

### 4. Contextual Auto-Load (Optional Enhancement)

Beyond the always-loaded files, we can optionally load project-specific memories based on the first inbound message:

**When a message arrives via Slack from a channel bound to a specific session:**
- Look up the session's workspace/repo
- Auto-load `projects/<repo-name>/*.md` files

**When a message mentions a known project name:**
- FTS match against project memory paths
- Include relevant project files in the response context

This is a stretch goal for this bean. The always-loaded preferences + journals provide the most value. Contextual loading can be added incrementally without schema changes — it's just an additional query in the prompt-building step.

## Implementation

### Phase 1: Pinned Files

1. Add auto-pin logic to `writeMemoryFile()` in `memory-files.ts`:
   ```typescript
   const pinned = path.startsWith('preferences/') ? 1 : 0;
   ```

2. Update cap-check query to exclude pinned files:
   ```sql
   SELECT COUNT(*) FROM orchestrator_memory_files WHERE user_id = ? AND pinned = 0
   ```

3. Update prune query:
   ```sql
   DELETE FROM orchestrator_memory_files
   WHERE id IN (
     SELECT id FROM orchestrator_memory_files
     WHERE user_id = ? AND pinned = 0
     ORDER BY relevance ASC, last_accessed_at ASC
     LIMIT ?
   )
   ```

### Phase 2: Daily Journal Auto-Creation

1. Add `ensureTodayJournal(db, userId)` function to `memory-files.ts`:
   ```typescript
   export async function ensureTodayJournal(rawDb: D1Database, userId: string): Promise<void> {
     const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
     const path = `journal/${today}.md`;
     const existing = await readMemoryFile(getDb(rawDb), userId, path);
     if (existing) return;
     await writeMemoryFile(rawDb, userId, path, `# ${today}\n\n`);
   }
   ```

2. Call from orchestrator session startup in `SessionAgentDO` (in the `startOrchestrator` flow, after session creation and before sending the first prompt).

### Phase 3: Auto-Load at Session Start

1. Add `loadMemorySnapshot(db, userId, tokenBudget)` function to a new file `packages/worker/src/lib/memory-snapshot.ts`:

   ```typescript
   interface MemorySnapshot {
     files: { path: string; content: string }[];
     totalTokensEstimate: number;
     truncated: boolean;
   }

   export async function loadMemorySnapshot(
     db: D1Database,
     userId: string,
     tokenBudget: number = 8000,
   ): Promise<MemorySnapshot>
   ```

   Logic:
   - Query all pinned files, ordered by path
   - Query today's + yesterday's journal
   - Estimate tokens (rough: chars / 4)
   - If over budget: truncate journals first, then least-recently-accessed pinned files
   - Return the files that fit

2. Add `formatMemorySnapshot(snapshot)` function that renders the markdown block shown above.

3. Update `buildOrchestratorSystemPrompt()` in `orchestrator-persona.ts`:
   - Make it async (currently sync string template)
   - Accept `env` and `userId` parameters
   - Call `loadMemorySnapshot()`
   - Append formatted snapshot to the base prompt
   - Return the complete prompt

4. Update the caller in `SessionAgentDO` to await the async prompt builder.

### Phase 4: System Prompt Updates

Update the Memory section in `orchestrator-persona.ts` to:
- Explain that preferences and recent journals are auto-loaded
- Tell the agent it doesn't need to `mem_read` for those at session start
- Instruct the agent to append to today's journal for notable events
- Instruct the agent to store durable info in `preferences/` for things that should always be loaded

## Files to Create

| File | Purpose |
|---|---|
| `packages/worker/src/lib/memory-snapshot.ts` | `loadMemorySnapshot()` + `formatMemorySnapshot()` |

## Files to Modify

| File | Change |
|---|---|
| `packages/worker/src/lib/db/memory-files.ts` | Add `ensureTodayJournal()`, auto-pin logic, pinned-aware pruning |
| `packages/worker/src/lib/orchestrator-persona.ts` | Make prompt builder async, inject memory snapshot |
| `packages/worker/src/durable-objects/session-agent.ts` | Call `ensureTodayJournal()` on orchestrator start, await async prompt builder |
| `packages/shared/src/types/index.ts` | Add `MemorySnapshot` type if needed for API surface |

## Relationship to Other Beans

- **valet-mf5v (Memory File System Facade)** — Hard dependency. This bean builds on top of the path-based schema, `mem_read`/`mem_write` tools, and pinned column introduced by mf5v. Must be implemented after mf5v.
- **valet-cf0x (Decouple from CF)** — The FTS queries in `memory-files.ts` are raw SQL. The `SearchProvider` abstraction from cf0x Phase 1 will eventually wrap these. No conflict — this bean adds new raw SQL queries in the same pattern as the existing ones.

## Open Questions

1. **Token budget for memory snapshot.** 8,000 tokens is a rough starting point — roughly 32KB of text. Too little and preferences get truncated. Too much and the system prompt bloats, reducing the agent's working context. Should this be configurable per user or per org? Recommendation: start with 8,000 as a hardcoded constant, make it configurable later if needed.

2. **Journal append semantics.** Solved by `mem_patch` (bean mf5v). The agent calls `mem_patch("journal/...", [{ op: "append", content: "..." }])` — one tool call, no read required. No separate `mem_append` tool needed.

3. **Memory snapshot staleness.** The snapshot is injected once at session start. If the agent updates a preference during the session, the snapshot in the system prompt is stale. This is fine — the agent knows it just wrote the file, and `mem_read` returns fresh data. The snapshot is a starting-context optimization, not a live view.

4. **Pre-compaction memory flush.** OpenClaw triggers a silent agentic turn before context compression, reminding the agent to write important context to memory. We should add this, but it depends on how context compaction works in our system (OpenCode's `compaction.memoryFlush` config). This may be better as a separate small bean or a follow-up to this one. Recommendation: defer to a follow-up — the journal + auto-load covers 80% of the value. Pre-compaction flush is an optimization.

5. **Multiple orchestrator restarts per day.** If the orchestrator crashes and restarts 5 times in one day, `ensureTodayJournal` is called each time but is idempotent (no-op if the file exists). The journal accumulates naturally through the day's appends. No issue.

## Acceptance Criteria

- [ ] Files under `preferences/` are auto-pinned (`pinned = 1`) on write
- [ ] Pinned files are excluded from auto-prune cap checks
- [ ] `journal/YYYY-MM-DD.md` is auto-created on orchestrator session start
- [ ] Journal auto-creation is idempotent (no-op if today's journal exists)
- [ ] Memory snapshot loaded at orchestrator start: pinned files + today's/yesterday's journal
- [ ] Memory snapshot respects token budget (8,000 tokens default)
- [ ] Snapshot formatted as markdown and appended to system prompt
- [ ] If snapshot exceeds budget: journals truncated first, then least-recently-accessed pinned files
- [ ] System prompt Memory section updated with file-system-oriented instructions
- [ ] Agent instructed to append to daily journal for notable events
- [ ] Agent instructed that preferences + journals are auto-loaded (no need for explicit `mem_read` at start)
- [ ] `pnpm typecheck` passes
- [ ] Orchestrator starts with ambient context (preferences + recent activity) without any tool calls
