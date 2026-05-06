# Portable Runtime Engine

> Defines the portable agent runtime engine that replaces OpenCode, the Runner, and the SessionAgentDO's orchestration logic with a single, platform-agnostic TypeScript library deployable on Cloudflare Workers or Kubernetes.

## Scope

This spec covers:

- Engine library architecture and abstraction boundaries
- The V1 feature superset required beyond Flue-style agent harness behavior
- Session, thread, and message hierarchy
- Agent loop, tool system, compaction, and event emission
- Per-thread prompt queue with modes
- Decision-gated execution (approvals, credential requests, questions)
- Provider interfaces (SessionStore, SandboxProvider, EventBus, BlobStore, CredentialStore)
- Schema ownership and migration strategy
- Platform adapter contracts (Cloudflare and Kubernetes)
- Channel transport contracts, with Slack as the required reference transport for V1
- Shared API route layer
- Tool implementation and integration framework (ToolContext, ToolResult, credentials, OAuth)
- LLM provider layer (pi-ai and pi-agent-core adoption)
- Package structure

### Boundary Rules

- This spec does NOT cover individual tool implementations (GitHub, Slack, Linear, etc.) — those are ported separately against the ToolDef interface.
- This spec does NOT cover frontend component implementation details, but it DOES define the API and event contracts the frontend consumes.
- This spec does NOT cover sandbox image building (Dockerfiles, Modal image definitions, warm pools) — the sandbox image gets simpler but that's a separate concern.
- This spec does NOT cover auth, users, orgs, or billing — those stay in the API layer.
- This spec does NOT cover workflow execution details — a workflow step is "create a session, prompt it, read the result" and uses the engine's session API.
- This spec does NOT cover orchestrator persona or long-term memory product behavior — those are application-level concerns built on top of the engine.

## Relationship to Flue

This design is informed by Flue's runtime architecture and may reuse implementation ideas heavily, but V1 is specified as a Valet-owned engine built in-repo rather than a direct dependency on `@flue/sdk`.

Flue is the baseline reference for:

- a portable session runtime over `pi-ai` and `pi-agent-core`
- sandbox abstraction
- built-in file/shell/task tools
- DAG-style history with compaction
- Cloudflare-hosted session persistence and SSE streaming

Valet V1 intentionally goes beyond that baseline in a few core areas:

- multi-threaded sessions with concurrent per-thread queues
- channel-aware routing between web, Slack, Telegram, and child-session threads
- decision-gated execution via approvals, questions, and credential acquisition
- richer tool context (identity, credentials, sandbox, thread/session metadata, channel metadata)
- adapter-facing event contracts suitable for multiplayer clients and external channel transports

Where Flue and this spec differ, this spec is authoritative for Valet V1.

## Why: Contrast with Current Architecture

### What Exists Today

```
Client
  ↓ WebSocket
Cloudflare Worker (Hono, 50+ routes)
  ↓ DO binding
SessionAgentDO (~3000 lines)
  ├── Prompt queue (SQLite, alarm-based flush)
  ├── Channel session routing (web/slack/telegram multiplexing)
  ├── Decision gates (approvals, questions, expiry alarms)
  ├── Model selection & credential resolution
  ├── Message persistence (SQLite hot → D1 cold, debounced)
  ├── Connected user tracking
  ├── Health monitoring
  ├── Hibernation/restore orchestration
  ├── Analytics event buffering
  ├── Child session coordination
  ├── Tunnel URL management
  ↓ WebSocket (custom protocol, ~680 lines of type defs)
Runner (~6000 lines across 4 files, runs inside Modal sandbox)
  ├── WebSocket client to DO (reconnection, buffering, request/response tracking)
  ├── ChannelSession state machine (per-channel OpenCode session isolation)
  ├── OpenCode lifecycle management (spawn, health poll, crash recovery, restart)
  ├── SSE event stream consumption & parsing
  ├── Model failover chain (15+ retriable error patterns)
  ├── Audio transcription
  ├── Memory pre-compaction flush
  ├── Auth gateway (JWT, proxying to 5 services, tunnel system)
  ↓ HTTP + SSE
OpenCode (external dependency, runs inside Modal sandbox)
  ├── LLM provider connections
  ├── 73 registered tools
  ├── Session state & context management
  ├── Plugin system (personas, skills, tools)
  └── Config hot-reload via filesystem watch
```

Total moving parts: 4 processes (Worker, DO, Runner, OpenCode), 3 transport protocols (HTTP, WebSocket, SSE), 2 custom message protocols (DO-to-Runner, Runner-to-OpenCode), ~10,000 lines of orchestration code.

### What's Wrong With It

**The DO is a god object.** SessionAgentDO does prompt queuing, channel routing, message persistence, credential resolution, health monitoring, alarm scheduling, WebSocket multiplexing, analytics buffering, and hibernation orchestration. These responsibilities accumulated because the DO is the only stateful coordination point, so everything that needs state ends up there. The result is 3000 lines of deeply coupled code where a change to prompt queuing can break alarm scheduling.

**Three hops to execute a tool call.** When the LLM decides to read a file: LLM (in OpenCode) invokes tool handler, which hits the filesystem directly. Fine. But the prompt that led to that tool call traveled: Client, Worker, DO, WebSocket, Runner, HTTP, OpenCode. And the result travels back the same path. Six network hops round-trip for every user message. Each hop is a failure point, a latency penalty, and a protocol translation.

**The Runner exists to bridge two things that shouldn't be separate.** The Runner's entire purpose is to translate between the DO's WebSocket protocol and OpenCode's HTTP/SSE protocol. It manages OpenCode's process lifecycle, consumes its event stream, tracks per-channel state, handles model failover, and reports back to the DO. It's 6000 lines of glue code. If the agent runtime talked directly to the sandbox, the Runner wouldn't need to exist.

**Two sources of truth for session state.** The DO holds prompt queue state, channel mappings, and decision gates in SQLite. The Runner holds per-channel OpenCode session IDs, streaming state, tool call tracking, and model failover state in memory. D1 holds the canonical message history. When the Runner disconnects and reconnects, there's a complex resync protocol to reconcile these three state locations. This is fragile: the 60-second grace period, the session recreation logic, the "resync if busy, abort if stuck" flow all exist because state is scattered.

**OpenCode is an opaque dependency.** We can't fix bugs in its agent loop or change how it handles tool calls, compaction, or context management. When it crashes, the Runner has to detect the crash, track crash counts, apply exponential backoff, and eventually declare a fatal state. We work around its limitations rather than fixing them: the memory pre-compaction flush at 70% context exists because we can't modify OpenCode's compaction behavior directly.

**Platform lock-in is structural, not incidental.** The architecture doesn't just run on Cloudflare; it's shaped by Cloudflare. The DO's single-writer guarantee shapes the prompt queue design. Hibernatable WebSockets shape the connection model. DO alarms shape the timer system. SQLite in the DO shapes the hot storage pattern. To port to Kubernetes, you wouldn't just swap implementations; you'd have to redesign every subsystem that was shaped by a DO capability.

**The prompt queue is session-wide, blocking cross-channel work.** A Slack conversation blocks web UI prompts. An orchestrator can't research in one thread while coding in another. This isn't a fundamental limitation; it's an artifact of the DO processing one prompt at a time because that's simpler in the single-writer model.

### What Replaces It

```
Client
  ↓ WebSocket / SSE
Platform Adapter (thin: ~200-400 lines)
  ├── CF: Worker routes + SessionHostDO (just hosts engine)
  └── K8s: Hono service + SessionPool (just hosts engine)
  ↓ function call
Engine (portable, ~2000-3000 lines)
  ├── Agent loop (pi-agent-core: prompt → LLM → tools → response)
  ├── Thread management (per-thread queues, cross-visibility)
  ├── Tool execution (built-in + custom ToolDef[])
  ├── Session state (DAG history, compaction)
  ├── Model resolution & failover (pi-ai)
  ├── Event emission
  ↓ SandboxProvider interface
Sandbox (Modal / K8s Pod / Docker / Virtual)
  └── filesystem + shell (no agent logic)
```

Total moving parts: 2 processes (adapter + sandbox), 1 transport protocol (HTTP to sandbox API), 0 custom message protocols, ~3000 lines of orchestration code.

### Why It's Better

**The engine is a library, not a distributed system.** Session state, prompt queuing, thread management, tool execution, and event emission all live in one process with one call stack. No WebSocket protocols, no message serialization, no reconnection logic, no state reconciliation. A prompt goes in, events come out.

**One hop to execute a tool call.** Engine calls `sandbox.exec()` or `sandbox.readFile()`. The sandbox is just a filesystem and shell behind an interface.

**Single source of truth for session state.** The engine holds all session state in memory during execution and persists through SessionStore. No split between DO SQLite, Runner memory, and D1. No resync protocol. No grace periods. If the engine process restarts, it rehydrates from SessionStore: one load, complete state.

**Per-thread concurrency is natural.** Each thread has its own queue and executes independently. The engine manages concurrent threads within a session because it's just concurrent async operations in one process, not distributed coordination.

**We own the agent loop.** Compaction behavior, tool call handling, context management, model failover: all modifiable. No working around an opaque dependency.

**Platform is a configuration choice, not an architectural commitment.** The engine doesn't know about DOs, Workers, pods, or containers. It knows about SessionStore, SandboxProvider, EventBus, BlobStore, and CredentialStore. Porting to a new platform means implementing provider interfaces, not redesigning the session model.

**The sandbox becomes simpler.** The sandbox runs only dev tools (code-server, VNC, TTYD) and a lightweight auth gateway. The agent brain is elsewhere. Sandbox boot time decreases. Sandbox crashes don't kill the agent; they just make tool calls fail temporarily until the sandbox recovers.

**Testing becomes trivial.** The engine is a TypeScript library with injected interfaces. Test it with InMemorySessionStore, VirtualSandbox (just-bash), and InMemoryEventBus. No containers, no DOs, no network. Full integration tests run in milliseconds.

## Architecture

### Three Layers

**1. Engine (`packages/engine/`)** — Portable TypeScript library, zero platform dependencies. Owns the agent loop, session/thread state, tool execution, prompt queuing, compaction, model failover, event emission, roles, and skills.

**2. Provider interfaces** — Contracts defined by the engine, implemented per-platform. Five interfaces: SessionStore, SandboxProvider, EventBus, BlobStore, CredentialStore.

**3. Platform adapters (`packages/adapter-cloudflare/`, `packages/adapter-k8s/`)** — Thin packages (~200-400 lines each) that implement the provider interfaces for a specific deployment target and host the engine process.

```
┌─────────────────────────────────────────────────────┐
│              packages/engine/                        │
│                                                      │
│  ┌───────────┐ ┌──────────┐ ┌───────────────┐      │
│  │ AgentLoop │ │ Session  │ │ ToolRegistry  │      │
│  │(pi-agent- │ │ Manager  │ │               │      │
│  │ core)     │ │          │ │               │      │
│  └─────┬─────┘ └────┬─────┘ └───────┬───────┘      │
│        │             │               │               │
│  ┌─────▼─────────────▼───────────────▼───────────┐  │
│  │            Provider Interfaces                 │  │
│  │  SessionStore | SandboxProvider | EventBus     │  │
│  │  BlobStore    | CredentialStore                │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
         │                    │
┌────────▼────────┐  ┌───────▼─────────┐
│ adapter-cf/     │  │ adapter-k8s/    │
│ D1, DO, R2,     │  │ PG, Redis, S3,  │
│ Modal           │  │ Modal/K8s Pods  │
└─────────────────┘  └─────────────────┘
```

### Package Structure

```
packages/
  engine/                  ← portable core (agent loop, tools, interfaces, schema)
    src/
      schema/              ← Drizzle schema definitions (source of truth)
      tools/               ← built-in tool implementations
      session.ts           ← session management
      thread.ts            ← thread lifecycle, cross-visibility
      queue.ts             ← per-thread prompt queue
      agent-loop.ts        ← pi-agent-core wrapper
      compaction.ts        ← context compression
      events.ts            ← typed event system
      roles.ts             ← role loading and resolution
      skills.ts            ← skill discovery and invocation
      result.ts            ← structured result extraction
      types.ts             ← all public types and interfaces
    migrations/
      sqlite/              ← generated by drizzle-kit for D1
      postgresql/          ← generated by drizzle-kit for PG
  api/                     ← shared Hono route handlers, parameterized by store impls
  adapter-cloudflare/      ← CF-specific wiring (DO host, D1/R2/DO providers)
  adapter-k8s/             ← K8s-specific wiring (session pool, PG/Redis/S3 providers)
```

## V1 Completeness Contract

V1 is complete when the engine can replace OpenCode, the Runner, and the SessionAgentDO orchestration path for normal interactive sessions on the Cloudflare adapter, while preserving the product-facing API/event behavior required by the web client and Slack reference transport.

The V1 implementation must define and implement these contracts:

| Contract | Owner | Required for V1 |
|---|---|---|
| Engine public API | `packages/engine` | Session creation/restoration, thread lookup, prompt submission, abort/pause/resume, decision resolution, event subscription |
| Session/thread/message model | `packages/engine` | DAG entries, thread metadata, queue state, compaction entries, decision gate entries, suspended turn checkpoints |
| Agent loop contract | `packages/engine` | pi-agent-core integration, model resolution, tool execution, failover, abort propagation, structured results |
| Tool contract | `packages/engine` + plugin packages | Built-in tools, plugin `ToolDef`s, command tools, action-policy wrapping, attachment handling |
| Decision gate contract | `packages/engine` + adapters | Approval, question, and credential-request gates, delivery refs, resolution, expiry, withdrawal, restart-safe resume |
| Provider contracts | adapters | SessionStore, SandboxProvider, EventBus, BlobStore, CredentialStore |
| Sandbox RPC contract | sandbox runtime + adapters | File operations, process execution, snapshots, tunnels, health, auth, request limits |
| Channel transport contract | SDK + adapters | Outbound messages, decision gate delivery/update, inbound action parsing, free-text gate resolution |
| API route contract | `packages/api` + adapters | Shared session/thread/prompt/history/decision/control routes |
| Client event contract | adapters | WebSocket/SSE event names and payloads for web UI consumption |
| Schema/migration contract | `packages/engine` | Drizzle schema, SQLite and PostgreSQL migrations, coexistence with current app tables during rollout |
| Observability contract | `packages/engine` + adapters | Audit events, analytics events, logs, status events, recoverable vs fatal errors |

### V1 Exclusions

The following are explicitly post-V1 unless needed to preserve an existing production workflow:

- User-facing branch/replay controls beyond preserving DAG metadata.
- Kubernetes production deployment. The contract must exist, but Cloudflare is the V1 shipping adapter.
- Rewriting every plugin package by hand. V1 may use an `ActionSource` to `ToolDef` bridge.
- Replacing workflow execution internals. Workflows may continue to call the session API.
- Removing old tables immediately. V1 may run side-by-side with current tables while the migration completes.

## Engine Public API

The engine is a library. Platform adapters host it and expose HTTP/WebSocket entrypoints, but all session execution flows through this API.

```typescript
interface Engine {
  createSession(opts: CreateSessionOptions): Promise<SessionHandle>;
  restoreSession(opts: RestoreSessionOptions): Promise<SessionHandle>;
  getSession(sessionId: string): Promise<SessionHandle | null>;
  deleteSession(sessionId: string): Promise<void>;
  onEvent(listener: (event: BusEvent) => void): Unsubscribe;
}

interface RestoreSessionOptions {
  sessionId: string;
  // Same shape as CreateSessionOptions minus `id` — the caller re-supplies
  // tools, sandbox, model, system prompt, etc. The engine does not maintain
  // a registry of session-creation options across restarts; the host (DO,
  // pod, CLI) is responsible for reconstructing them from its own config.
  options: Omit<CreateSessionOptions, 'id'>;
}

interface CreateSessionOptions {
  id?: string;
  userId: string;
  orgId: string;
  workspace: string;
  purpose?: 'interactive' | 'orchestrator' | 'workflow' | 'child';
  parentSessionId?: string;
  parentThreadId?: string;
  sandbox: Sandbox | SandboxCreateOpts;
  tools?: ToolDef[];
  commandTools?: CommandToolDef[];
  roles?: RoleSpec[];
  skills?: SkillSource[];
  model: string;
  modelFailover?: string[];
  queueMode?: QueueMode;
  metadata?: Record<string, unknown>;
}

interface SessionHandle {
  id: string;
  thread(key?: string): ThreadHandle;
  prompt(content: PromptContent, opts?: PromptOptions): Promise<PromptReceipt>;
  resolveDecision(gateId: string, resolution: DecisionResolution): Promise<void>;
  withdrawDecision(gateId: string, reason: DecisionWithdrawReason): Promise<void>;
  abort(opts?: { threadId?: string }): Promise<void>;
  pause(opts?: { threadId?: string }): Promise<void>;
  resume(opts?: { threadId?: string }): Promise<void>;
  snapshot(): Promise<string>;
  destroy(): Promise<void>;
}

interface ThreadHandle {
  id: string;
  prompt(content: PromptContent, opts?: PromptOptions): Promise<PromptReceipt>;
  skill(name: string, opts?: SkillInvokeOptions): Promise<PromptReceipt>;
  shell(command: string, opts?: ExecOpts): Promise<ExecResult>;
  readThread(key: string, opts?: MessageQuery): Promise<SessionEntry[]>;
  abort(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

type QueueMode = 'followup' | 'steer' | 'collect';

type PromptContent =
  | string
  | {
      text?: string;
      attachments?: PromptAttachment[];
    };

interface PromptOptions {
  author?: PromptAuthor;
  channel?: ChannelTarget;
  replyTarget?: ChannelTarget;
  queueMode?: QueueMode;
  model?: string;
  role?: string;
  resultSchema?: TSchema;
  metadata?: Record<string, unknown>;
}

interface PromptAuthor {
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  externalId?: string;
}

type PromptAttachment =
  | { type: 'image'; url?: string; data?: Uint8Array; mimeType: string; name?: string }
  | { type: 'file'; url?: string; data?: Uint8Array; mimeType: string; name: string }
  | { type: 'audio'; url?: string; data?: Uint8Array; mimeType: string; name?: string };

interface PromptReceipt {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  status: 'queued' | 'running' | 'blocked_on_decision_gate';
}

interface MessageQuery {
  limit?: number;
  cursor?: string;
  afterEntryId?: string;
  beforeEntryId?: string;
  includeCompacted?: boolean;
  includeSystemEntries?: boolean;
}

interface ListOpts {
  limit?: number;
  cursor?: string;
  status?: string;
  createdAfter?: Date;
  createdBefore?: Date;
}
```

The API is idempotent where identifiers are supplied by the caller. `createSession({ id })` must return the existing session if it has already been created with the same ID and compatible immutable fields. `resolveDecision()` must be safe to retry: resolving an already resolved gate with the same resolution is a no-op; resolving it with a different resolution returns a conflict error.

`TSchema` refers to the TypeBox schema type used by pi-ai for structured parameters and results. API-layer adapters must serialize schemas as JSON Schema and preserve the original TypeScript type only inside package boundaries.

## Data Model: Sessions, Threads, and Messages

### Hierarchy

```
Session (sandbox, tools, roles, config)
  ├── Thread 'web:default'     ─── Messages (DAG)
  ├── Thread 'slack:C123'      ─── Messages (DAG)
  ├── Thread 'task:research'   ─── Messages (DAG)
  │
  │     Threads can read from siblings (cross-thread visibility).
  │     Threads execute concurrently (independent queues).
  │
  └── Child Session (own or shared sandbox)
        ├── Thread 'default'   ─── Messages (DAG)
        │     Can read from parent threads.
        └── Parent can read child thread summaries.
```

### Session

A session owns a sandbox instance, registered tools, roles, and configuration. It is the container for all agent work.

- Created via the engine's API: `engine.createSession(opts)`
- Has a unique ID, a sandbox, a set of tools, optional roles and skills
- Can spawn child sessions (single-threaded or multi-threaded)
- Owns shared decision state used by its threads: pending decision gates, credentials, and child-session registry
- Session-wide controls: `abort()` aborts all threads, `pause()`/`resume()` freeze/unfreeze all thread queues

### Thread

A named conversation within a session. Each thread has its own message history (DAG-based), its own prompt queue, its own compaction state, and its own active model. Threads share the sandbox, tools, and roles from the parent session.

- Created or retrieved via `session.thread(key)`
- `session.prompt()` is sugar for `session.thread('default').prompt()`
- Each channel target naturally maps to a thread key: `web:default`, `slack:C123`, `telegram:456`, `thread:<orchestratorThreadId>`
- Threads can also be created explicitly for focused work: `task:research`, `review:pr-42`

**Channel-aware thread identity:** A thread is the engine's concurrency and history boundary. Channel metadata is attached to prompts and messages, but channel transports do not define execution boundaries on their own. Multiple external channel targets may point at the same logical thread when the application intentionally converges them (for example, a Slack thread and the web UI both steering the same orchestrator thread).

**Cross-thread visibility:** Threads can read messages from sibling threads via a built-in `thread_read` tool. The LLM can pull in context from another thread when it needs it, without paying the token cost of having it in context permanently. Cross-visibility also works across the session boundary: child session threads can read from parent threads, and parent threads can read child thread summaries.

**Thread controls:**
- `thread.prompt(text, opts)` — submit a prompt
- `thread.abort()` — abort current prompt, clear this thread's queue
- `thread.pause()` / `thread.resume()` — freeze/unfreeze this thread's queue
- `thread.skill(name, opts)` — invoke a named skill
- `thread.shell(command)` — execute a shell command (recorded in history)
- `thread.readThread(key)` — read messages from a sibling thread

### Messages

Messages within a thread form a DAG (directed acyclic graph). Each message entry has a `parentId` pointing to its predecessor, enabling branching and replay.

**Entry types:**
- `MessageEntry` — LLM or engine-authored messages (user, assistant, toolResult, system) with content, attachments, and source metadata
- `DecisionGateEntry` — a persisted decision point in the conversation DAG, including its status and any eventual resolution
- `CompactionEntry` — summarized context checkpoint inserted by the compaction system
- `BranchSummaryEntry` — summary of a branched conversation

```typescript
interface BaseEntry {
  id: string;
  sessionId: string;
  threadId: string;
  parentId: string | null;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

interface MessageEntry extends BaseEntry {
  type: 'message';
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  parts?: MessagePart[];
  author?: PromptAuthor;
  channel?: ChannelTarget;
  model?: string;
}

type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; callId: string; toolName: string; status: 'running' | 'completed' | 'error'; args?: unknown; result?: unknown; error?: string }
  | { type: 'attachment'; attachment: ToolAttachment }
  | { type: 'error'; message: string; code?: string };

interface CompactionEntry extends BaseEntry {
  type: 'compaction';
  summary: string;
  coveredEntryIds: string[];
  tokenCountBefore: number;
  tokenCountAfter: number;
  fileContext?: {
    read: string[];
    modified: string[];
  };
}

interface BranchSummaryEntry extends BaseEntry {
  type: 'branch_summary';
  branchRootId: string;
  branchLeafId: string;
  summary: string;
}
```

The active conversation path is reconstructed by following `parentId` pointers from the leaf back to the root. Compaction inserts a summary without rewriting history.

**LLM-faithful entry persistence (rehydration contract):** the engine must persist enough information in `MessageEntry.parts` to reconstruct LLM-compatible content blocks on restore. Specifically:

- An assistant entry that issued tool calls MUST persist one `MessagePart` of type `tool_call` per call, with `callId`, `toolName`, and `args`. Without this, a restored transcript would show the assistant's text but lose the tool calls, producing a malformed `[user, assistant(text), toolResult]` sequence that LLM providers reject.
- A tool-result entry (role `tool`) MUST persist `callId` so the LLM provider can match it to the assistant's tool call.
- Thinking content, if recorded at all, persists with provider-specific signatures intact when available, so cross-provider handoff and replay produce valid context.

`MessageEntry.content` is the human-readable text rendering; `MessageEntry.parts` is the structured source of truth used during rehydration.

**Suspension history rules:** Decision-gated turns are represented in the DAG by a first-class `DecisionGateEntry`, not by synthetic system messages. The entry is created when the gate is opened and then updated in place as it moves through `pending`, `resolved`, `expired`, or `withdrawn` states. This keeps the history model explicit and replayable: gates are decision artifacts, not conversation utterances.

**V1 branching stance:** The storage model remains DAG-based so future replay and alternate branches are possible without schema redesign, but V1 does not require exposing full user-facing branch/replay controls in the API. V1 must preserve enough metadata for later branching support without forcing branching UX to ship in the first implementation batch.

## Engine Internals

### Agent Loop

The engine uses `@mariozechner/pi-agent-core` for the inner agent loop and `@mariozechner/pi-ai` for the LLM provider layer. The engine wraps these with session/thread management, tool context injection, and event routing.

**Per-thread agent instance:** Each thread gets its own `Agent` instance (from pi-agent-core). The agent manages the LLM streaming, parallel tool execution, and turn lifecycle. The engine subscribes to the agent's events and translates them to `EngineEvent` emissions.

**Loop flow:**

```
prompt received on thread
  → compose context (system prompt + thread history + role instructions)
  → build tool list (built-in + custom, with ToolContext injection)
  → create/update Agent instance with context and tools
  → agent runs: call LLM (streaming via pi-ai)
  → for each tool call in response:
      → execute tool via ToolDef.execute(args, ctx)
      → if tool requests a decision gate:
          → persist DecisionGate + SuspendedTurnState
          → append DecisionGateEntry(status='pending') to the DAG
          → emit decision_gate event
          → stop only this thread's active turn
      → when a decision gate is resolved:
          → update the existing DecisionGateEntry with resolution metadata and status='resolved'
          → reconstruct the suspended turn from persisted state
          → re-run the suspended tool/turn from the checkpoint
      → when a decision gate expires or is withdrawn:
          → update the existing DecisionGateEntry with status='expired' or status='withdrawn'
          → fail or cancel the suspended turn
      → if tool returns attachments, handle per type:
          → image attachments → route to LLM as vision content
          → text attachments → include inline in tool result
          → file attachments → store via BlobStore, reference in history
      → append tool result to thread history
  → if LLM wants to continue (more tool calls): loop
  → if LLM emits end_turn: done
  → check compaction threshold, compact if needed
  → persist thread state via SessionStore
  → emit events throughout
```

### LLM Provider Layer

The engine adopts `@mariozechner/pi-ai` for model abstraction. pi-ai provides a unified streaming interface across 20+ providers (Anthropic, OpenAI, Google, Mistral, Bedrock, etc.), typed streaming events, tool type definitions, vision support detection, context serialization, and cross-provider handoffs.

The engine adopts `@mariozechner/pi-agent-core` for the inner agent loop. pi-agent-core provides the `Agent` class that handles the LLM streaming, parallel tool execution, abort handling, and event emission cycle.

**What pi-ai gives us:**
- Model discovery and provider configuration (`getModel('anthropic', 'claude-sonnet-4-6')`)
- Streaming with typed events (`text_delta`, `toolcall_start/delta/end`, `thinking_start/delta/end`)
- Token and cost tracking per call
- Context serialization for persistence
- Cross-provider context handoffs (enables model failover with automatic thinking-to-text conversion)
- Faux provider for deterministic testing (`registerFauxProvider()`)

**What pi-agent-core gives us:**
- The `Agent` class: prompt → LLM → tool calls → execute → feed results → loop until end_turn
- Parallel tool execution (`toolExecution: 'parallel'`)
- Typed event subscription (`agent_start`, `message_update`, `tool_execution_start/end`, `turn_end`)
- Abort signal propagation
- State management (messages, model, tools)

**What the engine adds on top:**
- Sessions and threads (pi-agent-core has no concept of persistence or multi-conversation)
- Per-thread prompt queue with modes
- Cross-thread visibility
- Decision gates and resumable user-interaction points
- Compaction (using pi-ai's token counts to decide when, pi-ai's streaming to generate summaries)
- Tool context injection (credentials, sandbox, user identity)
- Event routing from pi-agent-core events to EngineEvent emissions
- Model failover (catch retriable errors, hand off context to next model via pi-ai)
- Structured result extraction with schema validation

**Model resolution:** Uses `provider/model` string convention (same as pi-ai and OpenRouter). Provider instances are registered at startup by the platform adapter. Model failover is configured per-session as an ordered list; on retriable errors, the engine advances to the next model and hands off the context using pi-ai's cross-provider serialization.

#### Model Registry Contract

Adapters register model providers before restoring or creating sessions.

```typescript
interface ModelRegistry {
  registerProvider(provider: ModelProviderConfig): void;
  get(model: string): Promise<ModelHandle>;
  list(opts?: { userId?: string; orgId?: string }): Promise<ModelDescriptor[]>;
}

interface ModelProviderConfig {
  id: string;
  displayName: string;
  apiKey?: string;
  baseUrl?: string;
  models?: ModelDescriptor[];
}

interface ModelDescriptor {
  id: string;              // provider/model
  providerId: string;
  modelId: string;
  displayName?: string;
  contextWindow?: number;
  outputLimit?: number;
  input: Array<'text' | 'image' | 'audio'>;
  output: Array<'text' | 'tool_call'>;
}

interface ModelHandle {
  descriptor: ModelDescriptor;
  provider: unknown;       // pi-ai provider instance, hidden behind engine package boundaries
}
```

Model selection order is prompt override, role override, thread model, session model, then platform default. Failover never crosses into a model the user or org is not authorized to use.

### Tool System

Three categories of tools, merged at prompt time:

**Built-in tools** (provided by the engine, always available):
- `read` — read file contents via SandboxProvider
- `write` — create/overwrite files via SandboxProvider
- `edit` — exact text replacement via SandboxProvider
- `bash` — shell execution via SandboxProvider
- `grep` — pattern search via SandboxProvider
- `glob` — file pattern matching via SandboxProvider
- `thread_read` — read messages from a sibling, parent, or child thread
- `task` — spawn a child session for delegated work (depth-limited)

**Plugin tools** (`ToolDef[]`, registered at session creation):
- Custom tools from plugin packages (GitHub, Slack, Linear, memory, browser, etc.)
- Each is a `{ name, description, parameters, execute }` object
- Registered per-session or per-thread (thread-level overrides session-level on name conflict)

**Command tools** (privileged CLI wrappers):
- Shell commands with injected environment variables
- Secrets are injected at the host level, never visible to the LLM
- Scoped per-prompt or per-session

```typescript
interface CommandToolDef {
  name: string;
  description: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval?: boolean;
  timeoutMs?: number;
}
```

Command tools execute through `Sandbox.exec`. The engine injects configured environment variables into the process environment and never serializes secret values into message history, tool arguments visible to the model, or events.

#### ToolDef Interface

```typescript
interface ToolDef {
  name: string;
  description: string;
  parameters: TSchema;  // TypeBox schema (pi-ai native)
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval?: boolean | ((args: Record<string, unknown>, ctx: ToolContext) => Promise<boolean> | boolean);
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}
```

Tool names are globally unique within a session after registration. Built-in tools use short names (`read`, `bash`); plugin tools use service-qualified names (`github.create_pr`, `linear.create_issue`). If two tools register the same name at the same scope, session creation fails unless a thread-level override intentionally replaces a session-level tool.

#### ToolContext

Every tool execution receives a context object from the engine:

```typescript
interface ToolContext {
  // Identity
  userId: string;
  orgId: string;
  sessionId: string;
  threadId: string;
  sessionPurpose?: string;
  actor?: {
    id: string;
    name?: string;
    email?: string;
  };

  // Prompt/message routing
  channelType?: string;
  channelId?: string;
  decisionGateId?: string;
  replyChannelType?: string;
  replyChannelId?: string;

  // Repo / workspace context
  cwd?: string;
  repo?: {
    url?: string;
    branch?: string;
    ref?: string;
    provider?: string;
  };

  // Credentials
  credentials: CredentialProvider;

  // Sandbox (for tools that need file/shell access)
  sandbox: Sandbox;

  // Structured runtime interactions
  requestDecision: (req: DecisionGateRequest) => Promise<DecisionResolution>;
  emitArtifact?: (artifact: ToolArtifact) => Promise<void>;
  /**
   * Set by the engine ONLY on a replayed tool execution after restart.
   * When `gateId` matches the deterministic ID derived from this call's
   * `req.resumeKey`, the engine returns the stored `resolution` immediately
   * instead of opening a new gate. Tools never set this themselves.
   */
  suspendedDecision?: SuspendedDecisionContext;

  // Abort
  signal: AbortSignal;
}

interface CredentialProvider {
  get(service: string): Promise<Credential | null>;
  request(service: string, reason: string): Promise<Credential>;
}

interface Credential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

type ToolArtifact =
  | { type: 'file'; path?: string; blobKey?: string; title?: string }
  | { type: 'link'; url: string; title: string }
  | { type: 'diff'; path?: string; content: string };

interface SuspendedDecisionContext {
  gateId: string;
  resolution?: DecisionResolution;
}
```

When a tool calls `credentials.request()` for a credential that doesn't exist, the engine pauses tool execution and emits a `decision_gate` event to the user. Execution resumes when the credential is provided. If the user does not respond within a configurable timeout (default 10 minutes), the request fails and the tool receives a structured credential error. Same pattern as tool approvals.

Approval-gated tools follow the same suspension model. A tool can return or throw a structured `approval_required` signal, which the engine converts into a `DecisionGate`, persists, emits, and resumes on resolution.

**Restart-safe tool suspension contract:** The engine does not rely on preserving an in-memory JavaScript continuation across restarts. Tools that call `requestDecision(...)` must therefore be re-entrant up to their decision points. On first execution, `requestDecision(...)` persists the gate and suspends the turn. On resumed execution, the engine re-runs the tool from the start with `suspendedDecision` populated for the matching gate ID, and the same `requestDecision(...)` call returns the stored resolution instead of creating a new gate.

**What "re-entrant up to the decision point" means in practice:** any work the tool does *before* `requestDecision(...)` will run twice — once on the original execution (lost when the engine restarts), once on replay. Side effects in that prefix must be idempotent or read-only. Work *after* `requestDecision(...)` returns runs once on replay only. Tools that need to do non-idempotent work before a gate should split into two tools (one to do the work and persist a result, another to gate-and-act on it) or move the work to after the gate.

**How the engine populates `ctx.suspendedDecision`:** on `restoreSession`, for every thread whose persisted queue status is `blocked_on_decision_gate`, the engine loads the corresponding `DecisionGate` and `SuspendedTurnState`. If the gate is still `pending`, the engine re-arms its in-memory wait so a future `resolveDecision(...)` call delivers the resolution. If the gate is already `resolved` (the user resolved it while the engine was down) or becomes resolved later, the engine invokes the persisted tool by name with the persisted args, sets `ctx.suspendedDecision = { gateId, resolution }` for that one execution, and feeds the returned `ToolResult` back into the agent loop as if the original turn had completed — then calls the agent's continuation to produce the next assistant turn.

**Replay event guarantees:** the replayed tool execution does not need to emit the same per-call `tool_start` / `tool_end` event pair as the original turn (the original pair was already emitted before the engine went down). The engine MUST emit the post-replay `text_delta` / `message_end` / `turn_end` events for the continuation turn so that connected clients see the agent finish the work. Adapters re-deliver pending gates on client (re)connection through the `init` event payload.

#### Plugin Action Bridge

V1 keeps using existing plugin action packages through an adapter, but the bridge does NOT register one LLM-visible tool per action. With dozens of plugins each exporting dozens of actions, direct registration would (a) blow past LLM tool-catalog size budgets, (b) collide with provider tool-name regexes (Anthropic requires `^[a-zA-Z0-9_-]{1,128}$`, so dotted ids like `github.create_issue` are rejected), and (c) force every session to pay the prompt cost of every action even when only a few are relevant.

Instead, plugin actions are surfaced through two engine-built-in indirection tools — `list_tools` and `call_tool` — that expose a searchable catalog the agent consults on demand.

```typescript
interface ActionSource {
  listActions(ctx?: { credentials?: Record<string, string> }): ActionDefinition[] | Promise<ActionDefinition[]>;
  execute(actionId: string, params: unknown, ctx: ActionContext): Promise<ActionResult>;
}

interface ActionDefinition {
  id: string;            // fully-qualified, e.g. "github.create_issue"
  name: string;
  description: string;
  riskLevel: RiskLevel;
  params?: unknown;        // Zod schema from current SDK packages
  inputSchema?: Record<string, unknown>;
}

interface ActionContext {
  credentials: Record<string, string>;
  userId: string;
  orgId?: string;
  callerIdentity?: { name: string; avatar?: string };
  analytics?: unknown;
  attribution?: { name: string; email: string };
  guardConfig?: Record<string, unknown>;
}

interface ActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  images?: Array<{ data: string; mimeType: string; description: string }>;
}

interface ActionSourceConfig {
  service: string;            // routing key + default credential service
  actions: ActionSource;
  credentialService?: string; // override service for credential lookup
  defaultApprovalMode?: 'allow' | 'require_approval' | 'deny';
}

interface ActionBridgeOptions {
  sources: ActionSourceConfig[];
}

/**
 * Returns exactly two ToolDefs: `list_tools` and `call_tool`. Internally the
 * bridge holds a catalog assembled from every ActionSource passed in.
 */
function actionBridgeTools(opts: ActionBridgeOptions): Promise<ToolDef[]>;
```

`list_tools` accepts:

- `service?: string` — filter by service name.
- `query?: string` — match against action name, id, and description (case-insensitive substring).
- `limit?: number` — cap results (default 50, max 200).

It returns a structured payload: `{ service, id, name, description, riskLevel, params }` per action, plus per-service auth/availability warnings when credentials are missing or expired.

`call_tool` accepts:

- `tool_id: string` — the fully-qualified action id (e.g. `github.create_issue`).
- `params: object` — the action arguments, validated against the action's parameter schema before dispatch.
- `summary: string` — one-line human-readable description used in approval gates and audit logs.

Bridge behavior:

- Action ids stay unchanged inside the catalog and as `tool_id` arguments. Provider tool-name regexes never apply because action ids ride as string args, not tool names.
- Zod parameters are converted to TypeBox/JSON Schema at registration time and exposed verbatim through `list_tools`.
- `call_tool` validates `params` against the action's schema. Validation errors return a structured tool error, not an exception.
- `riskLevel` is reported in `list_tools` and consulted in `call_tool` to decide whether to open a `DecisionGate` (`high`/`critical` default to `require_approval` unless the per-source `defaultApprovalMode` overrides). The action's `summary` arg is the gate body.
- Credentials are resolved through `CredentialProvider` per call, scoped to the action's `credentialService`. Missing credentials surface as a structured "auth required" tool error and as a warning in subsequent `list_tools` responses.
- Action analytics events are forwarded to the engine observability sink.
- Action images are converted to `ToolAttachment` objects and handled by the engine attachment pipeline.

The bridge is a migration layer, not a permanent engine dependency. New plugins may either (a) keep emitting `ActionSource`s and let the bridge expose them, or (b) export `ToolDef[]` directly when they want to be registered as first-class engine tools (e.g. coding-loop primitives where the per-call indirection is unwanted overhead). Engine adapters compose both paths in the same session.

#### ToolResult

```typescript
type ToolResult = {
  text: string;
  attachments?: ToolAttachment[];
};

type ToolAttachment =
  | { type: 'image'; data: Uint8Array; mimeType: string; name?: string }
  | { type: 'file'; data: Uint8Array; mimeType: string; name: string }
  | { type: 'text'; content: string; name?: string; language?: string };
```

**Attachment handling by the engine:**
- `image` attachments are routed to the LLM as vision content (if the model supports it via `model.input.includes('image')`).
- `file` attachments are stored via BlobStore and referenced in the message history. Available to the LLM if requested but not injected into context automatically.
- `text` attachments are included inline in the tool result message. The `language` field enables syntax-aware formatting.

### Compaction

Token-aware context compression with two complementary techniques. When a thread approaches the model's context window, the engine **prunes** stale tool outputs cheaply (no LLM) and, if more space is needed, **compacts** older messages into a structured summary (one LLM call). The DAG is preserved verbatim — pruning marks tool-output strings as elided, compaction inserts a `CompactionEntry`. Both transformations apply only when assembling the LLM-visible context; the engine's history record never loses anything.

This design is informed by OpenCode's compaction module (which itself iterates on prior tools like Aider's repo-summarization). Where this spec and that implementation differ, this spec is authoritative for Valet V1.

#### Triggers

- **Proactive (auto)** — after each turn, if `tokens.total >= usable(model, cfg)` where
  ```
  usable = contextWindow − reserved
  reserved = cfg.reserveTokens ?? min(20_000, model.maxOutputTokens)
  ```
  the engine queues a compaction pass to run before the next user turn would otherwise execute. Token usage comes from pi-ai's per-call `Usage`; we do not estimate independently in this path.
- **Reactive (overflow)** — if a turn's assistant message returns `stopReason === 'error'` and pi-ai's `isContextOverflow(message)` matches the error, the engine compacts and retries the same turn. Reactive compaction strips media attachments from history before summarizing (some overflow is media-bytes, not token-count, so dropping images can be enough on its own).

#### Tail preservation

Compaction never touches the most recent turns. A "turn" is the segment from one user message up to (but not including) the next user message, including the assistant's tool calls and tool results.

- Default keep: the last `cfg.tailTurns ?? 2` turns.
- Tail token budget: `clamp(usable * 0.25, cfg.minPreserveRecentTokens ?? 2_000, cfg.maxPreserveRecentTokens ?? 8_000)`.
- If the last `tailTurns` turns exceed the budget, the engine walks them oldest → newest and drops whole turns from the head of that window until the rest fits. If a single turn alone exceeds the budget, the engine splits it at the first message boundary that fits, summarizing the prefix into the compaction and keeping the suffix in the tail.

#### Pruning (cheap path, no LLM)

Walk messages newest → oldest. Track cumulative tool-output token estimate. Once the cumulative count exceeds `cfg.pruneProtectTokens ?? 40_000`, mark every older `tool_call`-result text as `elided`. Skip protected tools (the engine ships with `skill` and `thread_read` protected by default; per-tool opt-in via `ToolDef.protectedFromPruning`).

The DAG entry is updated in place via `SessionStore.updateEntry` — `MessagePart` of type `tool_call` keeps `callId`, `toolName`, `args`, and `status`, but its `result` field is replaced with a placeholder `{ elided: true, reason: 'pruned' }` and `elided: true` is set on the part. LLM-context assembly skips elided results. The persistence is atomic per entry, not per part: the entire `MessageEntry` row is rewritten with the same id. Pruning only commits if it'd save at least `cfg.pruneMinimumTokens ?? 20_000` tokens; otherwise it's a no-op.

Pruning runs before compaction on the proactive path. Often pruning alone is enough.

#### Compaction (LLM path)

When pruning isn't enough (or after `cfg.pruneMinimumTokens` worth of tool output has already been elided), the engine summarizes the messages before the tail.

1. Compute the cut point per the tail-preservation rules above.
2. Assemble the head: the messages before the cut, with tool outputs truncated to `cfg.toolOutputMaxChars ?? 2_000` chars and image content stripped.
3. If the thread already has a `CompactionEntry`, load its `summary` as `previousSummary`. The new summarization is iterative — the prompt asks the summarizer to *update* the prior summary with new facts rather than write a fresh one.
4. Call a summarizer model (`cfg.summarizerModel ?? sessionModel`; typically a smaller cheaper model like Haiku) with a structured-markdown prompt:
   ```
   ## Goal · ## Constraints & Preferences
   ## Progress (Done / In Progress / Blocked) · ## Key Decisions
   ## Next Steps · ## Critical Context · ## Relevant Files
   ```
   This template is required, not advisory. The summary text is the source of truth for the LLM's view of pre-cut history; using a structured form prevents the summary from drifting into prose that crowds out specific facts (paths, error strings, identifiers).
5. Persist a `CompactionEntry` in the DAG with:
   - `summary`: the markdown produced by step 4.
   - `coveredEntryIds`: every entry id from the DAG head that this summary represents.
   - `tokenCountBefore` / `tokenCountAfter`: token counts of the head before and the summary after, for observability.
   - `fileContext`: extracted paths from `read`/`write`/`edit` tool calls in the head, classified `read` vs `modified` (helps the agent re-orient on resume).
6. Emit `compaction_start` then `compaction_end` events with the entry id.

The `CompactionEntry` is positioned at the cut point in the DAG; `parentId` links it to the last covered entry. Subsequent `MessageEntry`s parent to the `CompactionEntry`. Branching/replay still works: walking from leaf via `parentId` produces a valid history, with the summary standing in for everything older.

#### Applying compaction to LLM context

The engine's `convertToLlm` pipeline (the function fed to pi-agent-core's `Agent` to translate persisted DAG entries into LLM messages) does the rewrite at request time:

1. Load DAG entries for the thread.
2. Find the most recent `CompactionEntry`. If none, pass entries through unchanged.
3. Drop every entry whose id is in the active compaction's `coveredEntryIds`.
4. Replace them with a single user message containing the summary text, framed as `<previous-context>{summary}</previous-context>`.
5. Apply pruning's elision: any kept entry's tool-call parts whose `result.elided === true` get a placeholder `[output elided to save context]` in the LLM-visible content.
6. Yield the resulting `Message[]` to the agent loop.

This is also the rehydration path on `restoreSession` — there is no separate "rebuild context after compaction" code path.

#### Auto-continue after compaction

After a successful proactive compaction (i.e., one we ran on our own initiative, not in response to the user's prompt), if the thread is mid-task the engine injects a synthetic user message before yielding back to the next queue item:

> "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."

The synthetic message is tagged with `metadata: { compaction_continue: true }` so client UIs can render it differently or hide it. Reactive (overflow) compactions don't auto-continue — they just retry the original turn that triggered the overflow.

#### Configuration

| Key | Default | Notes |
|---|---|---|
| `cfg.compactionEnabled` | `true` | per-thread switch |
| `cfg.reserveTokens` | `min(20_000, maxOutput)` | head-room subtracted from contextWindow |
| `cfg.tailTurns` | `2` | last N turns never touched |
| `cfg.minPreserveRecentTokens` | `2_000` | floor on tail token budget |
| `cfg.maxPreserveRecentTokens` | `8_000` | ceiling on tail token budget |
| `cfg.pruneProtectTokens` | `40_000` | recent tool-output bytes never pruned |
| `cfg.pruneMinimumTokens` | `20_000` | only commit prune if it saves ≥ this much |
| `cfg.toolOutputMaxChars` | `2_000` | when feeding head to summarizer |
| `cfg.summarizerModel` | `sessionModel` | dedicated summarizer is cheaper |
| `cfg.protectedTools` | `['skill', 'thread_read']` | per-tool opt-out from pruning; `ToolDef.protectedFromPruning` adds to this set |

### Per-Thread Prompt Queue

Each thread owns its own prompt queue. Threads execute independently and concurrently within a session.

**Concurrency model:**
- Each thread processes one prompt at a time (serialized within a thread)
- Multiple threads can be active simultaneously (parallel across threads)
- Sandbox access is shared: concurrent file ops and shell commands from different threads hit the same filesystem
- Tool execution is thread-safe by contract: tool authors handle their own concurrency if needed

**Queue modes** (per-thread, switchable at runtime):

- **Followup** (default) — prompts queue in FIFO order. When the current prompt completes, the next one starts. If the thread is idle, the prompt executes immediately.
- **Steer** — new prompt aborts the in-flight prompt and starts immediately. Previous prompt's partial work remains in the thread history.
- **Collect** — prompts buffer for a configurable window (default 5 seconds). When the window closes, all buffered prompts are concatenated into a single prompt and dispatched. If the thread is busy, the collected prompt enters the FIFO queue as normal.

**Prompt metadata:** Each prompt carries `threadId`, `channelType`, `channelId`, `authorId`, optional attachments, and optional model override.

**Routing semantics:** Queueing is keyed by thread, not by transport. `channelType` / `channelId` are routing metadata used for attribution, reply delivery, and decision gate resolution. They do not create extra isolation beyond the owning thread.

**Steer semantics:** `steer` aborts only the current turn on the targeted thread. It must not affect other active threads in the session. Partial work already emitted by the aborted turn remains in history.

**Collect semantics:** `collect` buffers by thread. Adapters may additionally preserve origin-channel metadata for each buffered prompt so the merged prompt can still attribute its constituent messages correctly.

**Pending decision semantics:** When a thread is blocked on a pending decision gate, it is considered busy but interruptible. Behavior by mode:

- `followup` — new prompts queue behind the blocked turn.
- `collect` — new prompts continue buffering and later queue behind the blocked turn.
- `steer` — new prompt cancels the blocked turn and expires or withdraws the outstanding decision gate before starting immediately.

The engine must never allow an old gate resolution to resume a turn that was already superseded by `steer`.

**Persisted runtime state:** A thread with a pending decision gate remains the active processing item in queue state, but with a distinct suspended status. V1 queue persistence must distinguish at least:

- `queued`
- `running`
- `blocked_on_decision_gate`
- `paused`

When a thread enters `blocked_on_decision_gate`, the engine persists a `SuspendedTurnState` checkpoint containing enough information to safely resume after restart:

- session ID / thread ID / active queue item ID
- current model
- active leaf message ID
- pending gate ID (derived from `gate:${sessionId}:${threadId}:${queueItemId}:${resumeKey}`)
- pending tool call ID, tool name, and original tool args (used to invoke the tool by name during replay)
- the `resumeKey` the tool supplied (used to recompute the gate ID on replay and confirm a match)

On restore, the engine reloads the blocked thread, reloads the decision gate, and waits for either resolution, expiry, or cancellation. Once resolved, the engine reconstructs the turn from the checkpoint and re-drives execution.

**Persistence:** Queue state is persisted via SessionStore so it survives process restarts. On engine startup, pending queue entries are restored and dispatched.

**Controls:**
- `thread.abort()` — abort current prompt on this thread, clear this thread's queue
- `thread.pause()` / `thread.resume()` — freeze/unfreeze this thread's queue
- `session.abort()` — abort all threads
- `session.pause()` / `session.resume()` — freeze/unfreeze all thread queues
- Session-wide idle = all threads idle

### Decision Gates

Decision gates are first-class engine primitives for "pause here and wait for an external human decision". Engine, adapter, SDK, API, client, and channel contracts use `DecisionGate` naming and payloads consistently.

V1 uses one unified mechanism for:

- tool approvals
- agent questions
- credential acquisition / re-authorization

This replaces ad hoc transport- or adapter-specific waiting behavior. A gate is persisted, emits events, may be delivered to external channels by the adapter, and resumes or fails the waiting operation when resolved, expired, or withdrawn.

**Gate model:**

```typescript
interface DecisionGate {
  id: string;
  sessionId: string;
  threadId: string;
  type: 'approval' | 'question' | 'credential_request';
  title: string;
  body?: string;
  actions: DecisionAction[];
  expiresAt?: number;
  status: 'pending' | 'resolved' | 'expired' | 'withdrawn';
  context?: Record<string, unknown>;
  origin?: {
    channelType?: string;
    channelId?: string;
    messageId?: string;
  };
  refs?: Array<{
    channelType: string;
    ref: DecisionGateRef;
  }>;
}

interface DecisionAction {
  id: string;
  label: string;
  style?: 'primary' | 'danger';
}

interface DecisionResolution {
  actionId?: string;
  value?: string;
  resolvedBy: string;
  resolvedAt: number;
  source?: {
    channelType?: string;
    channelId?: string;
    messageId?: string;
  };
}

type DecisionWithdrawReason = 'steer' | 'abort' | 'cancel';

interface DecisionGateRef {
  messageId: string;
  channelId: string;
  threadId?: string;
  [key: string]: unknown;
}

interface DecisionGateEntry {
  type: 'decision_gate';
  id: string;
  parentId: string | null;
  timestamp: string;
  gate: DecisionGate;
  resolvedAt?: string;
  resolution?: DecisionResolution;
  withdrawnReason?: DecisionWithdrawReason;
}
```

**Gate types:**

- `approval`: asks whether a tool or command may proceed. Required actions are `approve` and `deny` unless a custom action list is supplied.
- `question`: asks the user for an answer. May include option actions or accept free text when `actions` is empty.
- `credential_request`: asks the user to connect or re-authorize a service. Required context fields are `service`, `reason`, and optional `scopes`.

**Gate delivery contract:**

1. Engine creates and persists the gate with `status = 'pending'`.
2. Engine appends or updates the corresponding `DecisionGateEntry` in the thread DAG.
3. Engine publishes `decision_gate`.
4. Adapter delivers the gate to web clients and any matching channel targets.
5. Each channel delivery returns a `DecisionGateRef`; the adapter persists refs back through `SessionStore.saveDecisionGateRef`.
6. The first valid resolution wins.
7. Adapter calls `session.resolveDecision(gateId, resolution)`.
8. Engine updates gate status, updates the DAG entry, clears suspended state, and resumes or fails the blocked turn.
9. Adapter updates delivered channel messages via stored refs.

The engine must treat missing channel delivery as non-fatal. A gate that cannot be delivered externally remains visible through the web/client event stream and API.

**Execution semantics:**

- A tool or agent loop may create a gate and suspend the waiting operation.
- Suspension is scoped to the waiting thread/turn, not the whole session.
- Other threads in the same session may continue running while one thread is blocked on a gate.
- Resolution resumes the suspended operation with typed input.
- Expiry fails the suspended operation with a structured error.
- Withdrawal cancels the suspended operation without permitting later resolution to resume it.

The `DecisionGateEntry.id` should be the canonical DAG entry ID for the gate, while `DecisionGate.id` is the stable runtime identity used by transports, queue state, and suspended-turn checkpoints. In V1 these may be the same value for simplicity.

**Deterministic gate identity:** A gate created from a tool execution must use a stable ID for that suspension point within the active turn. This is what allows the engine to re-run the tool after restart and have `requestDecision(...)` match the existing persisted gate instead of creating a duplicate.

The V1 derivation is:

```
gateId = `gate:${sessionId}:${threadId}:${queueItemId}:${resumeKey}`
```

`resumeKey` is **required** on `DecisionGateRequest` (not optional). Tool authors choose a key that uniquely identifies the suspension point given the tool's inputs — typically a function of the tool's args (e.g. `"github.create_pr:owner/repo:head→base"`). Two `requestDecision(...)` calls in the same active queue item with the same `resumeKey` open the same gate. Two calls with different `resumeKey`s open different gates. A replayed tool execution that reaches the same `requestDecision(...)` call site with the same args produces the same `resumeKey` and therefore the same `gateId`, which is how the short-circuit works.

```typescript
interface DecisionGateRequest {
  type: 'approval' | 'question' | 'credential_request';
  title: string;
  body?: string;
  actions?: DecisionAction[];
  expiresAt?: number;
  context?: Record<string, unknown>;
  origin?: { channelType?: string; channelId?: string; messageId?: string };
  resumeKey: string; // REQUIRED for restart-safe gates
}
```

**Resolution paths:**

- explicit action selection (`approve`, `deny`, option buttons)
- free-text reply from the web UI
- free-text reply from an external channel thread when the adapter matches the stored origin target

The engine owns the gate lifecycle and persistence; adapters own delivery details for Slack, Telegram, web, etc.

**Conflict handling:**

- Resolving a non-pending gate returns `decision_gate_conflict` unless the supplied resolution exactly matches the stored resolution.
- Expiry and withdrawal are terminal states.
- A `steer` prompt on the same thread withdraws pending gates created by the superseded turn with reason `steer`.
- `thread.abort()` withdraws pending gates on that thread with reason `abort`.
- `session.abort()` withdraws all pending gates in the session with reason `abort`.
- Resolutions received after withdrawal or expiry must be acknowledged to the transport but must not resume execution.

### Roles and Skills

**Roles** — Markdown files with optional YAML frontmatter (`name`, `description`, `model`). Applied as system prompt overlays. Precedence: prompt-level > thread-level > session-level. If a role declares a `model`, it overrides the session's default model for that prompt.

**Skills** — Markdown files discovered from the sandbox filesystem or a configured directory. Invoked explicitly via `thread.skill(name, { args })`. The skill's instructions become a focused prompt with the given arguments. Skill files use frontmatter (`name`, `description`) and support `{{variable}}` template syntax for argument injection.

Both are loaded at runtime, not baked into the engine build.

```typescript
interface RoleSpec {
  name: string;
  description?: string;
  model?: string;
  content: string;
  source?: 'session' | 'thread' | 'prompt' | 'plugin' | 'sandbox';
}

interface SkillSource {
  name: string;
  description?: string;
  content: string;
  argsSchema?: TSchema;
  source?: 'plugin' | 'sandbox' | 'repo' | 'user';
}

interface SkillInvokeOptions {
  args?: Record<string, unknown>;
  model?: string;
  author?: PromptAuthor;
  channel?: ChannelTarget;
  resultSchema?: TSchema;
}
```

Role and skill loading errors are non-fatal at session creation only when the source is optional. Prompt-level role or skill resolution errors fail the prompt before model invocation.

### Event System

The engine emits typed events through a callback. Platform adapters subscribe and relay events to clients via their transport (WebSocket, SSE, etc.).

```typescript
type EngineEvent =
  | { type: 'message_start'; threadId: string; messageId: string; role: 'assistant' | 'system' }
  | { type: 'text_delta'; threadId: string; text: string }
  | { type: 'message_update'; threadId: string; messageId: string; parts: MessagePart[]; content?: string }
  | { type: 'message_end'; threadId: string; messageId: string; reason: 'end_turn' | 'error' | 'abort' }
  | { type: 'tool_start'; threadId: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool_end'; threadId: string; tool: string; result: string; isError: boolean }
  | { type: 'turn_end'; threadId: string; reason: 'end_turn' | 'error' | 'abort' }
  | { type: 'thread_start'; threadId: string; parentThreadId?: string }
  | { type: 'queue_state'; threadId: string; state: QueueState }
  | { type: 'compaction_start' | 'compaction_end'; threadId: string }
  | { type: 'task_start' | 'task_end'; childSessionId: string; threadId: string }
  | { type: 'status'; threadId: string; status: 'idle' | 'queued' | 'thinking' | 'tool_calling' | 'streaming' | 'blocked_on_decision_gate' }
  | { type: 'error'; threadId?: string; code: string; error: string; recoverable: boolean }
  | { type: 'decision_gate'; threadId: string; gate: DecisionGate }
  | { type: 'decision_gate_resolved'; threadId: string; gateId: string; resolution: DecisionResolution }
  | { type: 'decision_gate_expired'; threadId: string; gateId: string }
  | { type: 'decision_gate_withdrawn'; threadId: string; gateId: string; reason: 'steer' | 'abort' | 'cancel' }
  | { type: 'model_switched'; threadId: string; fromModel: string; toModel: string; reason: string }
```

The engine does not know about WebSockets, SSE, or any transport. It emits events; the adapter decides delivery.

### Client Event Contract

Clients consume decision-gate events directly. Adapters may deliver these events over WebSocket or SSE, but payloads are identical.

```typescript
type ClientEvent =
  | { type: 'init'; session: SessionData; threads: ThreadData[]; queue: QueueState[]; pendingDecisionGates: DecisionGate[] }
  | { type: 'message'; sessionId: string; threadId: string; entry: MessageEntry }
  | { type: 'message.updated'; sessionId: string; threadId: string; entryId: string; patch: Partial<MessageEntry> }
  | { type: 'chunk'; sessionId: string; threadId: string; messageId: string; content: string }
  | { type: 'agentStatus'; sessionId: string; threadId: string; status: EngineEventStatus; detail?: string }
  | { type: 'queue.state'; sessionId: string; threadId: string; queue: QueueState }
  | { type: 'decision_gate'; sessionId: string; threadId: string; gate: DecisionGate }
  | { type: 'decision_gate_resolved'; sessionId: string; threadId: string; gateId: string; resolution: DecisionResolution }
  | { type: 'decision_gate_expired'; sessionId: string; threadId: string; gateId: string }
  | { type: 'decision_gate_withdrawn'; sessionId: string; threadId: string; gateId: string; reason: DecisionWithdrawReason }
  | { type: 'error'; sessionId?: string; threadId?: string; code: string; message: string; recoverable: boolean };

type EngineEventStatus =
  | 'idle'
  | 'queued'
  | 'thinking'
  | 'tool_calling'
  | 'streaming'
  | 'blocked_on_decision_gate'
  | 'error';
```

Clients resolve a gate by calling the decision API route, not by sending transport-specific answer messages:

```http
POST /api/sessions/:sessionId/decision-gates/:gateId/resolve
POST /api/sessions/:sessionId/decision-gates/:gateId/withdraw
```

Adapters must include all pending decision gates in the initial connection payload so reconnecting clients can render outstanding approvals, questions, and credential requests without waiting for a replayed event.

### Structured Results

Optional schema-validated output extraction. Any prompt or skill invocation can pass a result schema (Valibot or TypeBox). The engine instructs the LLM to emit a result in a delimited block, extracts it, and validates against the schema.

- Delimiters: `---RESULT_START---` and `---RESULT_END---`
- If validation fails and no delimiters found: auto-retry with a follow-up prompt
- Returns typed data matching the schema

## Provider Interfaces

These are the contracts that platform adapters implement. The engine depends only on these interfaces.

### SandboxProvider

Creates and manages sandbox compute. The engine calls this to get a Sandbox handle, then uses it for all file and process operations.

```typescript
interface SandboxProvider {
  create(opts: SandboxCreateOpts): Promise<Sandbox>;
  restore(id: string): Promise<Sandbox>;
  destroy(id: string): Promise<void>;
  status(id: string): Promise<SandboxStatus>;
}

interface SandboxCreateOpts {
  image?: string;
  workspace?: string;
  env?: Record<string, string>;
  timeout?: number;
  resources?: { cpu?: number; memory?: string };
  metadata?: Record<string, unknown>;
}

interface Sandbox {
  id: string;

  // Filesystem
  readFile(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }>;
  mkdir(path: string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;

  // Process execution
  exec(command: string, opts?: ExecOpts): Promise<ExecResult>;

  // Lifecycle
  snapshot(): Promise<string>;
  tunnels(): Promise<Record<string, string>>;
  destroy(): Promise<void>;
}

interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  maxOutputBytes?: number;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  truncated?: boolean;
}

interface SandboxStatus {
  id: string;
  state: 'creating' | 'running' | 'stopped' | 'error';
  startedAt?: number;
  error?: string;
}
```

**Implementations:**
- `ModalSandbox` — wraps Modal's Python SDK (called via HTTP to the Modal backend)
- `K8sPodSandbox` — creates a K8s pod, exec via K8s API
- `DockerSandbox` — local Docker container (dev/testing)
- `LocalSandbox` — host filesystem + child_process (CI, local dev)
- `VirtualSandbox` — in-memory filesystem + just-bash (lightweight agents, no container)

#### Sandbox RPC Contract

Remote sandbox implementations expose an authenticated HTTP RPC surface to the adapter. The engine still calls the `Sandbox` TypeScript interface; this RPC is the required adapter-to-sandbox protocol for Modal and Kubernetes implementations.

All requests include `Authorization: Bearer <sandbox-rpc-token>`. Tokens are scoped to one session and one sandbox ID. Paths are relative to the sandbox workspace unless explicitly absolute and allowed by adapter policy.

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/health` | none | `{ ok: true, sandboxId, version }` |
| `GET` | `/files/stat?path=` | none | `{ isFile, isDirectory, size, mtimeMs }` |
| `GET` | `/files/read?path=&encoding=utf8` | none | `{ content, encoding }` |
| `GET` | `/files/read-binary?path=` | none | binary stream |
| `PUT` | `/files/write` | `{ path, content, encoding?: 'utf8' }` | `{ ok: true }` |
| `PUT` | `/files/write-binary?path=` | binary body | `{ ok: true }` |
| `GET` | `/files/list?path=` | none | `{ entries: Array<{ name, type, size }> }` |
| `POST` | `/files/mkdir` | `{ path, recursive?: boolean }` | `{ ok: true }` |
| `DELETE` | `/files` | `{ path, recursive?: boolean }` | `{ ok: true }` |
| `POST` | `/exec` | `{ command, cwd?, env?, stdin?, timeout?, maxOutputBytes? }` | `ExecResult` |
| `POST` | `/snapshot` | none | `{ snapshotId }` |
| `GET` | `/tunnels` | none | `{ tunnels: Record<string, string> }` |

RPC implementations must enforce output limits, command timeouts, workspace path policy, and token validation. `exec` is non-interactive in V1; long-running interactive terminal sessions remain a sandbox UI concern exposed through tunnels, not an engine tool protocol.

### SessionStore

Persists session state, thread state, message history, and queue state. Used by both the engine (writes) and the API layer (reads). One implementation per database backend, shared by engine and API.

```typescript
interface SessionStore {
  // === Engine writes ===
  saveSession(session: SessionData): Promise<void>;
  saveThread(sessionId: string, thread: ThreadData): Promise<void>;
  appendEntries(sessionId: string, threadId: string, entries: SessionEntry[]): Promise<void>;
  /**
   * Replace an existing entry in place. Required so pruning during
   * compaction can persist tool-result elision; also useful for any
   * other in-place mutation (gate refs, attachment updates).
   * Throws NotFoundError if no entry with this id exists in (sessionId, threadId).
   */
  updateEntry(sessionId: string, threadId: string, entry: SessionEntry): Promise<void>;
  saveQueueState(sessionId: string, threadId: string, queue: QueueState): Promise<void>;
  saveDecisionGate(sessionId: string, threadId: string, gate: DecisionGate): Promise<void>;
  saveDecisionGateRef(sessionId: string, threadId: string, gateId: string, ref: { channelType: string; ref: DecisionGateRef }): Promise<void>;
  updateDecisionGateEntry(sessionId: string, threadId: string, gateId: string, patch: Partial<DecisionGateEntry>): Promise<void>;
  saveSuspendedTurn(sessionId: string, threadId: string, suspended: SuspendedTurnState): Promise<void>;
  clearSuspendedTurn(sessionId: string, threadId: string): Promise<void>;
  updateSessionStatus(id: string, status: string, metadata?: Partial<SessionData>): Promise<void>;
  flush?(): Promise<void>;

  // === API reads ===
  getSession(id: string): Promise<SessionData | null>;
  listSessions(userId: string, opts?: ListOpts): Promise<SessionData[]>;
  getThread(sessionId: string, threadId: string): Promise<ThreadData | null>;
  listThreads(sessionId: string): Promise<ThreadData[]>;
  getEntries(sessionId: string, threadId: string, opts?: MessageQuery): Promise<SessionEntry[]>;
  listDecisionGates(sessionId: string, threadId?: string): Promise<DecisionGate[]>;
  getSuspendedTurn(sessionId: string, threadId: string): Promise<SuspendedTurnState | null>;

  // === Shared ===
  deleteSession(id: string): Promise<void>;
}
```

```typescript
interface SuspendedTurnState {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  gateId: string;
  model: string;
  leafMessageId?: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  resumeKey: string;
  attempt: number;
  createdAt: number;
}
```

```typescript
interface SessionData {
  id: string;
  userId: string;
  orgId: string;
  workspace: string;
  purpose: 'interactive' | 'orchestrator' | 'workflow' | 'child';
  status: 'initializing' | 'running' | 'paused' | 'hibernated' | 'terminated' | 'error';
  sandboxId?: string;
  snapshotId?: string;
  parentSessionId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

interface ThreadData {
  id: string;
  sessionId: string;
  key: string;
  status: 'active' | 'paused' | 'archived';
  activeLeafEntryId?: string;
  queueMode: QueueMode;
  model?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

interface QueueState {
  threadId: string;
  mode: QueueMode;
  status: 'idle' | 'queued' | 'running' | 'blocked_on_decision_gate' | 'paused';
  activeItemId?: string;
  pending: QueueItem[];
  collectBuffer?: QueueItem[];
  blockedGateId?: string;
}

interface QueueItem {
  id: string;
  threadId: string;
  content: PromptContent;
  author?: PromptAuthor;
  channel?: ChannelTarget;
  replyTarget?: ChannelTarget;
  model?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

type SessionEntry =
  | MessageEntry
  | DecisionGateEntry
  | CompactionEntry
  | BranchSummaryEntry;
```

**Data flow:** The engine writes through SessionStore during execution. The API layer reads through SessionStore for client queries (session lists, message history, etc.). Both hit the same underlying database. The engine is the writer, the API is the reader, the database is the shared state.

Hot/cold storage tiering (e.g., DO SQLite as write-through cache for D1) is an implementation detail of the SessionStore, not a concern of the engine or API layer. The `flush()` method is called by the engine on session shutdown, giving the store a chance to drain any internal buffers.

**Implementations:**
- `D1SessionStore` — Cloudflare D1 via Drizzle
- `PostgresSessionStore` — PostgreSQL via Drizzle
- `InMemorySessionStore` — for tests and ephemeral agents

#### Required Tables

The engine schema owns these tables. Existing application tables may mirror selected fields during rollout, but the engine must not depend on current `messages`, `session_threads`, or DO-local queue tables for correctness.

| Table | Purpose | Key fields |
|---|---|---|
| `engine_sessions` | Canonical engine session state | `id`, `user_id`, `org_id`, `workspace`, `purpose`, `status`, `sandbox_id`, `snapshot_id`, `metadata`, timestamps |
| `engine_threads` | Thread metadata and active leaf | `id`, `session_id`, `key`, `status`, `active_leaf_entry_id`, `queue_mode`, `model`, `summary`, `metadata` |
| `engine_entries` | DAG history | `id`, `session_id`, `thread_id`, `parent_id`, `entry_type`, `role`, `content`, `parts`, `metadata`, `created_at` |
| `engine_queue_items` | Persisted per-thread queue | `id`, `session_id`, `thread_id`, `status`, `mode`, `content`, `author`, `channel`, `reply_target`, `model`, `metadata`, timestamps |
| `engine_decision_gates` | Pending and terminal gate state | `id`, `session_id`, `thread_id`, `type`, `status`, `title`, `body`, `actions`, `origin`, `context`, `resolution`, `expires_at`, timestamps |
| `engine_decision_gate_refs` | Delivered channel refs | `id`, `gate_id`, `channel_type`, `ref`, `created_at`, `updated_at` |
| `engine_suspended_turns` | Restart-safe blocked turn checkpoints | `session_id`, `thread_id`, `queue_item_id`, `gate_id`, `model`, `leaf_entry_id`, `tool_call_id`, `tool_name`, `tool_args`, `resume_key`, `attempt`, `created_at` |
| `engine_credentials` | Stored credentials when adapter uses engine schema | `id`, `owner_type`, `owner_id`, `service`, `credential_type`, `encrypted_data`, `scopes`, `expires_at`, timestamps |
| `engine_oauth_states` | OAuth handshake state | `state`, `user_id`, `service`, `redirect_uri`, `code_verifier`, `metadata`, `expires_at` |

Indexes are required on `(session_id, thread_id, created_at)` for entries, `(session_id, thread_id, status)` for queue items and gates, and `(owner_type, owner_id, service)` for credentials.

### EventBus

Broadcasts engine events to external subscribers (clients, other services). The engine pushes events; the adapter subscribes and relays to clients.

```typescript
interface EventBus {
  publish(event: BusEvent): Promise<void>;
  subscribe(filter: EventFilter, callback: (event: BusEvent) => void): Unsubscribe;
}

interface BusEvent {
  sessionId: string;
  threadId?: string;
  userId?: string;
  event: EngineEvent;
  timestamp: number;
}

interface EventFilter {
  sessionId?: string;
  userId?: string;
  eventTypes?: string[];
}

type Unsubscribe = () => void;
```

**Implementations:**
- `DOEventBus` — posts to a thin EventBus Durable Object
- `RedisEventBus` — Redis pub/sub channels per session/user
- `InMemoryEventBus` — direct callback (single-process, tests)

### Channel Transports

Channel transports are in scope for V1 at the adapter boundary. The engine does not render Slack or Telegram payloads directly, but it does define the decision-gate and reply-routing contract that transports must implement.

```typescript
interface ChannelTransport {
  readonly channelType: string;

  verifySignature?(headers: Record<string, string>, rawBody: string, secret?: string): boolean | Promise<boolean>;
  parseInbound?(headers: Record<string, string>, rawBody: string, ctx: ChannelTransportContext): Promise<InboundChannelEvent | null>;

  sendMessage(target: ChannelTarget, message: OutboundMessage, ctx: ChannelTransportContext): Promise<ChannelMessageRef | null>;
  updateMessage?(target: ChannelTarget, ref: ChannelMessageRef, message: OutboundMessage, ctx: ChannelTransportContext): Promise<void>;

  sendDecisionGate?(target: ChannelTarget, gate: DecisionGate, ctx: ChannelTransportContext): Promise<DecisionGateRef | null>;
  updateDecisionGate?(target: ChannelTarget, ref: DecisionGateRef, update: DecisionGateUpdate, ctx: ChannelTransportContext): Promise<void>;

  parseInboundDecision?(payload: unknown, ctx: ChannelTransportContext): Promise<{
    gateId: string;
    actionId?: string;
    value?: string;
    actorExternalId?: string;
  } | null>;
}

interface ChannelTarget {
  channelType: string;
  channelId: string;
  threadId?: string;
}

interface ChannelTransportContext {
  userId: string;
  orgId: string;
  sessionId: string;
  threadId?: string;
  token?: string;
  botToken?: string;
  persona?: {
    name?: string;
    avatar?: string;
    metadata?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

interface OutboundMessage {
  text?: string;
  markdown?: string;
  attachments?: Array<{
    type: 'image' | 'file';
    url: string;
    mimeType: string;
    name?: string;
    caption?: string;
  }>;
  replyTo?: ChannelMessageRef;
  metadata?: Record<string, unknown>;
}

interface ChannelMessageRef {
  messageId: string;
  channelId: string;
  threadId?: string;
  [key: string]: unknown;
}

type DecisionGateUpdate =
  | { status: 'resolved'; resolution: DecisionResolution }
  | { status: 'expired' }
  | { status: 'withdrawn'; reason: DecisionWithdrawReason };

type InboundChannelEvent =
  | { type: 'message'; target: ChannelTarget; text: string; actor: ChannelActor; messageId?: string; attachments?: PromptAttachment[] }
  | { type: 'decision'; gateId: string; actionId?: string; value?: string; actor: ChannelActor; target?: ChannelTarget; messageId?: string };

interface ChannelActor {
  id: string;
  displayName?: string;
  email?: string;
}
```

**Slack is the required reference transport for V1.** The V1 implementation must define:

- how a Slack thread maps to `channelType = 'slack'` and a stable `channelId`
- how Slack button clicks map back to `gateId` / `actionId`
- how free-text thread replies resolve pending decision gates when the stored origin matches
- how previously sent Slack decision gates are updated on resolution, expiry, or withdrawal

Other transports may follow the same contract later, but Slack is the minimum transport that must be fully specified and implemented for V1.

Slack `channelId` is canonicalized as `teamId:channelId:threadTs` for thread replies and `teamId:channelId` for channel-level messages. The transport may store native Slack fields (`ts`, `thread_ts`, `response_url`) inside `DecisionGateRef`, but engine-visible routing always uses the canonical `ChannelTarget`.

### BlobStore

File attachments, images, artifacts. Simple key-value with streaming.

```typescript
interface BlobStore {
  put(key: string, data: Uint8Array | ReadableStream, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<{ data: ReadableStream; contentType?: string } | null>;
  delete(key: string): Promise<void>;
}
```

**Implementations:**
- `R2BlobStore` — Cloudflare R2
- `S3BlobStore` — AWS S3 / MinIO

### CredentialStore

Stores OAuth tokens and API keys per user per service. Handles encryption transparently within the implementation: the engine passes an encryption key via adapter config, the store encrypts/decrypts tokens internally. The engine and tools never see encrypted blobs.

```typescript
interface CredentialStore {
  get(owner: CredentialOwner, service: string): Promise<StoredCredential | null>;
  save(owner: CredentialOwner, service: string, credential: StoredCredential): Promise<void>;
  delete(owner: CredentialOwner, service: string): Promise<void>;
  list(owner: CredentialOwner): Promise<{ service: string; scopes?: string[]; connectedAt: string }[]>;
}

interface CredentialOwner {
  type: 'user' | 'org' | 'session';
  id: string;
}

interface StoredCredential {
  type: 'oauth2' | 'api_key' | 'bot_token' | 'service_account' | 'app_install';
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  expiresAt?: number;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}
```

**Token refresh:** When a credential's `expiresAt` is in the past (or within a configurable buffer), the CredentialProvider wrapper in the engine auto-refreshes using the OAuth provider's token endpoint before returning the token to the tool. This requires OAuthProviderConfig for the service (token URL, client credentials). Transparent to the tool.

**OAuth flow:** OAuth connection flows (user initiates "Connect GitHub" from the UI) live in the API layer. The API handles redirect, callback, and token exchange, then stores the credential via CredentialStore. The engine consumes stored credentials at tool execution time.

**OAuth provider registry:** Plugin packages export their OAuth configuration alongside their tools:

```typescript
interface OAuthProviderConfig {
  service: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  clientSecret: string;
  refreshable: boolean;
}
```

The API layer collects these at startup to power the OAuth connection UI and callback handling.

Credential lookup order is tool-defined but must be explicit. The default order is session-scoped credential, user credential, org credential. If no credential is found and the tool requires one, `CredentialProvider.request()` creates a `DecisionGate` of type `credential_request`.

## Schema and Migrations

The engine owns the canonical database schema. Schema definitions live in the engine package as Drizzle TypeScript schemas. Migration files are generated per dialect (SQLite for D1, PostgreSQL for PG) and ship with the engine package.

```
packages/engine/
  src/schema/              ← Drizzle schema definitions (source of truth)
  migrations/
    sqlite/                ← generated by drizzle-kit for D1
    postgresql/            ← generated by drizzle-kit for PG
```

**Schema coverage:** The engine schema defines tables for sessions, threads, message entries, queue state, decision gates, suspended turns, credentials, and OAuth states. This is the same schema the SessionStore and CredentialStore implementations read from and write to.

**Workflow for adding a field:**
1. Update the Drizzle schema in `packages/engine/src/schema/`
2. Run `drizzle-kit generate` for each dialect — produces migration SQL
3. Migration files ship with the engine package
4. On deploy, each platform applies migrations through its normal mechanism:
   - Cloudflare: `wrangler d1 migrations apply`
   - Kubernetes: init container or migration job running `drizzle-kit migrate`

The SessionStore interface has no `migrate()` method. Migrations are a deployment concern, not a runtime interface. The engine is a library; it does not own the deployment lifecycle.

### Current Schema Coexistence

During rollout, engine tables live beside current application tables. The Cloudflare adapter may mirror engine data into existing tables used by the current client, analytics, and admin views, but the engine source of truth is always the `engine_*` schema.

Required mirroring during the transition:

- `engine_sessions` to current `sessions` for session lists and access control joins.
- `engine_threads` to current `session_threads` for thread lists.
- `engine_entries` message entries to current `messages` for existing history readers.
- `engine_decision_gates` to client event/API responses. No legacy decision-prompt table is created or written by the new engine path.

The old DO-local prompt queue and decision storage are not part of the new runtime. Once the Cloudflare adapter is fully switched over, DO storage is limited to hosting concerns such as hibernation state and WebSocket bookkeeping.

## Platform Adapters

A platform adapter wires the engine to a specific deployment target. It does three things:

1. Instantiates provider implementations (SessionStore, SandboxProvider, EventBus, BlobStore, CredentialStore)
2. Hosts the engine process (DO on CF, long-running process on K8s)
3. Provides the HTTP/WebSocket entrypoint for clients and API routes

### Shared API Routes (`packages/api/`)

API route handlers are written once and shared across platforms. They are Hono route factories parameterized by provider implementations:

```typescript
export function sessionRoutes(store: SessionStore, engine: EngineManager) {
  const router = new Hono();
  router.get('/:id', async (c) => {
    const session = await store.getSession(c.req.param('id'));
    return c.json(session);
  });
  router.post('/:id/threads/:threadId/prompt', async (c) => {
    const body = await c.req.json();
    await engine.getSession(c.req.param('id'))
      .thread(c.req.param('threadId'))
      .prompt(body.content);
    return c.json({ ok: true });
  });
  return router;
}
```

Each adapter imports these factories and injects its providers. The route logic is written once.

#### Required API Surface

The shared API package owns route behavior. Adapters own authentication middleware, provider construction, and request context injection.

| Method | Route | Behavior |
|---|---|---|
| `POST` | `/api/sessions` | Create a session and return session metadata plus client stream URL |
| `GET` | `/api/sessions/:sessionId` | Read session metadata and live status |
| `DELETE` | `/api/sessions/:sessionId` | Terminate and delete/archival-mark a session |
| `POST` | `/api/sessions/:sessionId/prompt` | Prompt the default thread |
| `GET` | `/api/sessions/:sessionId/threads` | List threads |
| `POST` | `/api/sessions/:sessionId/threads` | Create a thread |
| `GET` | `/api/sessions/:sessionId/threads/:threadId` | Read thread metadata and entries |
| `POST` | `/api/sessions/:sessionId/threads/:threadId/prompt` | Prompt a specific thread |
| `POST` | `/api/sessions/:sessionId/threads/:threadId/abort` | Abort current turn and clear this thread queue |
| `POST` | `/api/sessions/:sessionId/threads/:threadId/pause` | Pause this thread |
| `POST` | `/api/sessions/:sessionId/threads/:threadId/resume` | Resume this thread |
| `GET` | `/api/sessions/:sessionId/decision-gates` | List pending and recent terminal gates |
| `POST` | `/api/sessions/:sessionId/decision-gates/:gateId/resolve` | Resolve a pending gate |
| `POST` | `/api/sessions/:sessionId/decision-gates/:gateId/withdraw` | Withdraw a pending gate |
| `GET` | `/api/sessions/:sessionId/events` | SSE stream for client events |
| `GET` | `/api/sessions/:sessionId/ws` | WebSocket stream for client events and optional prompt/control messages |
| `GET` | `/api/sessions/:sessionId/tunnels` | Return sandbox tunnel URLs |
| `POST` | `/api/sessions/:sessionId/snapshot` | Snapshot session sandbox and persist snapshot ID |

Prompt routes accept the same `PromptOptions` shape as the engine API. WebSocket prompt/control messages are optional conveniences over the same route semantics; they must not define separate behavior.

### Cloudflare Adapter (`packages/adapter-cloudflare/`)

```
Cloudflare Worker (Hono)
  ├── API routes (shared from packages/api/)
  │     └── reads/writes via D1SessionStore
  │
  ├── WebSocket upgrade → subscribes to DOEventBus → relays to client
  │
  └── Session operations → SessionHostDO
        │
        SessionHostDO (thin shell, ~100 lines)
          ├── creates Engine instance on first request
          ├── injects: D1SessionStore, ModalSandbox, DOEventBus, R2BlobStore
          ├── forwards prompt/abort/pause/resume to engine
          └── engine runs agent loop, emits events, writes state
```

The SessionHostDO is a thin shell. It creates an engine instance with CF provider implementations, forwards incoming requests, and uses DO hibernation so idle sessions don't consume compute. On wake, it restores the engine from SessionStore state.

### Kubernetes Adapter (`packages/adapter-k8s/`)

```
K8s Service (Hono/Node)
  ├── API routes (shared from packages/api/)
  │     └── reads/writes via PostgresSessionStore
  │
  ├── WebSocket upgrade → subscribes to RedisEventBus → relays to client
  │
  └── Session operations → SessionPool
        │
        SessionPool (process manager)
          ├── spawns/reuses engine instances per session
          ├── injects: PostgresSessionStore, ModalSandbox, RedisEventBus, S3BlobStore
          ├── forwards prompt/abort/pause/resume to engine
          └── engine runs in-process
```

The SessionPool manages engine instances in-process. Idle instances are evicted after a timeout (equivalent to DO hibernation). Session affinity via K8s ingress routes requests for the same session to the same pod.

### What Each Adapter Provides

| Interface | Cloudflare | Kubernetes |
|---|---|---|
| SessionStore | D1 via Drizzle | PostgreSQL via Drizzle |
| SandboxProvider | Modal SDK | Modal SDK / K8s Pod API |
| EventBus | DO singleton | Redis pub/sub |
| BlobStore | R2 | S3 / MinIO |
| CredentialStore | D1 (encrypted) | PostgreSQL (encrypted) |
| Channel transports | Worker-integrated (Slack required for V1) | Service-integrated (Slack required for V1) |
| Engine host | SessionHostDO | SessionPool (in-process) |

### Adapter Host Contract

Every adapter must provide:

- Request authentication and authorization before calling shared API route handlers.
- Provider construction for the current deployment target.
- Engine instance lookup by session ID.
- Session affinity so prompts, decision resolutions, and aborts for one session reach the same active engine instance.
- Event subscription and client delivery over WebSocket and/or SSE.
- Startup restoration of queued, running, and blocked threads from `SessionStore` via `engine.restoreSession({ sessionId, options })`. The adapter is responsible for reconstructing `options` (tools, sandbox handle, model, system prompt, role/skill sources) from its own configuration — the engine itself does not persist creation options.
- Idle eviction/hibernation that calls `store.flush()` and leaves enough persisted state to resume. Specifically: any thread with status `running` or `blocked_on_decision_gate`, plus its active queue item and (for blocked threads) its `SuspendedTurnState`, must be readable on wake.
- Fatal error handling that marks the session `error`, publishes a client `error` event, and prevents silent queue accumulation.

Cloudflare V1 uses one `SessionHostDO` per session ID. Kubernetes may use a process-local `SessionPool`, but must provide equivalent session affinity and restore behavior.

## Tool Implementation and Integration Framework

### Plugin Package Structure

Plugin packages live in `packages/plugin-*/`. Each exports tools as `ToolDef[]` and optionally exports OAuth configuration.

```typescript
// packages/plugin-github/src/tools.ts
import type { ToolDef } from '@valet/engine';

export const tools: ToolDef[] = [
  {
    name: 'github.create_pr',
    description: 'Create a pull request on GitHub',
    parameters: Type.Object({
      repo: Type.String(),
      title: Type.String(),
      body: Type.String(),
      head: Type.String(),
      base: Type.String(),
    }),
    execute: async (args, ctx) => {
      const cred = await ctx.credentials.get('github');
      if (!cred) {
        await ctx.credentials.request('github', 'Need GitHub access to create a PR');
      }
      const res = await fetch(`https://api.github.com/repos/${args.repo}/pulls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cred.accessToken}` },
        body: JSON.stringify(args),
      });
      const pr = await res.json();
      return { text: `Created PR #${pr.number}: ${pr.html_url}` };
    },
  },
];

// packages/plugin-github/src/oauth.ts
import type { OAuthProviderConfig } from '@valet/engine';

export const oauth: OAuthProviderConfig = {
  service: 'github',
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  scopes: ['repo', 'read:org'],
  clientId: process.env.GITHUB_CLIENT_ID!,
  clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  refreshable: false,
};
```

### Tool Registration

Tools from plugin packages are registered at session creation. The adapter collects tools from all enabled plugins and passes them to the engine:

```typescript
import { tools as githubTools } from '@valet/plugin-github';
import { tools as slackTools } from '@valet/plugin-slack';
import { tools as linearTools } from '@valet/plugin-linear';

const session = await engine.createSession({
  sandbox: await sandboxProvider.create({ image, workspace }),
  tools: [...githubTools, ...slackTools, ...linearTools],
  // ...
});
```

The engine merges plugin tools with built-in tools. Name conflicts between plugins are caught at registration time. Per-thread tool overrides are merged at prompt time (thread-level wins on name conflict).

### Engine-to-Tool Data Flow

```
Engine receives tool call from LLM
  → looks up ToolDef by name
  → constructs ToolContext { userId, orgId, sessionId, threadId, channel metadata, repo context, credentials, sandbox, signal }
  → calls toolDef.execute(args, ctx)
  → tool uses ctx.credentials.get('service') for API auth
  → tool uses ctx.sandbox.exec() / readFile() if it needs sandbox access
  → tool may call ctx.requestDecision(...) for gated human input
  → tool returns ToolResult { text, attachments? }
  → engine handles attachments per type (vision, blob store, inline)
  → engine feeds result back to LLM via pi-agent-core
```

## Observability and Error Contract

The engine distinguishes user-visible recoverable errors from fatal session errors.

```typescript
interface EngineError {
  code: string;
  message: string;
  recoverable: boolean;
  sessionId?: string;
  threadId?: string;
  queueItemId?: string;
  gateId?: string;
  cause?: unknown;
}

interface RuntimeMetric {
  type:
    | 'llm_call'
    | 'tool_exec'
    | 'queue_wait'
    | 'turn_complete'
    | 'decision_gate_wait'
    | 'sandbox_exec'
    | 'model_failover'
    | 'compaction';
  sessionId: string;
  threadId?: string;
  durationMs?: number;
  model?: string;
  toolName?: string;
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: string;
  properties?: Record<string, unknown>;
}
```

Required behavior:

- Recoverable thread errors emit an `error` event and mark the active queue item complete or failed.
- Fatal session errors update session status to `error`, flush state, and prevent new prompts until restored or restarted.
- Every model call emits token/cost metadata when available.
- Every tool call emits duration and success/failure metadata.
- Decision gates measure wait duration from creation to terminal state.
- Logs may contain IDs and high-level errors, but must not contain secrets, OAuth tokens, command environment secrets, or full credential payloads.

## Implementation Direction

### Reference Flue, Build In-Repo

Valet V1 will build its own engine in-repo and may borrow ideas or implementation patterns from Flue, but will not depend directly on `@flue/sdk` as the runtime substrate.

Reasons:
- Full control over the agent loop, compaction, and threading model
- First-class support for multi-threaded sessions rather than single-active-operation sessions
- First-class decision-gated execution rather than Flue's headless-only default
- Channel-aware routing and adapter contracts for web, Slack, Telegram, and orchestrator threads
- Richer tool context and persistence contracts aligned with Valet's integrations and multiplayer model

Flue remains a useful reference implementation for:

- session/runtime structure around `pi-ai` and `pi-agent-core`
- sandbox abstraction
- built-in filesystem/shell/task tools
- DAG-style history and compaction patterns
- Cloudflare adapter and persistence patterns

This is a settled V1 decision, not an open implementation choice. The engine package will be built in-repo and may reference Flue code where useful, but Valet owns the runtime contracts and implementation.
