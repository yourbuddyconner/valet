# Workflow UI Redesign

> Design for the execution detail page and the session chat experience for workflow-driven sessions. Focuses on making workflow runs **inspectable, scannable, and idiomatic** instead of a wall of JSON.

**Status:** Design accepted. Pending implementation plan.

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

Out of scope (explicitly):

- Workflow builder UI (`/workflows/$id/edit`)
- Triggers list, workflows list, executions list pages
- Backend changes beyond surfacing existing data (step type, structured output) to the client
- Real-time streaming protocol changes (the existing `workflow.execution.step` and `workflow-chat-message` events are sufficient)

## Decisions

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
- **Failures auto-expand.** A step with `status === 'failed'` always opens.
- The **last terminal step** in a completed run also auto-expands as a default focus.
- Clicking the diagram node for a step scrolls the timeline to it and opens the card.

### Per-step-type rendering

Each step type gets a typed renderer. The card chrome (border, status dot, header row, expand chevron) comes from a shared `WorkflowStepCardShell` that mirrors `ToolCardShell`.

| Type | Header summary | Expanded body |
|--|--|--|
| `agent_prompt` | step name, persona pill, iteration tag (if in a loop), `Nms · model · tokens` | **prompt** section (italic quoted block) + **response** section. Structured outputs (when an `outputSchema` was used) render as a key/value table. Plain-text/markdown responses render with the existing `DeferredMarkdownContent`. |
| `bash` | `name · echo "..." → exit N` | **command** section (terminal-styled `<pre>`) + **stdout** section (terminal block) + **stderr** section if present. Exit-code pill in header (green for `0`, red otherwise). |
| `notify` | `name · target · status` | **target** chip (channel type + id) + **delivery** state + **error** block (when present) with a human-readable explanation. |
| `tool` | `name · tool` | Re-uses the existing `chat/tool-cards/` renderer for that tool name where one exists; falls back to `generic-card` style. |
| `conditional` | `name · condition · → then/else` | **condition** expression, indicator of which branch was taken, child step cards rendered inline (indented) under the taken branch. |
| `loop` | `name · over <expr> · N iterations` | **iteration tabs** at the head of the card (`iter 1`, `iter 2`, …, plus an "all" affordance); each tab shows that iteration's child step cards. Indented child cards. |
| `parallel` | `name · N branches` | Branches as collapsible stacked groups. Branch durations annotated to make the critical path visible. |
| `approval` | `name · approved by/denied by/timed out` | Approver, decision, reason text if rejected, timeout if expired. |
| _fallback_ | `name · type` | Existing JSON-tree renderer as graceful degradation. |

### Loops and nesting

- A loop card is a container. Its child steps render under it, indented.
- Iteration tabs at the card head select which iteration's children are visible. Only one iteration is mounted at a time to keep the DOM small for high-iteration loops.
- An "all iterations" affordance switches to a stacked view (all iterations visible at once) for cross-iteration inspection.
- Conditional and parallel cards are similar containers — children inline.

### Diagram rail

- Reuses `WorkflowDiagram` component in a compact mode (`mode="runtime"` already exists).
- Width: ~360px on desktop; collapses to a top strip on narrow viewports.
- Scroll-sync: scrolling the timeline highlights the corresponding node in the graph; clicking a node scrolls the timeline to that step and opens its card.
- A future enhancement (not in this spec) could make the rail fully collapsible.

### Retry & recovery

- Inline `↻ retry from here` button on any failed step's expanded card (calls existing `useRetryExecutionFromStep` mutation; navigates to the new execution on success).
- Inline `↗ open in builder` button on any failed step's expanded card (deep-links to `/workflows/$id/edit?step=$stepId`).
- The page-level "Retry" affordance in `ExecutionHeader` remains and now retries the whole run.

### Session chat for workflow-driven sessions

- A slim **workflow context bar** sits between the chat header and the message list whenever the session has an associated workflow execution. Contents: workflow name, execution short id, current step / total, progress dots (one per top-level step, color-coded by status), and a "execution ↗" link.
- The bar is sticky to the top of the chat scroll region.
- The bar disappears once there is no active or recent workflow execution attached to the session.

### Workflow steps as inline tool-card-style messages

- Workflow-originated messages render as inline cards using a new `WorkflowStepCard` component built on the existing `ToolCardShell` (reuse the shell directly; do not fork it).
- `agent_prompt` cards are **merged**: a single card contains both the prompt and the response as labeled sections. There is no separate assistant-bubble message for workflow prompts.
- During a live run, the response section streams inside the card. When the card is collapsed, the streaming response truncates to a single-line summary.
- Bash, notify, tool, conditional, loop, parallel, approval cards are fully self-contained — no follow-up bubble.
- The user can still chat with the session normally between workflow steps. Their messages render as regular chat bubbles and interleave chronologically with the workflow cards.

### Visual idiom

- Match `ToolCardShell` exactly: `w-fit max-w-[min(100%,70vw)]`, rounded border, monospace, compact header row, content sections via `ToolCardSection`/`ToolCodeBlock`.
- Status colors reuse the existing tool-call palette (`completed` emerald, `error` red, `running` accent blue/amber, `pending` neutral).
- Step type icons live in a new `step-cards/icons.tsx` (one icon per type).

## Components

New components (all in `packages/client/src/components/workflows/step-cards/`):

| File | Purpose |
|--|--|
| `step-card-shell.tsx` | Thin wrapper around `ToolCardShell` that adds workflow-specific affordances (retry-from-here button, builder deep-link). May be replaced by direct shell usage if the wrapper adds nothing. |
| `agent-prompt-card.tsx` | Merged prompt+response card; integrates `DeferredMarkdownContent` for text responses, kv-table for structured output. |
| `bash-card.tsx` | Terminal-style command/stdout/stderr renderer. |
| `notify-card.tsx` | Channel chip + delivery state + error renderer. |
| `tool-card.tsx` | Delegates to existing `chat/tool-cards` registry by tool name. |
| `conditional-card.tsx` | Condition + branch indicator + child renderer. |
| `loop-card.tsx` | Iteration tabs + child renderer. |
| `parallel-card.tsx` | Branches + critical-path annotations. |
| `approval-card.tsx` | Approver + decision + reason. |
| `fallback-card.tsx` | Generic JSON-tree renderer. |
| `index.tsx` | `byStepType` dispatcher (mirrors `chat/tool-cards/index.tsx`). |
| `icons.tsx` | One icon per step type. |

New page-level components (in `packages/client/src/components/workflows/`):

| File | Purpose |
|--|--|
| `execution-timeline.tsx` | The new left-pane vertical timeline. Drives card mounting from `useExecutionSteps` data + `useExecutionStepEvents` live updates. Handles loop/conditional/parallel child nesting from the workflow definition. |
| `execution-diagram-rail.tsx` | Wrapper around `WorkflowDiagram` for the right rail with scroll-sync logic. |
| `workflow-context-bar.tsx` | Slim bar at the top of session chat for workflow-driven sessions. |

Deleted components:

- `execution-step-panel.tsx`
- `execution-step-trace.tsx`
- `execution-variables-panel.tsx`

Modified components:

- `routes/automation/executions/$executionId.tsx` — swap right sidebar for `ExecutionTimeline` (left) and `ExecutionDiagramRail` (right).
- `components/chat/message-item.tsx` — when a message has `channelType: 'workflow'` and a step descriptor, dispatch to the appropriate `step-cards` renderer instead of rendering a chat bubble.
- `routes/sessions/$sessionId.tsx` — mount `WorkflowContextBar` above the chat when the session has an attached active or recent workflow execution.

## Data dependencies

The client already has most of what it needs:

- `useExecution(executionId)` — execution record with `outputs`, `status`, etc.
- `useExecutionSteps(executionId)` — per-step trace rows with `stepId`, `attempt`, `status`, `inputJson`, `outputJson`, `error`, `startedAt`, `completedAt`.
- `useExecutionStepEvents(sessionId, executionId, status)` — live `workflow.execution.step` events.
- `useWorkflow(workflowId)` — live workflow definition; falls back to `execution.workflowSnapshot`.
- Workflow definition gives us the step tree (including nested children inside loops/conditionals/parallels) and per-step type, name, persona, etc.

Additions / clarifications:

- `workflow_execution_steps.outputJson` for `agent_prompt` steps must include both the text/structured response **and** model + token metadata. Verify the runner is writing this — if not, extend the trace write in `packages/runner/src/prompt.ts` to include `model`, `inputTokens`, `outputTokens`.
- The `workflow-chat-message` event already carries `parts`, `channelType`, `channelId`, `opencodeSessionId`. To render the inline workflow step card, the client also needs `stepId`, `stepType`, `executionId`, and `iteration` (when inside a loop). Extend the event payload to include these fields, and persist them on the message row (`step_id`, `step_type`, `execution_id`, `iteration` columns on `messages`, or as JSON in a new `workflow_meta` column).

## State and lifecycle

- **Card expansion state** is local component state; lost on remount. No URL persistence in v1.
- **Failure auto-expand** is evaluated once per step status transition; users may collapse failed cards manually after.
- **Live runs**: step events flow in through `useExecutionStepEvents`. New steps append to the timeline; running steps render with the accent pulse from `ToolCardShell`; completed/failed steps swap status and may auto-expand on failure.
- **Streaming responses** inside an `agent_prompt` card render via the same streaming path used for assistant bubbles today.
- **Diagram scroll-sync** uses an `IntersectionObserver` on each timeline card to update the highlighted node in the diagram. Click handlers on diagram nodes use `scrollIntoView({ block: 'center' })` on the corresponding timeline card.

## Error and edge cases

- **Workflow definition missing** (source workflow deleted, no snapshot): show the existing "source deleted" banner; render whatever step trace data exists in flat order (no nesting); skip the diagram rail.
- **Step with no `outputJson`**: card body shows only metadata; no fallback JSON dump.
- **Loop with zero iterations**: card shows the empty state ("0 iterations · condition not met"); no children.
- **Conditional with no branch taken** (early termination): show condition + "skipped".
- **Parallel branch failure**: branch group shows error; other branches continue rendering normally.
- **Very long loops (>50 iterations)**: iteration tabs collapse to a dropdown after the first 10; "all iterations" view warns and chunks rendering with virtualization.
- **Mixed workflow + user chat**: workflow cards and user/assistant bubbles render in chronological order by `createdAt`. No re-grouping.

## Boundary rules

- This design does NOT change the workflow execution engine (`packages/runner/src/workflow-engine.ts`).
- This design does NOT change the persistence model for `workflow_executions` or `workflow_execution_steps` beyond the `outputJson` enrichment noted above.
- The new step-card components are **client-only**. They consume the existing API contracts.
- The session chat changes do not affect non-workflow sessions — `MessageItem` dispatches to the workflow-card branch only when the message has a workflow `stepId`.

## Open questions

None — all major decisions are above. Implementation details (exact icons, exact pill colors, virtualization thresholds, etc.) can be made during the implementation pass.
