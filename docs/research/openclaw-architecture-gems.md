# OpenClaw → Valet: Comparative Analysis & Modification Proposals

Research conducted 2026-03-02. Each section contrasts what OpenClaw does with what valet has today, then proposes concrete changes to existing systems.

---

## 1. Skills System → DB-Backed Skill Records

### What OpenClaw Does
Skills are directories on disk with a `SKILL.md` file. Three tiers: bundled (ships with OpenClaw), managed (installed from a registry), workspace (user-created). Each skill's markdown is injected into the system prompt as an `<available_skills>` XML block. Skills are loaded at the start of each agent turn and snapshotted for consistency.

### What We Have Today
Three skills exist as static directories baked into the Docker image:
- `docker/opencode/skills/browser/SKILL.md` — Chromium automation
- `docker/opencode/skills/workflows/SKILL.md` — workflow authoring guide
- `docker/opencode/skills/sandbox-tunnels/SKILL.md` — dev server tunnel wiring

`OpenCodeManager.copyToolsAndSkills()` copies these into `$WORKSPACE/.opencode/skills/` at boot. They're referenced from `opencode.json` instructions. There's no DB model, no CRUD, no per-org or per-repo customization — they're identical for every session.

### What to Change

Model skills the same way we modeled memory: **blobs in the database with a virtual path hierarchy**, not files on disk.

**New D1 table: `skills`**
```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  slug TEXT NOT NULL,              -- e.g. 'pr-review', 'deploy-to-staging'
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,           -- the skill markdown (what was SKILL.md)
  scope TEXT NOT NULL DEFAULT 'org',  -- 'builtin' | 'org' | 'repo' | 'persona'
  repo_id TEXT,                    -- FK to org_repos, nullable
  persona_id TEXT,                 -- FK to agent_personas, nullable
  created_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, slug)
);
```

**Scope cascade** (mirrors how persona files inherit):
- `builtin` — ships with the platform, read-only (replaces the three static skill dirs)
- `org` — org admins create these; all sessions in the org get them
- `repo` — tied to an `org_repo`; sessions working on that repo get them
- `persona` — tied to a persona; sessions using that persona get them

**Injection pipeline changes:**
1. At session creation, `assembleSkillsForSession(orgId, repoId?, personaId?)` queries D1 for all applicable skills (builtin + org + matching repo + matching persona)
2. Skills are passed to the sandbox the same way persona files are — via `SKILLS_JSON` env var (or appended to `PERSONA_FILES_JSON`)
3. `start.sh` writes them to `$WORKSPACE/.opencode/skills/<slug>/SKILL.md`
4. OpenCode picks them up through its existing skill loading mechanism

**Admin UI:** CRUD at `/api/admin/skills` behind `adminMiddleware`. Org members can view but not edit. Admins can create org-scoped and repo-scoped skills. Persona-scoped skills are managed alongside the persona.

**Why this beats OpenClaw's approach:** Skills aren't trapped in one machine's filesystem. They're org-level assets that travel with the org, can be version-controlled in the DB, and cascade through the same scope hierarchy we already use for personas.

---

## 2. Tool Policy → Extend Existing Action Policy System

### What OpenClaw Does
9-layer tool policy pipeline where each layer can only restrict, never expand. Profiles (`minimal`, `coding`, `messaging`, `full`) as presets. Deny wins over allow. Subagents get progressively restricted by depth.

### What We Have Today
We have an **action policy system** (`action_policies` + `action_invocations` tables) that's specifically scoped to **integration tool calls** made through `call_tool`. It resolves policies via a 4-level cascade:

1. Exact action match (service + actionId)
2. Service-level match
3. Risk-level match
4. Hardcoded system defaults (low→allow, medium→approval, high→approval, critical→deny)

Modes: `allow`, `require_approval`, `deny`.

But this system has a critical limitation: **it only governs integration tools** (Gmail, GitHub, Slack, etc. via `call_tool`). It doesn't touch the 40+ OpenCode custom tools in `docker/opencode/tools/`. The `opencode-config` message from the DO includes a `tools` object (`Record<string, boolean>`) that enables/disables specific tool files, but this is a flat on/off toggle with no policy cascade, no profiles, and no depth-based restriction.

### What to Change

**Extend the existing action policy system to cover all tools, not just integrations.** The `action_policies` table already has the right shape — we just need to broaden what it covers.

**Step 1: Unify tool identity.** Today our tools have inconsistent naming:
- OpenCode tools: `mem_read`, `spawn_session`, `channel_reply` (filesystem-based names)
- Integration tools: `gmail:gmail.send_email`, `github:github.create_issue` (namespaced)

Introduce a unified tool ID scheme: `<group>:<tool>`. Define groups that match our existing tool categories:

| Group | Tools (from `docker/opencode/tools/`) |
|-------|-------|
| `memory` | `mem_read`, `mem_write`, `mem_patch`, `mem_rm`, `mem_search` |
| `session` | `spawn_session`, `terminate_session`, `complete_session`, `notify_parent`, `send_message`, `read_messages`, `forward_messages`, `wait_for_event`, `get_session_status`, `list_sessions` |
| `github` | `create_pull_request`, `update_pull_request`, `list_pull_requests`, `inspect_pull_request`, `report_git_state`, `read_repo_file` |
| `workflow` | `sync_workflow`, `run_workflow`, `get_workflow`, `update_workflow`, `delete_workflow`, `list_workflows`, etc. |
| `comms` | `channel_reply`, `mailbox_send`, `mailbox_check` |
| `integration` | `list_tools`, `call_tool` (the dynamic bridge) |
| `utility` | `browser_screenshot`, `send_image`, `sleep`, `parallel_web_search`, etc. |
| `secrets` | `secret_list`, `secret_inject`, `secret_run`, `secret_fill` |
| `tasks` | `task_create`, `task_update`, `task_list`, `my_tasks` |

**Step 2: Tool profiles.** Add a `tool_profile` column to the session or derive it from session type:

| Profile | Groups Included | Use Case |
|---------|----------------|----------|
| `full` | All | Orchestrator sessions |
| `coding` | memory, session (limited), github, workflow, utility, tasks | Normal coding sessions |
| `messaging` | comms, session (read-only), memory (read-only) | Channel-reply-only sessions |
| `minimal` | `get_session_status` only | Deeply nested subagents |

**Step 3: Depth-based restriction.** The `spawn_session` tool already accepts parameters. Add `depth` tracking:
- `sessions` table gets a `spawn_depth INTEGER DEFAULT 0` column
- When a session spawns a child, `child.spawn_depth = parent.spawn_depth + 1`
- The DO's `opencode-config` message computes the `tools` enable/disable map by:
  1. Starting with the session's tool profile
  2. Applying org-level `action_policies` (which already exist)
  3. Applying depth-based restrictions (strip `session:spawn_session` at depth ≥ 2, approach `minimal` at depth ≥ 3)

**Step 4: Wire through existing `opencode-config` push.** The DO already sends tool enable/disable to the Runner via the `opencode-config` WebSocket message, and `OpenCodeManager.applyConfig()` already restarts OpenCode when tools change. The only new work is computing the enable/disable map from the policy cascade instead of a static config.

**What we DON'T need from OpenClaw:** Their per-LLM-provider policy layers (steps 2, 4, 6) are irrelevant — we route all tool calls through our own gateway, not through the model's native tool calling. Their sandbox tools policy (step 8) is also unnecessary since every session is already sandboxed.

---

## 3. Subagent Lifecycle → Enhance Existing spawn_session

### What OpenClaw Does
Non-blocking spawn with `sessions_spawn` tool. Registry tracks all active subagents. Async result delivery via "announce flow" with retry. Depth limiting. Two modes: `run` (one-shot, auto-cleanup) and `session` (persistent). Deferred error handling with 15-second grace period.

### What We Have Today
`spawn_session` tool exists and works. The flow:
1. Agent calls `spawn_session` → Gateway → Runner → DO WebSocket (`spawn-child`)
2. DO calls Modal to create a sandbox, stores child session in D1 with `parentSessionId`
3. Returns `childSessionId` to the agent
4. Child runs independently; parent can `send_message` to it or `terminate_session`

But we're missing several things:
- **No async result delivery.** The parent has to manually poll with `read_messages` or `get_session_status` to check if the child finished. There's no announcement when a child completes.
- **No run vs. session mode.** Every child is persistent until explicitly terminated.
- **No depth tracking.** A child can spawn children can spawn children infinitely.
- **No auto-cleanup.** Dead child sessions linger.
- **`wait_for_event` is the workaround.** The parent calls `wait_for_event` (which aborts the OpenCode turn and returns control to the DO's event system), then a child can `notify_parent`. But this is clunky — the parent has to explicitly set up the wait.

### What to Change

**A. Add `spawn_depth` and `max_spawn_depth` to sessions.**
- New column: `sessions.spawn_depth INTEGER DEFAULT 0`
- Config: org-level `max_spawn_depth` in `org_settings` (default: 3)
- `spawn_session` tool checks `currentDepth < maxDepth` before spawning
- Depth feeds into tool profile resolution (see section 2)

**B. Add `session_mode` to spawn_session.**
- `"run"` (default): one-shot. Session auto-terminates when the agent goes idle after processing its initial prompt. DO sets `autoTerminateOnIdle: true` in session state.
- `"session"`: persistent. Stays alive for follow-up messages (current behavior).

**C. Add child completion announcement.** When a child session completes (goes idle in `run` mode, or is terminated):
1. The child's DO sends a `session-completed` event to the EventBus
2. EventBus routes to the parent's DO (via `parentSessionId`)
3. Parent DO injects a system message: "Child session [title] completed: [summary]" and optionally triggers the prompt queue to process it
4. If the parent is in `wait_for_event`, this event wakes it up (we already have this path via `notify_parent`)

This replaces OpenClaw's announce flow. We don't need their retry/debounce complexity because our EventBus DO already handles reliable delivery.

**D. Auto-cleanup for `run` mode sessions.**
- On completion, `run` mode sessions transition to `archived` after 5 minutes (alarm-driven)
- Their sandbox is terminated immediately on idle
- Messages are preserved in D1 for audit

---

## 4. Queue Modes → We Already Have This

### What OpenClaw Does
Three queue modes: `collect`, `steer`, `followup`.

### What We Have Today
We already implement all three. In `session-agent.ts`:

```typescript
switch (wsQueueMode) {
  case 'steer':   // handleInterruptPrompt → aborts current, enqueues new
  case 'collect': // handleCollectPrompt → buffers, alarm flushes
  default:        // handlePrompt → standard followup queue
}
```

`steer` aborts the current OpenCode turn and sends a new prompt. `collect` accumulates messages with a configurable debounce window and flushes them as a merged prompt. `followup` appends to the `prompt_queue` table.

### What to Change

**Nothing fundamental.** We're ahead of OpenClaw here. Two minor improvements:

1. **Per-channel default queue mode.** Today the queue mode comes from the WebSocket message. We should let it be configured per-channel binding (e.g., Slack DMs default to `steer`, webhook triggers default to `followup`). This is a V2 channel bindings concern.

2. **Expose queue mode in the client UI.** Let users toggle between steer/followup/collect in the chat input area. Currently it's hardcoded per client message.

---

## 5. Context Compaction → Enhance Existing Plugin

### What OpenClaw Does
Detects context overflow → pre-compaction memory flush → dedicated summarization turn → retry. Nuclear option: fresh session if compaction fails. User-directed compaction via `/compact`.

### What We Have Today
We have **two** compaction-related systems:

1. **OpenCode's built-in compaction** — OpenCode handles its own context window management internally.

2. **`memory-compaction.ts` plugin** — hooks OpenCode's `experimental.session.compacting` event to inject guidance about what to preserve during compaction (task status, key decisions, file paths, constraints).

3. **Pre-compaction memory flush** — `checkAndTriggerMemoryFlush()` in the Runner triggers at 70% context utilization (or every 20 turns). It forks the OpenCode session, sends a `MEMORY_FLUSH_PROMPT`, waits for the agent to write memories via `mem_write`, then deletes the fork.

### What to Change

We're actually **ahead** of OpenClaw on the memory flush. Our fork-based approach is cleaner than theirs (we don't pollute the main session's context with the flush turn). Two improvements:

1. **Compaction failure recovery.** If OpenCode's compaction fails and the session is stuck, the Runner should detect this (via repeated `session.error` events mentioning context overflow) and offer to reset the OpenCode session while preserving the DO's message history and memory files. Today a stuck compaction just errors out.

2. **User-directed compaction focus.** Add a `/compact` command in the client UI that sends a system message like "Compact context now, focusing on: [user input]". The Runner interprets this and triggers a compaction cycle with the user's focus directive injected into the compaction plugin's guidance.

---

## 6. Tool-Call Loop Detection → New Runner-Side Monitor

### What OpenClaw Does
Three detectors wrapping every tool call: `genericRepeat` (same tool + same params), `knownPollNoProgress` (polling returning identical results), `pingPong` (A/B/A/B oscillation).

### What We Have Today
**Nothing.** If the agent gets stuck calling the same tool repeatedly, it burns through tokens until the context fills or the user manually aborts. The only implicit guard is the 90-second first-response timeout and the 5-minute watchdog alarm, neither of which detect loops.

### What to Change

Add loop detection in the Runner's SSE event handler (`prompt.ts`), since we see every tool call flow through `handleToolPart`:

**Track recent tool calls per channel session:**
```typescript
interface ToolCallRecord {
  toolName: string;
  argsHash: string;  // SHA-256 of JSON.stringify(args)
  resultHash: string; // SHA-256 of result text
  timestamp: number;
}
```

Keep a sliding window of the last 20 tool calls. On each new tool call completion, run three detectors:

1. **Repeat detector**: If the same `(toolName, argsHash)` appears 3+ times in the window → inject a system message: "You appear to be repeating the same action. Try a different approach."
2. **Poll detector**: If the same `(toolName, resultHash)` appears 3+ times → "This tool is returning the same result each time. The state hasn't changed."
3. **Ping-pong detector**: If the last 6 calls alternate between exactly 2 tool signatures → "You're oscillating between two actions. Step back and reconsider your approach."

The system message injection uses the existing `handleInterruptPrompt` path (steer mode) to course-correct the agent mid-turn.

**Where this lives:** New file `packages/runner/src/loop-detector.ts`. Called from `handleToolPart` in `prompt.ts` on every tool completion.

---

## 7. Layered Execution Pipeline → Refactor Runner's PromptHandler

### What OpenClaw Does
6-layer call stack: queue policy → retry/fallback → model selection → lane serialization → attempt setup → streaming.

### What We Have Today
`PromptHandler.handlePrompt()` is a **single 200+ line method** that does everything:
- Resolves/creates the OpenCode session
- Builds the model failover chain
- Transcribes audio
- Sends the prompt
- Starts the first-response timeout
- (then SSE events drive the rest through `handleEvent`)

Model failover is in `attemptModelFailover()` (separate method, but tightly coupled). The retry-on-404 logic is in `sendPromptToChannelWithRecovery()`. There's no clean separation between concerns.

### What to Change

Not a full rewrite, but **extract the pipeline into composable steps** within the existing `prompt.ts`:

```
handlePrompt()
  → resolveChannel()           // get or create ChannelSession, apply persisted OC session
  → resolveModel()             // build failover chain from preferences
  → prepareContent()           // audio transcription, channel/user prefix injection
  → executeWithFailover()      // try each model in chain
      → sendPromptWithRecovery()  // single attempt with 404/410 session recreation
      → awaitFirstResponse()     // 90s timeout
      → (SSE drives the rest)
  → on error: attemptModelFailover() → loop back to executeWithFailover
```

This is mostly renaming and extracting existing code. The benefit is testability (each step can be unit tested) and hook points (e.g., we can add pre-prompt hooks for tool policy evaluation without touching the main method).

---

## 8. System Prompt Assembly → Extend Persona Pipeline

### What OpenClaw Does
Composable section-based prompt built fresh each turn. Three modes (full/minimal/none). Per-file size caps. Cache-optimized (excludes volatile data from prompt).

### What We Have Today
System prompt assembly happens in two places:

1. **Persona files** — assembled at session creation, written to `.valet/persona/` by `start.sh`, loaded by OpenCode via the `.valet/persona/*.md` glob. These are static for the session's lifetime (unless the DO pushes new config and OpenCode restarts).

2. **`opencode.json` instructions array** — a large inline array of instruction strings covering tool usage rules, skill references, spawning rules, memory guidance, etc. Also static for the session's lifetime.

The orchestrator persona is hardcoded in `orchestrator-persona.ts` as a giant `ORCHESTRATOR_SYSTEM_PROMPT` string. Non-orchestrator personas are user-created via the persona CRUD API.

### What to Change

**A. Prompt modes for child sessions.** When the orchestrator spawns a child via `spawn_session`, the child currently gets the full persona + full instructions. It should get a trimmed version:

- Strip memory-related instructions (child sessions don't manage long-term memory)
- Strip orchestrator-specific instructions (spawning rules, mailbox, task board)
- Strip channel-reply instructions (children don't talk to channels directly)
- Keep: coding instructions, tool usage rules, repo context, safety guardrails

Implementation: add a `promptMode` field to the session creation config. The DO passes it in `opencode-config`. `OpenCodeManager` uses it to select which instruction subsets to include in the generated `opencode.json`.

**B. Size caps on persona files.** Today there's no limit — a user could create a persona file with 500K of text and it would all get injected. Add the same caps OpenClaw uses: 20K per file, 150K total. Enforce in `writeMemoryFile` (for memory snapshot) and in `start.sh` (for persona files). Truncate with a "[truncated]" marker.

**C. Safety guardrails section.** Add a non-removable safety section to every prompt, regardless of persona. Today the orchestrator persona has safety language baked in, but user-created personas don't get it automatically. Add it as a `00-SAFETY.md` persona file that's always injected (hardcoded in the session creation flow, not editable by users).

---

## 9. Safety Guardrails → Formalize the Layered Model

### What OpenClaw Does
Five defense layers: advisory (prompt), programmatic (tool policy), interactive (approval workflows), automatic (rate/depth limits), infrastructure (sandbox containment). Each independently tunable.

### What We Have Today
We have pieces of most layers, but they're not unified:

| Layer | What Exists | Gaps |
|-------|-------------|------|
| Advisory (prompt) | Orchestrator persona has safety language | User-created personas have no mandatory safety section. No standardized guardrail text. |
| Programmatic (tool policy) | `opencode-config` tool enable/disable (flat boolean map) | No cascade, no profiles, no depth-based restriction. Only covers enable/disable, not approval-required. |
| Interactive (approval) | `action_policies` + `action_invocations` for integration tools | Only covers `call_tool`. Doesn't cover `spawn_session`, `channel_reply`, `secret_inject`, or other sensitive tools. Approval is owner-only (no admin/delegated approver). |
| Automatic (limits) | 10-session concurrency limit. 5-minute watchdog. 10-minute approval expiry. | No spawn depth limit. No rate limiting on tool calls. No global concurrency bound on model API calls. |
| Infrastructure (containment) | Every session gets a Modal sandbox. Gateway JWT auth on external ports. | Internal gateway API has zero auth (relies on network isolation). No workspace path guards on tools. |

### What to Change

**A. Mandatory safety section** (see 8C above).

**B. Extend action policies to cover sensitive tools** (see section 2). The `action_policies` table already supports `(service, actionId)` targeting. Adding our own tool groups to it is natural.

**C. Spawn depth limiting** (see section 3A).

**D. Tool call rate limiting.** Add a simple counter in the Runner: if the agent makes more than N tool calls in M seconds (configurable, default 100 calls / 60 seconds), inject a system message asking it to slow down. If it exceeds 2N, abort the turn. This catches runaway agents that aren't technically looping (different args each time) but are burning through tokens.

**E. Admin-delegated approval.** Today only the session owner can approve `require_approval` actions. Add an `approver_roles` field to `action_policies` — default `['owner']`, optionally `['owner', 'admin']`. When set to include admin, any org admin can approve pending actions from the admin dashboard.

---

## 10. Memory System → We're Ahead, Minor Enhancements

### What OpenClaw Does
`MEMORY.md` file in workspace. `MemorySearchManager` with SQLite or LanceDB backends. Memory tools for search/get. Pre-compaction flush.

### What We Have Today
Our memory system is significantly more sophisticated:
- **Virtual filesystem model** (`orchestrator_memory_files`) with path hierarchy, not flat files
- **FTS5 search** with porter stemming on path + content
- **Relevance scoring** with automatic boost on access (capped at 2.0)
- **Auto-pruning** at 200 non-pinned files (lowest relevance + oldest access first)
- **Pinned files** under `preferences/` never pruned
- **Daily journal** auto-created at orchestrator boot
- **6 surgical patch operations** (append, prepend, replace, replace_all, insert_after, delete_section)
- **8K token memory snapshot** injected into persona at boot
- **Pre-compaction memory flush** via forked session at 70% context utilization

### What to Change

Two things OpenClaw has that we should consider:

**A. Vector search alongside FTS.** Our BM25 FTS is good for keyword matching but misses semantic similarity. For a future phase, consider adding a vector embedding column (or a separate table) and using Cloudflare's Vectorize or a similar service for semantic search. Not urgent — FTS covers most cases.

**B. Memory citations.** When the memory snapshot is injected into the prompt, the agent uses memories but doesn't tell the user which memory informed its response. Add a `memoryCitations` mode that, when enabled, instructs the agent to cite memory file paths when referencing recalled information. This builds trust ("I remember from `preferences/coding-style.md` that you prefer...").

---

## 11. Auth Profile Failover → Enhance Existing Model Failover

### What OpenClaw Does
Multiple auth profiles with priority ordering. Cooldown tracking on rate-limited profiles. Automatic failover with state tracking broadcast to clients.

### What We Have Today
Model failover in `PromptHandler.attemptModelFailover()`:
- Builds a failover chain from user prefs → org prefs → hardcoded defaults
- On retriable error (rate limit, auth error, quota), increments `currentModelIndex` and retries
- Sends `model-switched` system message to DO, which broadcasts to clients
- If all models exhausted, reports error with summary of all attempts

### What to Change

**A. Cooldown tracking.** Today if model A rate-limits on session 1, session 2 will still try model A first and hit the same rate limit. Add a shared cooldown map (in the DO or in D1):

```typescript
// In SessionAgent DO state (shared across sessions via a helper)
interface ModelCooldown {
  provider: string;
  modelId: string;
  cooldownUntil: number; // timestamp
  reason: string;
}
```

When a model fails with a rate limit, store the cooldown. When building the failover chain, skip models in cooldown. The DO already has this state available since it resolves model preferences.

**B. Per-key cooldown, not per-model.** Since org admins can configure multiple API keys per provider, track cooldowns per `(provider, keyHash)` not just per model. This requires the Runner to report which key was used when a failure occurs (it currently doesn't).

---

## 12. Exec Approvals → Extend Action Policy to Shell Commands

### What OpenClaw Does
`deny` / `allowlist` / `full` security modes for shell execution. Safe-bin lists. Script validation. Per-host routing.

### What We Have Today
The agent runs shell commands via OpenCode's built-in `exec` tool inside the sandbox. **There are no restrictions on what commands the agent can run.** The sandbox provides the only containment — if the agent can do it in a Debian container, it can do it.

The `action_policies` system doesn't cover shell execution at all.

### What to Change

This is the biggest gap for the independence axis. Two approaches, in order of effort:

**A. (Low effort) Sensitive command detection.** Add a Runner-side hook that monitors tool calls for OpenCode's `exec`/`bash` tool. Pattern-match against a list of sensitive commands:
- `rm -rf /` or similar destructive patterns
- `curl | sh` or `wget | bash` (arbitrary code execution from internet)
- `git push --force` to protected branches
- Any command touching `.opencode/`, `.valet/`, or the config directories

When detected, inject a system message asking the agent to confirm the action. This is advisory (the agent could ignore it), but combined with the tool policy system, it provides a layer of defense.

**B. (Medium effort) Approval-gated exec.** Extend the `action_policies` system to support a new service type `exec`. Admin creates policies like:
- `{ service: 'exec', actionId: 'destructive', mode: 'require_approval' }`
- `{ service: 'exec', actionId: 'network', mode: 'deny' }`

The Runner intercepts exec tool calls before they reach OpenCode, classifies them against patterns, and routes through the existing approval flow if policy says `require_approval`. This requires the Runner to become a tool-call interceptor, not just a passthrough — a bigger architectural change.

---

## Summary: What to Build, In Order

### Phase 1: Foundation (extend existing systems)

| Change | Existing System Modified | Effort |
|--------|------------------------|--------|
| Spawn depth tracking + limit | `sessions` table, `spawn_session` tool, DO spawn handler | Small |
| Mandatory safety persona file | Session creation flow, `start.sh` | Small |
| Tool-call loop detection | New `loop-detector.ts` in Runner, wire into `prompt.ts` | Medium |
| Run vs. session mode for children | `spawn_session` tool params, DO session state, idle handler | Medium |
| Child completion announcement | EventBus routing, parent DO system message injection | Medium |

### Phase 2: Policy (the independence axis)

| Change | Existing System Modified | Effort |
|--------|------------------------|--------|
| Unified tool identity scheme | Tool file naming, `opencode-config` protocol | Small |
| Tool profiles (full/coding/messaging/minimal) | DO `opencode-config` computation, new profile resolver | Medium |
| Depth-based tool restriction | Profile resolver, spawn depth integration | Small (if profiles exist) |
| Extend `action_policies` to cover our tools | `action_policies` table (reuse), DO tool call handler | Medium |
| Admin-delegated approval | `action_policies` schema, approval route auth check | Small |
| Tool call rate limiting | Runner-side counter, system message injection | Small |

### Phase 3: Skills & Prompt (new capabilities)

| Change | Existing System Modified | Effort |
|--------|------------------------|--------|
| Skills D1 table + CRUD API | New migration, new route, `adminMiddleware` | Medium |
| Skill scope cascade (builtin/org/repo/persona) | Session creation flow, `assembleSkillsForSession` | Medium |
| Skill injection into sandbox | `start.sh` or `OpenCodeManager`, env var pipeline | Small |
| Prompt modes for child sessions | `opencode-config` protocol, `OpenCodeManager` instruction selection | Medium |
| Persona file size caps | `start.sh`, memory snapshot builder | Small |

### Phase 4: Polish

| Change | Existing System Modified | Effort |
|--------|------------------------|--------|
| Model cooldown tracking | DO state, failover chain builder | Medium |
| Compaction failure recovery | Runner error handler, session reset flow | Medium |
| Sensitive command detection | Runner tool-call monitoring | Medium |
| Memory citations mode | Memory snapshot builder, persona instructions | Small |
| User-directed compaction | Client UI, Runner compaction trigger | Small |
