# Workflow UI Redesign

> Design for the execution detail page and the session chat experience for workflow-driven sessions. Focuses on making workflow runs **inspectable, scannable, and idiomatic** instead of a wall of JSON.

**Status:** Design accepted, codex completeness/correctness review applied. Ready for implementation plan.

**Relationship to prior work:** Builds on the May 15 workflow UI MVP (`docs/specs/2026-05-15-workflow-ui-mvp-design.md` / `docs/plans/2026-05-15-workflow-ui-mvp.md`), which delivered the shared `WorkflowDiagram` component, real-time step events, and the workflow create/detail/edit pages. This design reuses those primitives and focuses specifically on the **execution detail page** and **session-chat rendering** layers, which the MVP left as minimum-viable.

## Problem

Two related UX failures exist today:

1. **Execution detail page** dedicates ~50% of the screen to the workflow diagram and dumps all step outputs as a long stack of generic JSON blocks in a fixed-width right sidebar. There is no semantic rendering per step type, no connection between the diagram and the outputs, no per-iteration grouping inside loops, and the live trace shows "No active step" once a run is terminal — wasting space precisely when results are most useful.

2. **Session chat for workflow-driven sessions** shows workflow prompts as user-bubble messages with a "via workflow" badge, but treats them like any other chat message. The relationship between a prompt and its response is invisible, non-chat step types (bash, notify) don't surface at all, and the user cannot see at a glance what workflow is running or how far along it is.

The original session-chat bug (assistant responses not appearing) has been fixed in recent commits (`bedd58e`, `0fd8122`). This design assumes those fixes hold and focuses on what the chat *should show* for workflow runs going forward.

## Scope

In scope:

- Execution detail page at `/automation/executions/$executionId`
- Session chat rendering when the session contains workflow-originated messages
- New shared step-card component family for rendering workflow steps in both surfaces
- Backend changes required to make the above renderable (engine outputs, persistence, wire protocol)

Out of scope (explicitly):

- Workflow builder UI (`/workflows/$id/edit`)
- Triggers list, workflows list, executions list pages
- Real-time *streaming* of `agent_prompt` responses into cards — v1 emits the response as a single message on completion. Streaming is captured as a v2 follow-up.

## Backend changes

The renderers below depend on data the engine doesn't persist or transmit today. These changes are required and part of this design.

### `workflow_execution_steps` — per-instance identity for nested children

**Problem:** Steps inside a loop reuse the same `stepId`, and the unique key is `(executionId, stepId, attempt)`. Later iterations overwrite earlier ones, making iteration tabs, parallel branches, and conditional-branch attribution impossible to reconstruct.

**Change:** Add a per-execution-instance path identifier.

| New column | Type | Notes |
|--|--|--|
| `iterationPath` | text NOT NULL DEFAULT `''` | `/`-joined segments describing the dynamic execution path. Empty string for top-level steps. |

Segment grammar: `<containerStepId>:<discriminator>`.

- Loops: `<loopStepId>:i<index>` (zero-indexed).
- Parallel: `<parallelStepId>:b<branchIndex>` (zero-indexed by branch order in the definition).
- Conditional: `<condStepId>:then` or `<condStepId>:else`.

Examples:
- Top-level bash step: `iterationPath = ''`
- First iter of a loop, inside an outer parallel branch 1: `iterationPath = 'outerPar:b1/loopA:i0'`

**Index changes:**
- Drop the existing unique on `(executionId, stepId, attempt)`.
- Replace with unique on `(executionId, stepId, attempt, iterationPath)`.
- Add a non-unique index on `(executionId, iterationPath)` for the timeline read path.

**Runner change:** `packages/runner/src/workflow-engine.ts` tracks an `ExecContext` already; extend it with the current `iterationPath`. When entering a loop/parallel/conditional container, push the appropriate segment; pop on exit. Pass `iterationPath` through to every step trace write and every step event.

**Migration:** existing rows backfill `iterationPath = ''`. Old loop iterations were already lossy; we don't try to reconstruct them.

### `workflow.execution.step` event — carry `iterationPath`

Add `iterationPath: string` to the step event payload (`packages/shared/src/types/runner-protocol.ts` and `packages/worker/src/services/executions.ts` event ingest). Client correlates the event to the right card by `(stepId, iterationPath)`.

### Step output enrichment

The per-type renderers need fields the engine isn't writing. For each, the runner extends the step's `outputJson` before the trace upsert. Schema is additive — fallback renderer continues to work on rows without the new fields.

| Step type | Current `outputJson` | Add |
|--|--|--|
| `agent_prompt` | response payload (string or parsed object) | wrap as `{ response, model, inputTokens, outputTokens, durationMs }`. The response payload moves under `response`. |
| `notify` | `{ type, target, delivered }` | `{ ..., channelType, channelId, error }`. `channelType`/`channelId` resolved from the target string at notify-handler dispatch time. `error` set when delivery skipped or failed. |
| `approval` | nothing structured (status alone) | `{ decision: 'approved' \| 'denied' \| 'timed_out', approverId, approverEmail, reason, decidedAt }`. Sourced from `pending_approvals` rows on resume. |
| `bash` | `{ stdout, stderr, exitCode }` | already present — verify and shape-lock. |

**Backward compatibility:** the fallback card renderer reads raw `outputJson` for any row without the typed fields. No need to backfill old executions.

### `messages` table — workflow message metadata

Workflow chat messages are a different kind of thing than chat. The DO currently drops the runner's metadata bag on the floor. We need it persisted.

**Add columns to `messages`** (single new migration):

| Column | Type | Notes |
|--|--|--|
| `workflowExecutionId` | text NULL | Set on messages emitted by a workflow run. |
| `workflowStepId` | text NULL | The step that produced this message. |
| `workflowStepType` | text NULL | `agent_prompt` / `tool` / `notify` etc. Denormalized so the client doesn't need to join. |
| `workflowIterationPath` | text NULL | Matches the step trace's `iterationPath`. |
| `messageGroupId` | text NULL | Stable across the prompt and response messages of a single `agent_prompt` step instance. Used by the client to merge them visually. |

Index on `(workflowExecutionId)` for execution-page back-references.

### `workflow-chat-message` runner→DO event

Add typed fields to the event in `packages/shared/src/types/runner-protocol.ts`:

```typescript
{
  type: 'workflow-chat-message';
  role: 'user' | 'assistant' | 'system';
  content: string;
  parts?: MessagePart[];
  channelType?: string;
  channelId?: string;
  opencodeSessionId?: string;
  // new
  workflowExecutionId: string;
  workflowStepId: string;
  workflowStepType: string;
  workflowIterationPath: string;
  messageGroupId: string;
}
```

The DO handler at `packages/worker/src/durable-objects/session-agent.ts` writes these columns into the message row and broadcasts them on the client `message` event.

### `agent_prompt` step — emit prompt + response as paired messages

The runner already emits the **prompt** as a `workflow-chat-message` before the agent runs (`packages/runner/src/prompt.ts`). After the agent completes, emit the **response** as a second `workflow-chat-message` with the same `messageGroupId` and `workflowStepId`. Both messages get the same `workflowIterationPath`.

**No mid-flight streaming in v1.** The response message is sent once, when complete. Card shows a generic "thinking…" state in the response section while the underlying step status is `running`. Streaming is a follow-up (see v2 notes).

### Session → execution association

This already exists: workflow sessions persist `metadata.executionId` at creation (`packages/worker/src/lib/workflow-runtime.ts:61`). The context bar reads `session.metadata.executionId`. **Retention:** the bar is visible for the entire life of the session — if the session was spawned by a workflow, it remains a workflow session forever. For terminal executions, the bar shows the final status; no auto-disappear.

## Frontend design

### Execution page layout

| | |
|--|--|
| Split | Timeline ~60% left, diagram ~40% right |
| Primary | Vertical timeline of step cards |
| Diagram | Slim scroll-synced rail; clicking a node jumps the timeline; selected step highlighted in graph |
| Sidebar | Removed — `ExecutionStepPanel`, `ExecutionStepTracePanel`, `ExecutionVariablesPanel` are deleted |
| Header | `ExecutionHeader` unchanged |

### Step card behavior

- Collapsed by default with a one-line summary preview (similar to existing `ToolCardShell`).
- **Failures auto-expand.** A step with `status === 'failed'` always opens. After auto-expanding, focus moves to the card's header button so screen-readers and keyboard users land there.
- The **last terminal step** in a completed run also auto-expands as a default focus.
- Clicking the diagram node for a step scrolls the timeline to it and **opens the card** (controlled expansion — see ToolCardShell extension below).

### Per-step-type rendering

Each step type gets a typed renderer. The card chrome (border, status dot, header row, expand chevron) comes from the shared `ToolCardShell` (extended — see below).

| Type | Header summary | Expanded body |
|--|--|--|
| `agent_prompt` | step name, persona pill, iteration tag (if in a loop), `Nms · model · tokens` (from `outputJson.model` / `inputTokens` / `outputTokens`) | **prompt** section (italic quoted block, from inputJson) + **response** section. Structured outputs (when an `outputSchema` was used) render as a key/value table over `outputJson.response`. Plain-text/markdown responses render with the existing `DeferredMarkdownContent`. |
| `bash` | `name · echo "..." → exit N` | **command** section (terminal-styled `<pre>`) + **stdout** section + **stderr** section if present. Exit-code pill in header (green for `0`, red otherwise). |
| `notify` | `name · target · status` | **target** chip (renders `outputJson.channelType`/`channelId`) + **delivery** state + **error** block when `outputJson.error` is set. |
| `tool` | `name · tool` | Re-uses the existing `chat/tool-cards/` renderer for that tool name where one exists; falls back to `generic-card` style. |
| `conditional` | `name · condition · → then/else` | **condition** expression (from inputJson), indicator of which branch was taken (derived from child rows: any child step with `iterationPath` ending in `<condId>:then` means `then` was taken), child step cards rendered inline (indented) under the taken branch. |
| `loop` | `name · over <expr> · N iterations` | **iteration tabs** at the head of the card (`iter 1`, `iter 2`, …, plus an "all" affordance); each tab shows that iteration's child step cards. Indented child cards. Iteration count = `max(iterationPath segment index) + 1` over child rows. |
| `parallel` | `name · N branches` | Branches as collapsible stacked groups (one per `:b<n>` segment). Branch durations annotated. |
| `approval` | `name · approved by/denied by/timed out` | Reads `outputJson.decision`, `approverEmail`, `reason`, `decidedAt`. |
| _fallback_ | `name · type` | Generic JSON-tree renderer over `outputJson`. |

### Loops, parallel, conditional — child reconstruction

The timeline reconstructs nesting client-side by combining:

1. The static workflow tree (from `useWorkflow` or `execution.workflowSnapshot`) — gives the container shape and step types.
2. The step-trace rows — each row's `iterationPath` says where in the dynamic tree it lives.

Algorithm:

- Walk the static tree top-down.
- For each container step, group child rows by their next `iterationPath` segment.
- Render container cards with their children attached to the appropriate iteration/branch.
- Steps with no row yet (pending) render as placeholder cards.

Only the visible iteration's children are mounted at a time. The "all iterations" affordance mounts all.

### Diagram rail

- Reuses `WorkflowDiagram` component in `mode="runtime"`.
- Width: ~360px on desktop; collapses to a top strip on narrow viewports (<900px).
- **Scroll-sync:** an `IntersectionObserver` on each timeline card updates the highlighted node in the diagram via store/state. Clicking a node calls `scrollIntoView({ block: 'center' })` on the corresponding timeline card and sets that card's controlled-open state to `true`.
- The diagram shows top-level steps only; clicking a container node opens the container card and scrolls to it (the card's iteration tabs handle further navigation).

### Retry & recovery

- Inline `↻ retry from here` button on any failed step's expanded card (calls existing `useRetryExecutionFromStep` mutation; navigates to the new execution on success).
- Inline `↗ open in builder` button on any failed step's expanded card (deep-links to `/workflows/$id/edit?step=$stepId`).
- The page-level "Retry" affordance in `ExecutionHeader` remains and retries the whole run.

**Retry creates a new execution and a new workflow session.** `retryExecutionFromStep` in `packages/worker/src/services/session-workflows.ts` allocates a fresh `executionId` and a fresh `sessionId` bound to it. The UI navigates to the new execution detail page; the new session has its own chat (with its own context bar). The old session/execution remains accessible by its URL — there is no "same chat, new run" mode.

### Session chat for workflow-driven sessions

#### Workflow context bar

A slim bar sits between the chat header and the message list whenever `session.metadata.executionId` is set. Contents:

- Workflow name (from execution → workflow lookup)
- Execution short id
- Current step / total (derived from step trace + workflow definition)
- Progress dots (one per top-level step, color-coded by status)
- "execution ↗" link to `/automation/executions/$executionId`

The bar is sticky to the top of the chat scroll region. It persists for the life of the session (workflow sessions don't become non-workflow sessions). For terminal executions, the bar shows the final status.

Mounted at `routes/sessions/$sessionId.tsx`. Data source: `useSession(sessionId)` → `session.metadata.executionId` → `useExecution(executionId)`.

#### Workflow steps as inline cards

Message regrouping happens **at the `MessageList` level**, not `MessageItem`. The list runs a grouping pass:

- Messages with the same `messageGroupId` are merged into one "group" rendered as a single `WorkflowAgentPromptCard` (prompt + response combined).
- Messages with `workflowExecutionId` but no group peer render as standalone `WorkflowStepCard` (bash, notify, tool, conditional, loop, parallel, approval).
- Messages without `workflowExecutionId` render through the existing `MessageItem` / `AssistantTurn` paths.

A new `MessageList` helper `groupWorkflowMessages(messages)` produces an ordered list of `{ kind: 'workflow-step' | 'chat-turn', ... }` items; the renderer dispatches on `kind`. This regrouping is the only point where workflow vs chat is decided.

- `agent_prompt` cards are **merged**: a single card contains both the prompt and the response as labeled sections.
- During a live run, when only the prompt message has arrived, the response section shows a "thinking…" placeholder with the existing `RunningDots` animation.
- Bash, notify, tool, conditional, loop, parallel, approval cards are fully self-contained.
- The user can still chat normally between workflow steps. Their messages render as regular chat bubbles and interleave chronologically with the workflow cards.

### Visual idiom

- Match `ToolCardShell`: `w-fit max-w-[min(100%,70vw)]`, rounded border, monospace, compact header row, content sections via `ToolCardSection`/`ToolCodeBlock`.
- Status colors reuse the existing tool-call palette (`completed` emerald, `error` red, `running` accent, `pending` neutral).
- Step type icons live in a new `step-cards/icons.tsx` (one icon per type).

### `ToolCardShell` extension (additive)

The current `ToolCardShell` has uncontrolled expansion (`defaultExpanded` only) and no ARIA wiring. Extend additively — no existing callers change:

- Add optional `open?: boolean` and `onOpenChange?: (next: boolean) => void` props. When `open` is provided, the shell is fully controlled.
- Add `id?: string` prop; if supplied, the header button gets `aria-controls={id + '-body'}` and the body div gets that id.
- Always emit `aria-expanded` on the header button (currently absent).
- Add `headerRef?: Ref<HTMLButtonElement>` so consumers can move focus to it on auto-expand.

Workflow step cards consume the controlled API. Existing tool cards keep uncontrolled behavior.

### Accessibility

- All step cards expose `aria-expanded` / `aria-controls` (via the `ToolCardShell` extension).
- On auto-expand of a failed step, focus moves to that card's header.
- Clicking a diagram node sets a roving focus to the corresponding timeline card's header.
- Iteration tabs on loop cards are a tablist (`role="tablist"`, `role="tab"`, `aria-selected`, arrow-key navigation).
- The diagram rail is reachable via keyboard; nodes are buttons with `aria-label="step $name — $status"`.
- The workflow context bar has `role="status"` so screen-readers announce step progress changes.

## Components

New components (all in `packages/client/src/components/workflows/step-cards/`):

| File | Purpose |
|--|--|
| `agent-prompt-card.tsx` | Merged prompt+response card; reads `messageGroupId` group; integrates `DeferredMarkdownContent` for text responses, kv-table for structured output. |
| `bash-card.tsx` | Terminal-style command/stdout/stderr renderer. |
| `notify-card.tsx` | Channel chip + delivery state + error renderer. |
| `tool-card.tsx` | Delegates to existing `chat/tool-cards` registry by tool name. |
| `conditional-card.tsx` | Condition + branch indicator + child renderer. |
| `loop-card.tsx` | Iteration tabs + child renderer. |
| `parallel-card.tsx` | Branches + critical-path annotations. |
| `approval-card.tsx` | Approver + decision + reason. |
| `fallback-card.tsx` | Generic JSON-tree renderer. |
| `index.tsx` | `byStepType` dispatcher (mirrors `chat/tool-cards/index.tsx`). Exports `WorkflowStepCard` (top-level entry point) and `groupWorkflowMessages` helper. |
| `icons.tsx` | One icon per step type. |

New page-level components (in `packages/client/src/components/workflows/`):

| File | Purpose |
|--|--|
| `execution-timeline.tsx` | Left-pane vertical timeline. Reconstructs nested children from `iterationPath`. Drives card mounting from `useExecutionSteps` + `useExecutionStepEvents`. Owns expanded-card state for diagram-click and auto-expand integration. |
| `execution-diagram-rail.tsx` | Wrapper around `WorkflowDiagram` for the right rail with scroll-sync logic. |
| `workflow-context-bar.tsx` | Slim bar at the top of session chat for workflow-driven sessions. |

Deleted components:

- `execution-step-panel.tsx`
- `execution-step-trace.tsx`
- `execution-variables-panel.tsx`

Modified components:

- `routes/automation/executions/$executionId.tsx` — swap right sidebar for `ExecutionTimeline` (left) and `ExecutionDiagramRail` (right).
- `components/chat/message-list.tsx` — add a `groupWorkflowMessages` pass before rendering; dispatch grouped workflow items to `WorkflowStepCard`, leave chat turns on the existing `AssistantTurn`/`MessageItem` path.
- `routes/sessions/$sessionId.tsx` — mount `WorkflowContextBar` when `session.metadata.executionId` is present.
- `components/chat/tool-cards/tool-card-shell.tsx` — additive controlled-expansion and ARIA props (described above).

## Data dependencies (client)

Existing hooks, used as-is:

- `useExecution(executionId)` — execution record with `outputs`, `status`, etc.
- `useExecutionSteps(executionId)` — per-step trace rows. Will gain `iterationPath` after the migration.
- `useExecutionStepEvents(sessionId, executionId, status)` — live `workflow.execution.step` events. Will gain `iterationPath` after the protocol change.
- `useSession(sessionId)` — for the context bar's `metadata.executionId`.

Not "live": `useWorkflow(workflowId)` is a regular query fetch with no push semantics. The workflow definition is treated as immutable for the duration of a viewed execution (the snapshot is the source of truth anyway).

## State and lifecycle

- **Card expansion state** is owned by `ExecutionTimeline` (a `Map<cardKey, boolean>`), so that diagram clicks and auto-expand logic can drive it. Card key is `${stepId}#${iterationPath}`. Local component state in v1 — no URL persistence.
- **Failure auto-expand** is evaluated once per step status transition to `failed`. Users may collapse failed cards manually after; we do not re-open them on subsequent re-renders.
- **Live runs**: step events update step rows; new rows append to the timeline; running rows render with the accent pulse from `ToolCardShell`; completed/failed rows swap status and may auto-expand on failure.
- **Streaming responses** (v2): see follow-up note. v1 emits the response as a single message on completion.
- **Diagram scroll-sync**: an `IntersectionObserver` on each timeline card updates a shared `highlightedStepKey` state. Click handlers on diagram nodes look up the card by `stepKey` and set both the highlight and the controlled open state.
- **Tab refresh / reconnect**: state rehydrates from the persistent step trace + message rows. Live events resume via `useExecutionStepEvents`. Card expansion state resets (no persistence). Failure auto-expand re-fires on rehydrate for currently-failed steps.

## Error and edge cases

- **Workflow definition missing** (source workflow deleted, no snapshot): show the existing "source deleted" banner; render whatever step trace data exists in flat order grouped by `iterationPath` prefix; skip the diagram rail.
- **Step with no enriched `outputJson` fields** (old executions before this change): fallback card renderer kicks in; no crash.
- **Loop with zero iterations**: container card shows the empty state ("0 iterations · condition not met"); no children.
- **Conditional with no branch taken** (early termination): container shows condition + "skipped".
- **Parallel branch failure**: branch group shows error; other branches continue rendering normally.
- **Very long loops (>50 iterations)**: iteration tabs collapse to a dropdown after the first 10; "all iterations" view warns and chunks rendering with virtualization.
- **Mixed workflow + user chat**: workflow grouped items and chat turns render in chronological order by `createdAt` of the first message in the group. No cross-group merging.
- **Retried execution**: navigation moves the user to the new execution detail page; the old execution stays at its URL. Old session and new session are independent. No automatic cross-linking in v1 (the new execution's `triggerMetadata.sourceExecutionId` could surface a "retry of …" badge in `ExecutionHeader` — captured as a follow-up).
- **Message with `workflowExecutionId` but no matching step row** (events arrived out of order): render as a standalone fallback card; once the row arrives, the next render attaches it to its proper container.

## v2 follow-ups (not in this spec)

- **Streaming `agent_prompt` response into its card.** Requires either tagging OpenCode message chunks with workflow meta and routing them client-side, or buffering on the runner and emitting a stream of `workflow-chat-message` patches. Deferred so v1 ships.
- **"Retry of …" badge in `ExecutionHeader`** for retried executions.
- **URL-persisted card expansion** (`?step=<key>` to deep-link an open card).
- **Collapsible diagram rail.**

## Boundary rules

- The new step-card components live under `packages/client/src/components/workflows/` and consume only the documented API contracts above.
- Backend changes are confined to: a single new migration; runner engine changes for `iterationPath` and output enrichment; `workflow-chat-message` event payload extension; DO handler write of the new message columns.
- This design does NOT change the workflow execution **algorithm** (engine semantics, retries, approval handling) — only what it persists and emits.
- Non-workflow sessions are unaffected — the `MessageList` grouping pass skips messages with no `workflowExecutionId`.

## Open questions

None. Implementation details (exact icons, exact pill colors, virtualization thresholds, ordering of additive migrations) can be made during the implementation pass.
