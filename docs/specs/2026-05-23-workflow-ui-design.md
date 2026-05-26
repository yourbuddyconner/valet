# Workflow UI Redesign

> Design for the execution detail page and the session chat experience for workflow-driven sessions. Focuses on making workflow runs **inspectable, scannable, and idiomatic** instead of a wall of JSON.

**Status:** Design accepted after two review rounds (completeness, then staff-engineer architecture). Ready for implementation plan.

**Relationship to prior work:** Builds on the May 15 workflow UI MVP (`docs/specs/2026-05-15-workflow-ui-mvp-design.md`), which delivered `WorkflowDiagram`, live step events, and the create/detail/edit pages. This design adds the execution detail page experience and the workflow rendering in session chat.

## Problem

1. **Execution detail page** dedicates ~50% of the screen to the diagram and dumps step outputs as a stack of generic JSON blocks in a fixed right sidebar. No semantic per-type rendering, no per-iteration grouping inside loops, and "No active step" wastes the sidebar once a run is terminal.

2. **Session chat for workflow-driven sessions** shows workflow prompts as chat bubbles with a "via workflow" badge, with no visible link to which step they came from, no rendering at all for non-`agent_prompt` steps (bash, notify, …), and no at-a-glance progress.

The original session-chat bug (assistant responses not appearing) is fixed (`bedd58e`, `0fd8122`); this design assumes those fixes hold.

## Architectural principle

**Workflow steps are step rows; chat messages are chat messages.** The two are different domain objects, and the session view interleaves them by timestamp at the view-model layer. Workflow rendering does **not** require a new message schema, a paired-message protocol, or a regrouping pass over `messages`. This was a wrong turn in the previous draft and is excised here.

Consequence: there is a single source of truth for "what happened during this workflow execution" — the `workflow_execution_steps` table — and both surfaces (execution page and session chat) consume it.

## Scope

In scope:

- Execution detail page at `/automation/executions/$executionId`
- Session chat rendering for workflow-driven sessions: a workflow context bar plus interleaved step cards in chat
- Shared step-card component family used by both surfaces
- Backend changes that make per-instance identity (loop iteration / parallel branch / conditional branch) reconstructible end-to-end

Out of scope:

- Workflow builder UI
- Triggers list, workflows list, executions list pages
- Mid-flight token streaming inside `agent_prompt` cards (v2)
- Activating `pending_approvals` for richer approval metadata (separate prerequisite work — see [Approval card limitations](#approval-card-limitations))

## Phasing

Two phases behind two feature flags. The execution page is independently valuable and ships first.

| Phase | Surface | Flag | Depends on |
|--|--|--|--|
| 1 | Execution detail page redesign | `workflow_ui_execution_v2` | iterationPath end-to-end (backend) |
| 2 | Workflow rendering in session chat | `workflow_ui_chat_cards` | Phase 1 components; `workflow-chat-message` ownership validation |

Phase 1 is the larger, higher-leverage slice. Phase 2 reuses the step-card components from Phase 1 and adds only the context bar and the chat-interleave logic.

## Backend changes

### 1. Per-instance step identity (`iterationPath`)

**Problem:** Steps inside a loop reuse the same `stepId`. The current unique key on `workflow_execution_steps` is `(executionId, stepId, attempt)`, so later iterations overwrite earlier ones. Parallel branches and conditional branches have the same problem.

**Solution:** A `/`-joined path segment identifier on every step row, threaded end-to-end.

#### Path grammar

`/`-joined segments. Empty string `''` for top-level steps.

| Container | Segment shape | Example |
|--|--|--|
| Loop | `<loopStepId>:i<index>` | `loopA:i0` |
| Parallel | `<parallelStepId>:b<branchIndex>` | `parA:b1` |
| Conditional | `<condStepId>:then` or `<condStepId>:else` | `condA:then` |

Nested example: a step inside the first iteration of `loopA`, which is inside branch 1 of `parA` → `iterationPath = 'parA:b1/loopA:i0'`.

Rationale (vs. opaque `stepInstanceId`): the path encodes hierarchy without parent pointers, which makes reconstruction in SQL and the client cheap (prefix matching). It also reads well in logs and debug tooling.

#### Schema change

Single migration on `workflow_execution_steps`:

| Column | Type | Notes |
|--|--|--|
| `iterationPath` | text NOT NULL DEFAULT `''` | per-instance path |

- Drop unique `(executionId, stepId, attempt)`.
- Add unique `(executionId, stepId, attempt, iterationPath)`.
- Add non-unique index `(executionId, iterationPath)` for the timeline read path.

Existing rows backfill `''`. Old loop iterations were already lossy — we do not attempt to reconstruct them.

#### Runner change — ExecContext owns the path

`packages/runner/src/workflow-engine.ts` currently has no explicit nesting state outside `ctx.variables.loop`. Introduce `iterationPath: string` on the execution context, default `''`. Push a segment when entering a container, pop when exiting.

- Loop: at each iteration `i`, set the child context's `iterationPath = parent + '/' + loopStepId + ':i' + i` (or just the segment if parent is empty).
- Parallel: each branch `b` gets `iterationPath = parent + '/' + parallelStepId + ':b' + b`.
- Conditional: child context gets `iterationPath = parent + '/' + condStepId + ':' + ('then'|'else')`.

The path is passed through to every step trace write **and** included on `WorkflowStepResult`.

#### Identity contract — every write path must carry the path

This is where the previous draft fell short. There are **three** upsert sites and all must honor `iterationPath`:

1. `packages/worker/src/services/executions.ts:455` `upsertExecutionStepFromEvent` — live step events. Wire change: add `iterationPath` to the `workflow.execution.step` event payload (`packages/shared/src/types/runner-protocol.ts`). Event ingest writes it through to `upsertExecutionStep`.
2. `packages/worker/src/services/session-workflows.ts:1337` — finalize after envelope returns. Add `iterationPath` to `WorkflowStepResult` in `packages/runner/src/workflow-engine.ts` so the envelope carries it; finalize writes it through to `upsertExecutionStep`.
3. `packages/worker/src/services/executions.ts:231` — admin/test path; same treatment.

`upsertExecutionStep` (`packages/worker/src/lib/db/executions.ts:198`) takes `iterationPath` as a required field; the upsert `ON CONFLICT` clause matches on the new four-tuple.

**Retry-from-step** (`packages/worker/src/services/session-workflows.ts:423`): the replayed step results passed back into the runner already carry `iterationPath` (because they came from the prior execution's persisted rows). The runner's resume seeds outputs from these rows; verify it can locate the right replay row by `(stepId, iterationPath)` and not just `stepId`. If retry-from-step targets a step inside a loop iteration, the targeted step's path is preserved in the retry directive.

**Approval wait/resume:** approval steps inside loops, parallel branches, or conditionals are real (`approval` is a regular step type and runs wherever the workflow places it). The current pause mechanism stashes the targeted step in the execution's runtime state and resumes on `resumeToken`; that resume must carry `iterationPath` so the resumed runner knows *which* instance of the approval step is unblocking. Concretely: the runtime-state payload written by the WorkflowExecutorDO when transitioning to `waiting_approval` records `{ stepId, iterationPath, attempt }`, not just `stepId`. On resume, the engine matches the resumed step by that triple. Without this, an approval step inside a loop iteration `i=2` would resume the wrong (or first matching) instance.

#### Validation

If a runner emits a step trace with an `iterationPath` whose container segments don't match the static workflow definition (e.g., `iterationPath = 'unknownStep:i0'` for a step that doesn't exist), the ingest path drops the event with a structured warn and records a telemetry counter. We don't reject — we surface the row as orphaned and fall through to the fallback renderer.

### 2. Step output enrichment

Each step type's `outputJson` is shaped to make the per-type renderer's job trivial. Additive — the fallback renderer continues to work on rows without these fields.

| Step type | Current `outputJson` | New shape |
|--|--|--|
| `agent_prompt` | string or parsed object | `{ response, model, inputTokens, outputTokens, durationMs }`. The response payload moves under `response`. |
| `bash` | `{ stdout, stderr, exitCode }` | unchanged — shape-lock as a typed interface and write a test. |
| `notify` | `{ type, target, delivered }` | `{ ..., channelType, channelId, error? }`. Channel meta resolved at notify-handler dispatch time. |
| `approval` | nothing structured | `{ decision: 'approved' \| 'denied' \| 'timed_out', decidedAt }`. **Approver identity / reason are out of scope** until `pending_approvals` is activated; the card renders only what is available today. |
| `loop` / `parallel` / `conditional` | unchanged | container steps; renderer reads children, not the container's `outputJson`. |

### 3. `agent_prompt` chat messages

This is the **only** workflow→chat data flow. Today the runner emits a `workflow-chat-message` for the prompt before the agent runs, and the assistant's reply comes back through the normal OpenCode session path. After this design:

- Prompt: still a `workflow-chat-message` emitted by the runner before the agent runs.
- Response: continues to flow through OpenCode's normal message path.
- Both messages persist a small **back-pointer** to their step row: `workflowExecutionId`, `workflowStepId`, `workflowIterationPath`. **No new tables, no `messageGroupId`, no paired-message protocol.** Three nullable columns on `messages`, populated only for workflow-originated messages.

The chat surface uses the back-pointer to (a) badge the message with its step type/persona/iteration and (b) link to the execution page. The message is **not** merged into the step card — see [interleaved cards](#session-chat--workflow-steps-as-interleaved-cards) for the chronology contract.

**Trust boundary:** the DO handler at `packages/worker/src/durable-objects/session-agent.ts:2246` currently writes whatever `workflow-chat-message` says into the message row. Before persisting the new back-pointer fields, the DO must validate that the `workflowExecutionId` belongs to this session's user — parity with the step-event ingest at `session-agent.ts:3530` / `executions.ts:455`. Without this check, a compromised runner could attribute arbitrary messages to arbitrary executions.

### 4. What we are *not* changing

- No `messageGroupId`.
- No new message table.
- No regrouping pass over messages.
- No streaming-into-card.
- No paired emit-prompt/emit-response protocol.
- No new approval table or `pending_approvals` activation.

## Frontend design

### Execution page (`/automation/executions/$executionId`)

| | |
|--|--|
| Split | Timeline ~60% left, diagram ~40% right |
| Primary | Vertical timeline of step cards keyed by `(stepId, iterationPath)` |
| Diagram | Slim scroll-synced rail (`mode="runtime"`); clicking a node opens the corresponding card |
| Header | `ExecutionHeader` unchanged |
| Deleted | `ExecutionStepPanel`, `ExecutionStepTracePanel`, `ExecutionVariablesPanel` |

### Step card behavior

- Collapsed by default with a one-line summary.
- **Failures auto-expand.** A step transitioning to `failed` opens; focus moves to its header so screen-readers and keyboard users land there.
- **Last terminal step** in a completed run also auto-expands as a default focus.
- Clicking a diagram node opens its card and scrolls to it (controlled expansion — see `ToolCardShell` extension).
- **In-flight cards show elapsed time** (live ticker on `startedAt`), not a bare "thinking…". When the step transitions to `cancelled`, `failed`, or the execution is swept stuck, the card shows that terminal state. Cards never sit in unbounded "pending" — they key off step status.

### Per-step-type rendering

Each step type gets a typed renderer; the chrome comes from extended `ToolCardShell`.

| Type | Header summary | Expanded body |
|--|--|--|
| `agent_prompt` | step name, persona pill, iteration tag, `Nms · model · in/out tokens` | **prompt** section (from `inputJson`) + **response** section (from `outputJson.response`). Structured outputs render as a key/value table; plain text via `DeferredMarkdownContent`. |
| `bash` | `name · echo "..." → exit N` | command + stdout + stderr (if present). Exit-code pill in header. |
| `notify` | `name · channel · status` | channel chip (`channelType`/`channelId`), delivery state, error block when present. |
| `tool` | `name · tool` | delegates to the existing `chat/tool-cards/` renderer for that tool name; falls back to `generic-card`. |
| `conditional` | `name · → then/else` | condition expression (from `inputJson`), indicator of which branch was taken (derived from any child row whose `iterationPath` ends in `<condId>:then\|else`), child cards inline under the taken branch. |
| `loop` | `name · over <expr> · N iterations` | iteration tabs at the card head (one per `:i<n>` segment found in children); only the active tab's children mount; "all iterations" affordance mounts everything. |
| `parallel` | `name · N branches` | branches as stacked groups (one per `:b<n>` segment), with branch durations to expose the critical path. |
| `approval` | `name · approved/denied/timed out` | reads `outputJson.decision` and `decidedAt`. No approver/reason in v1. |
| _fallback_ | `name · type` | generic JSON-tree over `outputJson`. |

### Approval card limitations

Today's approval mechanism uses `resumeToken` on the execution row, not the `pending_approvals` table (per `docs/specs/workflows.md`). The v1 approval card therefore shows only the decision and timestamp. Rendering approver identity, decision reason, and timeout requires activating `pending_approvals` as a backend prerequisite — captured as a separate piece of work, not part of this design.

### Loops / parallel / conditional — child reconstruction

Combine:

1. Static workflow tree (from `useWorkflow` query or `execution.workflowSnapshot`) — container shape and step types.
2. Step-trace rows — each row's `iterationPath` says where in the dynamic tree it lives.

Algorithm:

- Walk the static tree top-down.
- For each container step, group child rows by their next `iterationPath` segment.
- Render container cards with children attached to the right iteration/branch.
- Steps with no row yet (pending) render as placeholders.

Only the active iteration's children are mounted; "all iterations" mounts everything.

Computed via a `useMemo` keyed on `(stepsData, workflowDef)`. Result is a normalized timeline view-model that drives rendering.

### Diagram rail

- `WorkflowDiagram` in `mode="runtime"`, ~360px wide on desktop; collapses to a top strip below 900px viewport.
- Scroll-sync: `IntersectionObserver` on each timeline card updates a shared `highlightedStepKey`. Diagram node clicks `scrollIntoView({ block: 'center' })` the card and set its controlled-open state.
- Diagram shows top-level steps only; clicking a container scrolls to its card and the card's iteration tabs take over from there.

### Retry & recovery

- Inline `↻ retry from here` on any failed step's expanded card (calls `useRetryExecutionFromStep`). Navigates to the new execution on success.
- Inline `↗ open in builder` on any failed step's expanded card.
- The page-level `ExecutionHeader` retry remains and retries the whole run.

**Retry creates a new execution and a new workflow session.** Navigation moves to the new execution detail page; the new session has its own chat (and its own context bar). The old session/execution stay accessible at their URLs.

A small "retry of …" affordance in the new execution's `ExecutionHeader` is captured as a v2 follow-up.

### Session chat — workflow context bar

A slim bar between the chat header and the message list, visible whenever `session.metadata.executionId` is set (workflow sessions persist this at creation in `packages/worker/src/lib/workflow-runtime.ts`).

Contents:
- Workflow name (from execution → workflow lookup)
- Execution short id
- Current step / total (derived from step trace + workflow def)
- Progress dots (one per top-level step, color-coded)
- "execution ↗" link

Lifecycle: persists for the life of the session. Workflow sessions don't become non-workflow sessions; for terminal executions, the bar shows the final status.

`role="status"` so screen readers announce progress changes.

### Session chat — workflow steps as interleaved cards

The session chat shows a **merged feed** of two streams, in timestamp order:

1. **Chat messages** — user/assistant/system rows from `messages`. Render through the existing `MessageItem` / `AssistantTurn` path. Unchanged.
2. **Workflow step rows** — every row from `workflow_execution_steps` for the session's active execution, rendered with the same step-card components as the execution page.

Composition lives in a new `useSessionFeed(sessionId)` hook that:
- pulls messages via the existing chat query,
- pulls step rows via `useExecutionSteps(session.metadata.executionId)`,
- merges into an ordered list of `{ kind: 'message' | 'step', timestamp, ... }`,
- memoizes the merge on `(messages, steps)` identity so it isn't recomputed on every render.

`MessageList` renders this list and dispatches per `kind`:
- `kind === 'message'` → existing `MessageItem` / `AssistantTurn` flow.
- `kind === 'step'` → `WorkflowStepCard` for that step row.

The `agent_prompt` prompt and response are real chat messages and render normally — the user sees the prompt as a chat bubble, the response as a chat bubble. They are **also** linked via back-pointer to the same step row, but the chat doesn't merge them. The corresponding `agent_prompt` step card renders inline at the step row's timestamp, giving the persona/iteration/model/token framing. This is purposeful redundancy: chat reads as chat, and the step card surfaces the workflow-specific framing without breaking chronology.

**Mid-step user messages** interleave naturally — they're separate timestamps in the feed; the merge has no awareness of step boundaries.

### Visual idiom

- Match `ToolCardShell`: `w-fit max-w-[min(100%,70vw)]`, rounded, monospace, compact header row, sections via `ToolCardSection` / `ToolCodeBlock`.
- Status colors reuse the tool-call palette.
- Step type icons in a new `step-cards/icons.tsx`.

### `ToolCardShell` extension (additive)

Add optional props; no existing callers change:

- `open?: boolean`, `onOpenChange?: (next: boolean) => void` — controlled expansion (needed for diagram-click and auto-expand-on-failure).
- `id?: string` — when set, header button gets `aria-controls={id + '-body'}`, body div gets that id.
- `headerRef?: Ref<HTMLButtonElement>` — for focus-on-auto-expand.
- Always emit `aria-expanded` on the header button (currently absent).

If review shows the controlled props don't fit naturally, extract a primitive `<CardShell>` and make both `ToolCardShell` and the workflow card a thin wrapper. Default: extend in place.

### Accessibility

- All step cards expose `aria-expanded` / `aria-controls`.
- Auto-expand on failure moves focus to the card's header.
- Diagram nodes are buttons with `aria-label="step <name> — <status>"`, reachable by keyboard; clicking sets a roving focus to the corresponding card's header.
- Loop iteration tabs are a tablist (`role="tablist"`, `role="tab"`, `aria-selected`, arrow-key navigation).
- The workflow context bar is `role="status"`.

## Components

New (in `packages/client/src/components/workflows/step-cards/`):

| File | Purpose |
|--|--|
| `agent-prompt-card.tsx` | Prompt + response rendering for a step row. Reads from `inputJson`/`outputJson`. |
| `bash-card.tsx` | Command + stdout + stderr. |
| `notify-card.tsx` | Channel chip + state + error. |
| `tool-card.tsx` | Delegates to existing `chat/tool-cards` registry. |
| `conditional-card.tsx` | Condition + branch taken + children. |
| `loop-card.tsx` | Iteration tabs + children. |
| `parallel-card.tsx` | Branches + critical path. |
| `approval-card.tsx` | Decision + decidedAt. |
| `fallback-card.tsx` | Generic JSON tree. |
| `index.tsx` | `byStepType` dispatcher; exports `WorkflowStepCard`. |
| `icons.tsx` | One icon per step type. |

New page-level (in `packages/client/src/components/workflows/`):

| File | Purpose |
|--|--|
| `execution-timeline.tsx` | Left-pane vertical timeline. Owns the controlled-open map keyed by `(stepId, iterationPath)`. |
| `execution-diagram-rail.tsx` | Right-rail `WorkflowDiagram` wrapper with scroll-sync. |
| `workflow-context-bar.tsx` | Slim bar at the top of session chat. |

New client hooks:

| File | Purpose |
|--|--|
| `hooks/use-session-feed.ts` | Memoized merge of messages and step rows for workflow sessions. |
| `hooks/use-execution-timeline.ts` | Memoized merge of step rows and static workflow tree into the timeline view-model. |

Modified:

- `routes/automation/executions/$executionId.tsx` — swap right sidebar for `ExecutionTimeline` + `ExecutionDiagramRail`.
- `components/chat/message-list.tsx` — when the session has an associated execution, render `useSessionFeed(sessionId)` instead of the bare messages list.
- `routes/sessions/$sessionId.tsx` — mount `WorkflowContextBar` when `session.metadata.executionId` is present.
- `components/chat/tool-cards/tool-card-shell.tsx` — additive controlled-expansion + ARIA props.

Deleted: `execution-step-panel.tsx`, `execution-step-trace.tsx`, `execution-variables-panel.tsx`.

## Client state model

- **Timeline expansion state** lives in `ExecutionTimeline` as a `Map<cardKey, boolean>` where `cardKey = stepId + '#' + iterationPath`. Local component state in v1.
- **Failure auto-expand** is evaluated once per step transition to `failed`. Users may manually collapse afterward; we do not re-open on subsequent re-renders.
- **Live step events** flow through `useExecutionStepEvents`. Out-of-order events (event arrives before the row exists) currently get dropped by the hook at `use-execution-step-events.ts:117`. Acceptable trade-off documented there; the next poll catches up. We do **not** change this for the redesign.
- **`useWorkflow`** is a normal query, not push. Workflow definition is treated as immutable for the duration of a viewed execution (the snapshot is the source of truth anyway).
- **Tab refresh / reconnect** rehydrates from step trace + message rows. Expansion state resets. Failure auto-expand re-fires for currently-failed steps.

## Edge cases

- **Workflow definition missing** (source deleted, no snapshot): show the existing banner; render step rows grouped by `iterationPath` prefix in flat order; skip the diagram rail.
- **Step with no enriched `outputJson`** (executions before this change): fallback renderer.
- **Loop with zero iterations**: container shows "0 iterations · condition not met".
- **Conditional with no branch taken**: "skipped".
- **Parallel branch failure**: branch group shows error; others continue.
- **Long loops (>50 iters)**: iteration tabs collapse to a dropdown after 10; "all iterations" warns and chunks rendering with virtualization.
- **Orphan step row** (iterationPath references a non-existent container): renders as a standalone fallback card; telemetry counter increments.
- **In-flight `agent_prompt` with no response message yet**: card shows elapsed time on the response section.
- **`agent_prompt` step transitions to `failed` / `cancelled` with no response**: card shows the terminal state, surface the step `error`. No infinite "thinking…".
- **Stuck-execution sweep** (cron marks the execution `failed` after 2h): step cards still in `running` flip to a stuck-failed state when the execution status flips.
- **Workflow message back-pointer with no matching step row**: render the message normally (no badge/link); telemetry counter increments. Don't error.

## Feature flags & rollout

Two GrowthBook-style flags, evaluated client-side:

- `workflow_ui_execution_v2` — guards the execution detail page rewrite. Off → legacy page.
- `workflow_ui_chat_cards` — guards `WorkflowContextBar` and `useSessionFeed` rendering in session chat. Off → status quo.

Backend changes (iterationPath, output enrichment, message back-pointers, DO validation) ship un-flagged because they are additive and required by both phases.

**Rollout:**
- Backend migration + runner/worker changes deploy together; verify on existing executions (fallback renderer).
- Phase 1 flag on for internal users only; dogfood (see below) for a week.
- Flag on for all users.
- Phase 2 follows with its own internal-only → all rollout.

## Dogfood plan

Before flipping `workflow_ui_execution_v2` to all users, exercise:

1. A workflow with a loop of ≥3 iterations, each containing an `agent_prompt` with a persona.
2. A workflow with a `parallel` of ≥2 branches, each containing a `bash` step.
3. A workflow with a `conditional` where both `then` and `else` paths exist in the static tree; run both branches across two executions.
4. A workflow with an `approval` step — approve, then deny, then time-out (separate runs).
5. **Retry-from-step** targeting a step inside a loop iteration; verify the new execution preserves `iterationPath`.
6. A workflow with a `notify` step that fails (interpolation error); verify the error renders.
7. The stuck-execution sweep path: synthetically mark an execution stuck and verify cards render the terminal state.

Each scenario validates a specific code path that the staged review found risky. Sign-off requires all seven.

## Telemetry

Add client-side counters (Cloudflare Analytics or existing usage events):

| Counter | Why |
|--|--|
| `workflow_ui.step_instance_collision` | When the client receives two step rows with identical `(stepId, attempt, iterationPath)` — should never happen post-migration; warns if it does. |
| `workflow_ui.orphan_step_row` | Step row's `iterationPath` references a container not in the static workflow tree. |
| `workflow_ui.workflow_message_no_step` | Back-pointer on a message references a missing step row. |
| `workflow_ui.agent_prompt_response_missing` | `agent_prompt` step is `completed` but no response message exists (broken pipeline). |
| `workflow_ui.fallback_renderer_used` | Step row missing enriched `outputJson` — surfaces stale-execution rate. |
| `workflow_ui.migration_irregularity` | Step rows with `iterationPath = ''` that were children of a container per the static def — backfill artifact. |

Server-side: log + counter for `workflow-chat-message` ownership-check failures; this is the new trust boundary.

## Performance

- `useSessionFeed` and `useExecutionTimeline` are pure functions of their inputs; memoize on stable identities (`messages.length + lastMessageId`; `steps.length + lastUpdatedAt`).
- The timeline view-model is computed once per data update, not per render.
- Long executions (>200 steps): the timeline virtualizes after 100 visible cards (existing `react-virtuoso` is already in the bundle for sessions list).
- Diagram → timeline scroll sync uses a single `IntersectionObserver` instance shared across all cards (not one per card).

## v2 follow-ups

- Mid-flight token streaming inside `agent_prompt` response sections.
- "Retry of …" affordance in `ExecutionHeader` for retried executions.
- URL-persisted card expansion (`?step=<key>`).
- Collapsible diagram rail.
- Approver identity, reason, timeout on approval cards (requires activating `pending_approvals` — separate prerequisite spec).

## Boundary rules

- Backend changes are confined to: a single migration (iterationPath + back-pointer columns); runner ExecContext + envelope changes; worker validation; output enrichment in three step handlers.
- This design does NOT change workflow execution algorithm or semantics — only what is persisted and emitted.
- Non-workflow sessions are unaffected — `useSessionFeed` is gated on `session.metadata.executionId`.
- The new step-card components are client-only and consume the documented API.

## Open questions

None. Implementation details (exact pill colors, virtualization thresholds, exact rollout dates, migration ordering) can be made during the implementation pass.
