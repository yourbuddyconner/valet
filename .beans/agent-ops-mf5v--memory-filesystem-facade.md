---
# valet-mf5v
title: "Memory File System Facade"
status: done
type: epic
priority: high
tags:
    - memory
    - architecture
    - agent-tools
    - orchestrator
created_at: 2026-02-28T00:00:00Z
updated_at: 2026-02-28T00:00:00Z
---

Replace the current `memory_read` / `memory_write` / `memory_delete` / `memory_prune` tool interface with a virtual file system that the agent interacts with using familiar path-based operations. The agent thinks it's reading and writing markdown files. The backend remains D1 with FTS5. The path encodes structure (category, project, topic) and replaces the UUID + category fields. This is a breaking change to the memory tool interface but not to the storage layer — the migration reshapes the DB schema and tool surface while preserving existing memory content.

## Problem

The current memory system works but feels foreign to the agent. The agent calls `memory_write(content: "...", category: "project")` which is an API-shaped operation — it doesn't map to how coding agents naturally think about persistent information. The agent has to remember 6 category enums, understand relevance scoring, and use a separate `memory_prune` tool for cleanup. There's no hierarchy, no way to update a specific memory in place, and no way to organize information by project or topic.

OpenClaw's insight is that **files are the natural interface for persistent knowledge**. Their agent reads and writes `MEMORY.md` and `memory/YYYY-MM-DD.md` — it's just editing files. The agent already knows how to work with files. There's zero cognitive overhead.

Our advantage over OpenClaw is that we store memories in a database, which gives us FTS, relevance scoring, access tracking, and capacity management for free. The file system is a facade — the agent sees paths, the backend sees rows.

### Current tool surface (4 tools, 12 parameters total)

```
memory_read(category?, query?, limit?)
memory_write(content, category)
memory_delete(memoryId)
memory_prune(category?, query?, olderThanDays, relevanceAtMost, keepLatest, maxScan, maxDeletes, dryRun)
```

The agent must learn a bespoke API with 6 category enums, UUID-based deletion, and a complex prune tool with 8 parameters.

### Proposed tool surface (5 tools, intuitive)

```
mem_read(path)                          → returns file content (or directory listing)
mem_write(path, content)                → creates or overwrites a file
mem_patch(path, operations)             → surgical edits: append, prepend, or find-and-replace
mem_rm(path)                            → deletes a file
mem_search(query, path?)                → FTS across all files (optionally scoped to a subtree)
```

The agent already knows how `read`, `write`, `patch`, `rm`, and `search` work. The path encodes everything the old `category` field encoded, plus hierarchy.

## Design

### Virtual File System Structure

```
/
├── preferences/
│   ├── coding-style.md
│   ├── communication.md
│   └── tools.md
├── projects/
│   ├── valet/
│   │   ├── architecture.md
│   │   ├── repo.md
│   │   └── decisions.md
│   └── other-project/
│       └── overview.md
├── workflows/
│   ├── deploy.md
│   └── pr-review.md
├── journal/
│   ├── 2026-02-28.md
│   └── 2026-02-27.md
└── notes/
    └── team.md
```

**Top-level directories map to the old categories**, but they're not enforced as enums:

| Old Category | New Convention | Notes |
|---|---|---|
| `preference` | `preferences/` | User likes, coding style, tool choices |
| `project` | `projects/<name>/` | Per-project knowledge, repo URLs |
| `workflow` | `workflows/` | Recurring processes |
| `decision` | Lives inside `projects/<name>/decisions.md` or `decisions/` | Collocated with project context |
| `context` | Lives inside `projects/<name>/` | Merged with project — "context" was always project-specific |
| `general` | `notes/` | Catch-all |
| (new) | `journal/` | Daily logs, inspired by OpenClaw |

The agent is free to create any path structure. The conventions above are documented in the system prompt, not enforced by the schema.

### Schema Change

#### Current schema (`orchestrator_memories`)

```sql
id TEXT PRIMARY KEY,
user_id TEXT NOT NULL,
org_id TEXT NOT NULL DEFAULT 'default',
category TEXT NOT NULL,         -- enum: preference|workflow|context|project|decision|general
content TEXT NOT NULL,
relevance REAL NOT NULL DEFAULT 1.0,
created_at TEXT NOT NULL,
last_accessed_at TEXT NOT NULL
```

#### New schema (`orchestrator_memory_files`)

```sql
CREATE TABLE orchestrator_memory_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT 'default',
  path TEXT NOT NULL,               -- e.g. "projects/valet/architecture.md"
  content TEXT NOT NULL,
  relevance REAL NOT NULL DEFAULT 1.0,
  pinned INTEGER NOT NULL DEFAULT 0,  -- 1 = never auto-pruned
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_memory_files_user_path ON orchestrator_memory_files(user_id, path);
CREATE INDEX idx_memory_files_user ON orchestrator_memory_files(user_id);
CREATE INDEX idx_memory_files_prefix ON orchestrator_memory_files(user_id, path);
```

Key changes from current:
- **`path` replaces `category`** — the path is the identity. `path` is unique per user.
- **`pinned` flag** — marks files that should never be auto-pruned (e.g., `preferences/`).
- **`version` counter** — incremented on each write. Enables "what changed" awareness without full version history (that's a future enhancement).
- **`updated_at` replaces implicit create-only** — `mem_write` to an existing path updates in place instead of creating a duplicate.
- **No `last_accessed_at` removal** — keep it for relevance boosting and prune decisions.

#### FTS Index

```sql
CREATE VIRTUAL TABLE orchestrator_memory_files_fts USING fts5(
  path,
  content,
  content_rowid='rowid',
  tokenize='porter unicode61'
);
```

FTS now indexes `path` as well as `content`. This means `mem_search("valet")` matches both files with "valet" in the content AND files under `projects/valet/`.

### Path Rules

1. **Paths are relative** — no leading `/`. Always like `preferences/coding-style.md`.
2. **Lowercase, kebab-case** — normalized on write. `Projects/Valet/Arch.md` → `projects/valet/arch.md`.
3. **`.md` extension optional but conventional** — the system doesn't enforce it, but the prompt encourages it.
4. **Max depth: 4 levels** — `a/b/c/d.md` is fine, `a/b/c/d/e/f.md` is rejected. Prevents pathological nesting.
5. **Max path length: 256 chars** — reasonable limit.
6. **No traversal** — `..` is stripped. Paths are always relative to the user's memory root.
7. **Directories are virtual** — they exist only if files exist under them. `mem_read("projects/")` returns a listing computed from path prefixes. No directory table.

### Tool Implementations

#### `mem_read(path)`

Two modes based on whether the path ends with `/` or refers to a file:

**File read** (`mem_read("projects/valet/architecture.md")`):
- Query: `SELECT * FROM orchestrator_memory_files WHERE user_id = ? AND path = ?`
- Returns the file content as plain text
- Boosts relevance (+0.1, capped at 2.0) and updates `last_accessed_at`
- If file doesn't exist: returns empty string with a note (not an error — matches OpenClaw's graceful missing-file behavior)

**Directory listing** (`mem_read("projects/")` or `mem_read("")` for root):
- Query: `SELECT path, updated_at, LENGTH(content) as size FROM orchestrator_memory_files WHERE user_id = ? AND path LIKE ?`
- Returns a formatted listing:

```
projects/
  valet/
    architecture.md    (1.2 KB, updated 2h ago)
    repo.md            (0.3 KB, updated 3d ago)
    decisions.md       (0.8 KB, updated 1d ago)
  other-project/
    overview.md        (0.5 KB, updated 5d ago)
```

Listing is computed by grouping paths by their next path component relative to the requested prefix. This gives the illusion of a directory tree without storing directories.

#### `mem_write(path, content)`

- Normalize path (lowercase, kebab-case, strip `..`, enforce max depth/length)
- Upsert: `INSERT INTO ... ON CONFLICT(user_id, path) DO UPDATE SET content = ?, version = version + 1, updated_at = datetime('now')`
- Sync FTS index (delete old row if exists, insert new)
- Run cap check (same logic as current — delete lowest-relevance, least-recently-accessed if over cap)
- Return: `"Written: projects/valet/architecture.md (v3, 1.2 KB)"`

Writing to an existing path **replaces the content** — this is the "edit file" semantic. The agent doesn't need to delete-then-create to update a memory. The version counter increments so the agent can see it's been edited.

#### `mem_patch(path, operations)`

Surgical edits to an existing file without requiring a full read-then-rewrite cycle. This is the workhorse tool for journal entries (append a new section), evolving project files (replace an outdated fact), and any case where the agent knows what it wants to change but doesn't need to rewrite the whole document.

**Parameters:**

```typescript
{
  path: string,
  operations: Array<
    | { op: "append", content: string }          // add to end of file
    | { op: "prepend", content: string }         // add to beginning of file
    | { op: "replace", old: string, new: string } // find-and-replace (first match)
    | { op: "replace_all", old: string, new: string } // find-and-replace (all matches)
    | { op: "insert_after", anchor: string, content: string }  // insert content after first line matching anchor
    | { op: "delete_section", heading: string }  // delete from heading to next same-level heading
  >
}
```

Operations are applied sequentially to the file content. If the file doesn't exist, `append` and `prepend` create it (like `mem_write`); other operations fail gracefully with a "file not found" note.

**Why this matters:**

1. **Journal appends.** The single most common memory write is "append today's entry to the journal." Without `mem_patch`, this requires `mem_read` → concatenate → `mem_write` — two tool calls and the full file content round-tripping through the agent's context. With `mem_patch`:
   ```
   mem_patch("journal/2026-02-28.md", [
     { op: "append", content: "\n\n## 14:30 — Deployed Slack fixes\n\nFixed mention resolution using bots.info API." }
   ])
   ```
   One tool call. No read required. No context wasted on existing content.

2. **Fact updates.** A project file says "Deploy: `make deploy-staging`" but the process changed. Without patch, the agent reads the whole file, finds the line, changes it, writes the whole file back. With patch:
   ```
   mem_patch("projects/valet/overview.md", [
     { op: "replace", old: "Deploy: `make deploy-staging`", new: "Deploy: `make deploy`" }
   ])
   ```

3. **Section management.** Large project files accumulate sections. `delete_section` removes a heading and everything under it up to the next same-level heading. `insert_after` adds content at a precise location.

**Implementation:**

The backend applies operations server-side. The DB helper:

```typescript
async function patchMemoryFile(
  rawDb: D1Database,
  userId: string,
  path: string,
  operations: PatchOperation[],
): Promise<{ content: string; version: number; applied: number; skipped: string[] }>
```

1. Read the current content (single SELECT)
2. Apply operations sequentially, collecting skip reasons for operations that can't match
3. Write back with version bump and FTS resync (single upsert)
4. Return the result with applied/skipped counts so the agent knows what happened

If no operations actually changed the content (e.g., all `replace` operations had no matches), the version is not bumped and no write occurs. This prevents pointless FTS reindexing.

**Error handling per operation:**

| Operation | File doesn't exist | Match not found |
|---|---|---|
| `append` | Creates file with content | N/A |
| `prepend` | Creates file with content | N/A |
| `replace` | Skipped, reported | Skipped, reported |
| `replace_all` | Skipped, reported | Skipped, reported (0 replacements) |
| `insert_after` | Skipped, reported | Skipped, reported |
| `delete_section` | Skipped, reported | Skipped, reported |

Skipped operations don't fail the whole patch — the agent gets a summary like `"Patched: journal/2026-02-28.md (v4, 2 applied, 1 skipped: replace 'old text' not found)"`. This mirrors how a real editor handles find-and-replace misses.

**`delete_section` semantics:**

Finds the first line matching the heading (e.g., `## Old Section`), then deletes everything from that line to (but not including) the next heading of the same or higher level. This is markdown-aware:

```markdown
## Keep This
Some content.

## Delete This        ← heading match
Content to delete.
More content.

## Also Keep This     ← stops here (same level heading)
```

`delete_section("## Delete This")` removes the heading and its content, leaving a clean document.

#### `mem_rm(path)`

- If path ends with `/`: delete all files under that prefix (with confirmation count)
- If path is a file: delete that single file
- Clean up FTS index
- Return: `"Deleted: projects/old-project/ (3 files removed)"`

#### `mem_search(query, path?)`

- Tokenize query, build FTS MATCH expression (same logic as current)
- If `path` is provided, add `AND path LIKE ?` to scope the search to a subtree
- Return results as a formatted list with path, relevance snippet, and match context:

```
Found 3 matches for "deployment":

1. workflows/deploy.md (relevance: 1.8)
   ...run `make deploy` which handles worker + modal + client...

2. projects/valet/architecture.md (relevance: 1.5)
   ...deployment uses Cloudflare Workers with D1...

3. journal/2026-02-27.md (relevance: 1.0)
   ...deployed the Slack fix today, had to manually run migration...
```

### Data Migration

Migration `0046_memory_filesystem.sql`:

```sql
-- Create new table
CREATE TABLE orchestrator_memory_files ( ... );

-- Migrate existing memories: category becomes top-level directory
-- The path is derived as: category/memory-id.md (since existing memories don't have meaningful names)
-- Agent will organically reorganize these as it encounters them
INSERT INTO orchestrator_memory_files (id, user_id, org_id, path, content, relevance, pinned, version, created_at, updated_at, last_accessed_at)
SELECT
  id, user_id, org_id,
  category || '/' || SUBSTR(id, 1, 8) || '.md',   -- e.g. "project/a1b2c3d4.md"
  content, relevance, 0, 1, created_at, created_at, last_accessed_at
FROM orchestrator_memories;

-- Create FTS index and populate
CREATE VIRTUAL TABLE orchestrator_memory_files_fts USING fts5( ... );
INSERT INTO orchestrator_memory_files_fts(rowid, path, content)
  SELECT rowid, path, content FROM orchestrator_memory_files;

-- Drop old table (after verifying migration)
DROP TABLE IF EXISTS orchestrator_memories_fts;
DROP TABLE IF EXISTS orchestrator_memories;
```

The migration creates paths like `project/a1b2c3d4.md` — not beautiful, but functional. The agent will encounter these and naturally reorganize them into better paths (e.g., `mem_write("projects/valet/overview.md", ...)` then `mem_rm("project/a1b2c3d4.md")`). The system prompt can include a one-time instruction to consolidate migrated memories.

### System Prompt Changes

Replace the current "Memory" section in `orchestrator-persona.ts` with file-system-oriented instructions:

```markdown
## Memory

You have a persistent file system for long-term memory. Files are markdown documents
organized by topic. Your memory persists across conversations and sandbox restarts.

### Tools

- `mem_read("preferences/")` — list all preference files
- `mem_read("projects/valet/architecture.md")` — read a specific file
- `mem_write("projects/valet/repo.md", "GitHub: https://github.com/...")` — create or overwrite a file
- `mem_patch("journal/2026-02-28.md", [{ op: "append", content: "\n\n## 14:30 — Fix deployed" }])` — append to a file without reading it first
- `mem_patch("projects/valet/overview.md", [{ op: "replace", old: "old fact", new: "new fact" }])` — surgical edit
- `mem_rm("notes/outdated.md")` — delete a file
- `mem_search("deployment")` — search across all memory files

### File Organization

Organize memories like you'd organize notes in a folder:

| Directory | What goes here |
|---|---|
| `preferences/` | User coding style, tool choices, communication preferences |
| `projects/<name>/` | Per-project knowledge: repo URL, architecture, decisions, conventions |
| `workflows/` | Recurring processes: deploy steps, PR review process, testing approach |
| `journal/` | Daily notes and context (auto-created, see below) |
| `notes/` | Anything else worth remembering |

### When to write

- Store repo URLs immediately when you learn them — saves lookup calls later
- Record user preferences that affect how you work
- After completing significant work, update the project file with what you learned
- Before spawning a child session, write relevant context so you can brief the child

### Editing vs. creating

`mem_write` **replaces the entire file**. Use it for new files or complete rewrites.
`mem_patch` **edits in place** — use it to append journal entries, update specific facts,
or insert sections. Prefer `mem_patch` over read-then-write when you only need to change
part of a file.

Use `mem_read("projects/")` to check what exists before creating a new project file.
```

### Gateway Changes

#### New DB helpers (`packages/worker/src/lib/db/memory-files.ts`)

```typescript
// Core CRUD — all take AppDb except FTS operations which need D1Database
readMemoryFile(db, userId, path): Promise<MemoryFile | null>
listMemoryFiles(db, userId, pathPrefix): Promise<MemoryFileListing[]>
writeMemoryFile(rawDb, userId, path, content): Promise<MemoryFile>  // upsert + FTS sync
patchMemoryFile(rawDb, userId, path, operations): Promise<PatchResult>  // surgical edits + FTS sync
deleteMemoryFile(rawDb, userId, path): Promise<number>              // returns deleted count
deleteMemoryFilesUnderPath(rawDb, userId, pathPrefix): Promise<number>
searchMemoryFiles(rawDb, userId, query, pathPrefix?): Promise<MemoryFileSearchResult[]>
boostMemoryFileRelevance(db, userId, path): Promise<void>
```

#### New Drizzle schema (`packages/worker/src/lib/schema/memory-files.ts`)

Defines the `orchestratorMemoryFiles` table for Drizzle.

#### Gateway API routes (`packages/worker/src/routes/orchestrator.ts`)

Replace the three existing memory endpoints:

```
GET    /api/me/memory?path=...                → readMemoryFile or listMemoryFiles
PUT    /api/me/memory                         → writeMemoryFile (body: { path, content })
PATCH  /api/me/memory                         → patchMemoryFile (body: { path, operations })
DELETE /api/me/memory?path=...                → deleteMemoryFile(s)
GET    /api/me/memory/search?query=...&path=  → searchMemoryFiles
```

The old `/api/me/memories` endpoints are removed. The frontend memory panel (if any) needs updating.

#### Runner gateway routes (`packages/runner/src/gateway.ts`)

Replace the three existing memory callbacks:

```
GET    /api/memory?path=...                → onMemoryRead(path)
PUT    /api/memory                         → onMemoryWrite(path, content)
PATCH  /api/memory                         → onMemoryPatch(path, operations)
DELETE /api/memory?path=...                → onMemoryDelete(path)
GET    /api/memory/search?query=...&path=  → onMemorySearch(query, path?)
```

#### Agent client messages (`packages/runner/src/agent-client.ts`)

Replace `memory-read` / `memory-write` / `memory-delete` message types:

```
{ type: "mem-read", requestId, path }
{ type: "mem-write", requestId, path, content }
{ type: "mem-patch", requestId, path, operations }
{ type: "mem-rm", requestId, path }
{ type: "mem-search", requestId, query, path? }
```

#### SessionAgentDO handlers

Replace `handleMemoryRead` / `handleMemoryWrite` / `handleMemoryDelete` with five new handlers that call the new DB helpers.

#### OpenCode tools (`docker/opencode/tools/`)

Replace:
- `memory_read.ts` → `mem_read.ts`
- `memory_write.ts` → `mem_write.ts`
- `memory_delete.ts` → `mem_rm.ts`
- `memory_prune.ts` → removed (pruning is automatic; `mem_rm` handles explicit deletion)

New tools: `mem_patch.ts`, `mem_search.ts`

### Cap and Pruning

The current 200-memory cap and auto-prune logic carries over, with two changes:

1. **Pinned files are excluded from auto-prune.** Files with `pinned = 1` are never auto-deleted. The `preferences/` directory is auto-pinned (any file written under `preferences/` gets `pinned = 1`).

2. **The cap counts non-pinned files only.** If a user has 20 pinned files and 200 non-pinned files, only the non-pinned files are subject to pruning. This prevents the user's core preferences from being evicted by a flood of journal entries.

3. **`memory_prune` tool is removed.** The 8-parameter prune tool was over-engineered. Auto-pruning on write handles capacity. `mem_rm("journal/")` handles bulk cleanup. The agent doesn't need a policy engine.

## Files to Create

| File | Purpose |
|---|---|
| `packages/worker/migrations/0046_memory_filesystem.sql` | Schema migration + data migration |
| `packages/worker/src/lib/schema/memory-files.ts` | Drizzle schema for `orchestrator_memory_files` |
| `packages/worker/src/lib/db/memory-files.ts` | DB helpers (CRUD, patch, FTS, pruning) |
| `docker/opencode/tools/mem_read.ts` | `mem_read` tool |
| `docker/opencode/tools/mem_write.ts` | `mem_write` tool |
| `docker/opencode/tools/mem_patch.ts` | `mem_patch` tool |
| `docker/opencode/tools/mem_rm.ts` | `mem_rm` tool |
| `docker/opencode/tools/mem_search.ts` | `mem_search` tool |

## Files to Delete

| File | Reason |
|---|---|
| `docker/opencode/tools/memory_read.ts` | Replaced by `mem_read.ts` |
| `docker/opencode/tools/memory_write.ts` | Replaced by `mem_write.ts` |
| `docker/opencode/tools/memory_delete.ts` | Replaced by `mem_rm.ts` |
| `docker/opencode/tools/memory_prune.ts` | Removed — auto-prune + `mem_rm` covers this |

## Files to Modify

| File | Change |
|---|---|
| `packages/worker/src/lib/db/orchestrator.ts` | Remove all `orchestratorMemories` CRUD functions (moved to `memory-files.ts`) |
| `packages/worker/src/lib/schema/index.ts` | Export new `orchestratorMemoryFiles` schema, remove old `orchestratorMemories` |
| `packages/worker/src/lib/schema/orchestrator.ts` | Remove `orchestratorMemories` + `orchestratorMemoriesFts` table definitions |
| `packages/worker/src/routes/orchestrator.ts` | Replace `/api/me/memories` endpoints with `/api/me/memory` endpoints |
| `packages/worker/src/durable-objects/session-agent.ts` | Replace `handleMemoryRead/Write/Delete` with new `handleMemRead/Write/Rm/Search` |
| `packages/runner/src/gateway.ts` | Replace `/api/memories` routes with `/api/memory` routes |
| `packages/runner/src/agent-client.ts` | Replace `memory-*` message types with `mem-*` message types |
| `packages/runner/src/bin.ts` | Update gateway callback wiring |
| `packages/worker/src/lib/orchestrator-persona.ts` | Replace Memory section with file-system-oriented instructions |
| `packages/shared/src/types/index.ts` | Replace `OrchestratorMemory` + `OrchestratorMemoryCategory` with `MemoryFile` type |
| `packages/worker/src/lib/db.ts` | Update re-exports |

## Relationship to Other Beans

- **valet-cf0x (Decouple from CF)** — The FTS5 queries in `memory-files.ts` are raw SQL, same as the current memory system. These are covered by the `SearchProvider` abstraction in cf0x Phase 1. The new schema is Drizzle-first for all non-FTS operations.
- **valet-mj3a (Memory Journal and Auto-Load)** — This bean creates the file system facade. The journal bean (below) adds daily auto-creation, pre-compaction flush, and auto-loading on top of this foundation.

## Open Questions

1. **Path normalization strictness.** Should we enforce `.md` extension? Or allow any extension (`.json`, `.yaml`)? Recommendation: don't enforce — the convention is `.md` but the system shouldn't reject `projects/valet/config.json`. Content is always plain text regardless of extension.

2. **Frontend memory panel.** The current frontend may have a memory viewer. It needs updating to show the file tree instead of a flat list. This is a separate frontend task, not part of this bean.

3. **Org-level memories.** The current schema has `org_id` but it's always `'default'`. Should org-level memories (shared across users) be a separate path prefix like `_org/conventions.md`? Recommendation: defer to a future bean. Keep `org_id` in the schema but don't expose org-level paths yet.

4. **Concurrent writes.** Two sessions writing to the same path simultaneously could conflict. The upsert handles this at the DB level (last write wins), but the agent might lose content. Recommendation: acceptable for V1 — orchestrators are single-user, and the version counter provides visibility.

## Acceptance Criteria

- [ ] `orchestrator_memory_files` table created with path-based schema
- [ ] Existing memories migrated to path-based format (`category/short-id.md`)
- [ ] Old `orchestrator_memories` and `orchestrator_memories_fts` tables dropped
- [ ] `mem_read` tool reads files and lists directories
- [ ] `mem_write` tool creates and updates files (upsert by path)
- [ ] `mem_patch` tool applies surgical edits (append, prepend, replace, replace_all, insert_after, delete_section)
- [ ] `mem_patch` append/prepend creates file if it doesn't exist
- [ ] `mem_patch` skips unmatched operations gracefully and reports them
- [ ] `mem_patch` does not bump version or reindex FTS if no content actually changed
- [ ] `mem_rm` tool deletes files and subtrees
- [ ] `mem_search` tool performs FTS across all memory files
- [ ] FTS index includes both `path` and `content`
- [ ] Auto-prune respects `pinned` flag (preferences never pruned)
- [ ] Cap enforcement counts only non-pinned files
- [ ] Path normalization enforced (lowercase, kebab-case, no traversal, max depth 4)
- [ ] Relevance boosting on read (same as current)
- [ ] Old memory tools removed (`memory_read`, `memory_write`, `memory_delete`, `memory_prune`)
- [ ] System prompt updated with file-system-oriented memory instructions
- [ ] Gateway API routes updated (`/api/me/memory`)
- [ ] Runner gateway routes updated (`/api/memory`)
- [ ] Agent client WebSocket messages updated (`mem-read`, `mem-write`, `mem-rm`, `mem-search`)
- [ ] SessionAgentDO handlers updated
- [ ] Shared types updated (`MemoryFile` replaces `OrchestratorMemory`)
- [ ] `pnpm typecheck` passes
- [ ] Existing memory content preserved through migration
