# Workflow UI MVP

**Date:** 2026-05-15
**Status:** Draft — pending user review

## Summary

Rebuild the user-facing workflow surface around four pieces:

1. **`/automation/schedules-and-hooks`** — the page formerly known as Triggers. Same data, clearer presentation: humanized cron, type badges, plain-language target.
2. **`/automation/workflows/new`** — chat-to-create. User types intent in natural language, an LLM drafts the workflow JSON, the result renders as a React Flow diagram. Refine via prompt or per-node edit; attach a trigger; save.
3. **`/automation/workflows/$workflowId`** — workflow home. Same diagram component (view-only), trigger list, recent executions, edit / run / disable / delete actions.
4. **`/automation/executions/$executionId`** — live execution view. Same diagram component, but each node carries a runtime status indicator that updates via push events from the runner. Side panel shows the current step's context, step trace, and variables.

Shared infrastructure: one React Flow + dagre diagram component used across screens (varies by mode: editable, view-only, runtime status), and a real-time per-step event stream from the runner.

## Motivation

The backend works end-to-end (validated 2026-05-15 against the deployed dev env), but the UI surface has three concrete failures:

- **The Triggers page conflates two ideas.** Most user-facing triggers are orchestrator scheduled prompts (cron + a prompt). Calling them "triggers" is engine vocabulary that doesn't match the user's mental model. Cron expressions render raw. Whether a trigger fires a workflow or sends a prompt to the orchestrator isn't obvious.
- **There is no way to create a workflow from the UI.** Workflows arrive via plugin sync or API only. The entire workflow detail surface is unreachable for a fresh user, which means the system effectively doesn't exist for anyone who hasn't seeded one via curl.
- **Executions are opaque.** The executions index exists but shows terminal state only — there's no live progress view. When the underlying session is opened in chat, nothing indicates "this session is running execution X."

## Design

### 1. `/automation/schedules-and-hooks` (renaming `/automation/triggers`)

Single page, single data model (`triggers` table unchanged). The rename signals the page covers two real cases: time-based schedules and webhook hooks (and manual, but manual triggers are rare).

**Layout:**
- Page header: title "Schedules & Hooks", subtitle "Things that run on a schedule, fire from a webhook, or run on demand."
- Filter pills: All / Schedules / Webhooks / Manual (counts shown)
- Card list, one per trigger row
- "+ New trigger" CTA in header

**Trigger card structure:**
- Type icon + colored badge (`SCHEDULE` blue, `WEBHOOK` orange, `MANUAL` gray)
- Trigger name
- Enabled/disabled pill — disabled cards are grayed out in place, not filtered out
- **Condition line:**
  - Schedule: humanized cron string. Use [`cronstrue`](https://github.com/bradymholt/cronstrue) for humanization. Tooltip / hover surfaces the raw cron value. Timezone shown alongside.
  - Webhook: `POST /webhooks/{path}` displayed in monospace; small "Copy URL" button.
  - Manual: literal text "Run manually".
- **Target line:** "→ Sends prompt to your orchestrator" or "→ Runs workflow: {name}". Bold the workflow name; link it to that workflow's detail page.
- **Activity line:** "Last run: {relative}" + ("Next: {relative}" for schedules) or ("This week: N fires" for webhooks).
- Three-dot overflow menu: Enable/Disable, Edit, Delete.

**Existing routes stay:** `/automation/triggers` redirects to `/automation/schedules-and-hooks`. Sidebar nav item renames; route slugs change to match.

**Existing components reused:** `workflow-trigger-manager.tsx` (564 lines) currently does trigger CRUD inline on a workflow detail page. Extract the card rendering into a shared `<TriggerCard>` component used by both this page and the workflow detail page.

### 2. `/automation/workflows/new`

Chat-style creation. One screen, single flow:

**Empty state (no draft yet):**
- Big prompt input at top, centered.
- Placeholder text: e.g. "Every weekday at 9am, check my open PRs and send a summary to Slack..."
- Examples surfaced below the input as clickable starter prompts.
- No diagram yet.

**Generation flow:**
- On submit, POST to a new `/api/workflows/draft` endpoint that calls an LLM (Anthropic, server-side) with the workflow schema as system prompt + user's intent.
- Endpoint returns a draft `WorkflowDefinition` (the same shape as `workflows.data`). Validated server-side via `compileWorkflowDefinition` before responding — invalid drafts get re-prompted up to N times before surfacing to the user.
- While the LLM is thinking, show a skeleton of the diagram area.

**Draft state (after first generation):**
- User's prompt sits in a chat-turn bubble at top, with "↻ Regenerate" and "✎ Edit prompt" buttons.
- Workflow renders as React Flow diagram (see Shared Diagram Component below).
- Side panel toggle: `{ } JSON` button reveals/hides raw JSON in a right-side drawer. Drawer is read-only in this view (edits flow through chat).
- Trigger configuration section below the diagram: "How should this run?" with sub-options:
  - Schedule (cron picker with timezone)
  - Webhook (path + method)
  - Manual only
- Bottom strip: refine input + Save / Discard buttons.

**Refine modes (both supported):**
- **Whole-workflow:** type in the bottom input → POSTs `/api/workflows/draft` with the existing draft + the refinement. LLM produces a new full draft. Replace the diagram.
- **Per-step:** click any node → opens a small dialog with the existing step JSON + an input ("Change this step to..."). Send → POSTs `/api/workflows/draft/step` with the full workflow + target step ID + instruction. LLM returns the updated step (or the surrounding subtree if structure needs to change). Merge into the draft. Re-render.

**Save:**
- Trigger config required before save (or explicit "manual only" toggle). Saves are atomic: workflow + trigger created together in one transaction.
- On save, POST `/api/workflows/sync` (existing) for the workflow, then POST `/api/triggers` (existing) for the trigger. If trigger creation fails, the workflow is still saved.
- Redirect to `/automation/workflows/$workflowId` on success.

### 3. `/automation/workflows/$workflowId`

Workflow home. The page is composition of patterns established elsewhere.

**Layout:**
- Header: workflow name (editable inline), status pill (enabled/disabled), action menu (Run now, Edit name/description, Disable, Delete).
- Subheader: description, slug, version, last updated.
- Three sections, top-to-bottom:
  1. **Definition** — view-only React Flow diagram of the workflow. "Edit workflow" button opens the create-style flow with this workflow pre-loaded as the draft.
  2. **Triggers** — `<TriggerCard>` list (from §1), filtered to this workflow's triggers. "+ Add trigger" inline.
  3. **Recent executions** — compact list, last 10. Each row links to `/automation/executions/$executionId`. Each row shows: status pill, trigger source, started, duration. "View all" link goes to `/automation/executions?workflowId=...`.

**Note on the current 2151-line `$workflowId.tsx`:** the existing page is the editing surface today (multiple dialogs). After this work it becomes view + entry point. Most of the editing UI moves out into the create-style flow opened on "Edit workflow." Extract the diagram-rendering and trigger-listing logic into reusable components; remove the inline step editor.

### 4. `/automation/executions/$executionId`

Live execution view. Two-column layout (1.5 : 1).

**Header:**
- Breadcrumb: Automation / Executions
- Workflow name + status pill (`PENDING` / `RUNNING` / `WAITING_APPROVAL` / `COMPLETED` / `FAILED` / `CANCELLED`)
- Subline: trigger type, started time, duration (live ticker if running), executionId, "view session ↗" link
- Header actions: `{ } JSON`, Cancel (red, only while running), Approve / Deny (only while `waiting_approval`)

**Left column — diagram:**
- React Flow diagram (view-only structure, runtime status overlay).
- Per-node status visualization:
  - `pending` — dashed gray border
  - `running` — solid blue border + glow + spinner badge
  - `completed` — solid green border + checkmark badge
  - `failed` — solid red border + X badge + error tooltip
  - `waiting_approval` — solid orange border + pause badge + sticky action in header
  - `skipped` — solid gray border + strikethrough on branch label (e.g. `ELSE` struck when `THEN` was taken)
- Branch labels (`THEN`/`ELSE`) on conditional edges; loop iteration count on loop edges.

**Right column — current-step panel:**
- Top: current step card (type, name, key fields). For running agent_message steps, show the prompt; for bash, show the command.
- Middle: step trace, monospace, time-stamped (`[mm:ss.fff] EVENT description`). Auto-scroll to bottom while running.
- Bottom: variables snapshot. Each `outputVariable` set so far renders as a key + truncated JSON. "View full output" expands the step's `outputJson` in a modal.

### Shared Diagram Component

One React component used in three modes:

```tsx
<WorkflowDiagram
  workflow={WorkflowDefinition}
  mode="edit" | "view" | "runtime"
  runtimeStatus?={Record<stepId, StepStatus>}  // mode="runtime"
  currentStepId?={string}                       // mode="runtime"
  onNodeClick?={(stepId) => void}              // mode="edit"
/>
```

**Library choice:** `@xyflow/react` (React Flow v12) + `dagre` for vertical layout.

**Node types:** one custom React Flow node component per step type (`BashNode`, `AgentNode`, `ConditionalNode`, `ApprovalNode`, etc.). Each renders the type badge + step name + a key contextual field, sized consistently. In `runtime` mode each node also renders a status badge in the top-right corner.

**Layout pipeline:**
1. Walk the workflow JSON tree, producing a flat list of nodes and edges with parent-child relationships.
2. Feed into dagre with `rankdir: TB`, sensible spacing.
3. Produce `{ nodes, edges }` array for React Flow.
4. Conditional steps fork into two child nodes (THEN, ELSE) joined back after the branches finish.
5. Parallel steps fork into N child nodes joined back at a synthetic merge node.
6. Loops render the body once with a loop-back edge.

This is the only piece of net-new infrastructure with real complexity. Everything else is composition.

## Real-time step events

Make per-step progress visible without polling. Wires through existing infrastructure end-to-end.

### Runner → Worker

Today the runner reports step results only at execution completion (full denormalized blob to `/api/executions/:id/complete`). For real-time, the runner emits each step transition as it happens.

**New runner message type, sent over the existing `runnerLink` WebSocket:**

```typescript
type WorkflowStepEvent = {
  type: 'workflow-step-event';
  executionId: string;
  event: {
    kind: 'step.started' | 'step.completed' | 'step.failed' | 'step.skipped' | 'approval.required' | 'approval.approved' | 'approval.denied';
    stepId: string;
    attempt: number;
    timestamp: string;
    input?: unknown;     // step.started only
    output?: unknown;    // step.completed only
    error?: string;      // step.failed only
    durationMs?: number; // step.completed | step.failed
  };
};
```

The runner already emits these events internally to a sink (per the spec) — this change is to forward them across the WebSocket. The existing `executeWorkflowRun()` event sink in `workflow-engine.ts` gets a forwarder hook that calls `agentClient.sendWorkflowStepEvent(...)`.

### SessionAgentDO → D1 + EventBus

On receiving a `workflow-step-event`:
1. Upsert into `workflow_execution_steps` table with the partial status (existing upsert pattern with `ON CONFLICT DO UPDATE COALESCE`).
2. Update the execution row's overall status if needed (`running` → `waiting_approval` on `approval.required`).
3. Publish a new EventBus event: `workflow.execution.step` with the same payload.

### EventBus → Client

The execution details page subscribes to the EventBus stream for its execution's session (the execution row has `sessionId`). Client filters incoming events for `workflow.execution.step` matching `executionId` and updates local state.

**Fallback:** on page load or reconnect, fetch `/api/executions/:id/steps` once to seed state. Subsequent updates are push-only. No periodic polling.

### Completion reporting

`/api/executions/:id/complete` keeps working (idempotent — steps already upserted). On the worker side, completion treats per-step state as authoritative and reconciles the blob into D1 without duplicating already-recorded events.

## API additions

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/workflows/draft` | POST | Body: `{ prompt, baseDraft? }`. Calls LLM, validates, returns a draft `WorkflowDefinition`. |
| `/api/workflows/draft/step` | POST | Body: `{ workflow, stepId, instruction }`. LLM-edits a single step or its subtree. Returns the updated workflow. |

Both endpoints are user-scoped (require auth), rate-limited, and call Anthropic server-side with the user's configured LLM key (existing pattern from custom LLM provider work).

No schema changes. `triggers`, `workflows`, `workflow_executions`, `workflow_execution_steps` all unchanged.

## Implementation phases

Order chosen to deliver visible value early and de-risk the diagram component before the LLM-dependent flows.

1. **Phase 1 — Diagram component.** Build `<WorkflowDiagram>` with React Flow + dagre. All three modes. Render existing seeded workflows (synthetic or via API) for testing. No new routes yet.
2. **Phase 2 — Schedules & Hooks page.** Rename route, redesign cards, add `cronstrue` humanization, extract `<TriggerCard>`. Disabled-in-place. Old route redirects.
3. **Phase 3 — Real-time step events.** Runner emits events. SessionAgentDO writes-through to D1 + EventBus. Client subscription mechanism wired up (no UI consumer yet).
4. **Phase 4 — Execution details page.** Wire diagram + step events together. Cancel / approve / deny actions. Skipped-branch styling. Step trace + variables panel.
5. **Phase 5 — Workflow detail page.** Strip down the 2151-line page to the composition described above. Move editing into Phase 6 flow.
6. **Phase 6 — Create flow.** `/api/workflows/draft` endpoint + LLM integration. Create page with empty state, refine modes, trigger attachment, save.

Each phase ends with the UI usable (even if partial) and reviewable.

## Out of scope

These are deliberate omissions, deferred to follow-up specs:

- **Per-step retry** — engine only supports full-workflow replay today. "Retry from step X" requires engine work.
- **Real-time progress for hibernation / suspended sessions** — events are scoped to live runner sessions.
- **Diagram editing in-place** — clicking a node opens the LLM-edit dialog; there's no drag-to-reorder or visual step insertion. The diagram is a *visualization* of LLM-authored JSON, not a Drawio-style canvas.
- **Workflow templates / gallery** — example prompts in the empty state, not a curated library.
- **`allowSelfModification` UI** — known gap from the workflows spec; not addressed here.
- **HMAC webhook signature verification** — separate concern, tracked in the workflows spec.

## Open questions

None as of this draft — the brainstorm resolved naming, layout, refine modes, JSON visibility, trigger attachment, diagram engine, and real-time strategy. Spec ready for review.
