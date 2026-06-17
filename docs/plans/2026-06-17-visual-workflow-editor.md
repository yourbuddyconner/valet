# Visual Workflow Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw workflow JSON editing surface with a React Flow canvas editor based on vendored AI Elements workflow components.

**Architecture:** Vendor the small Apache-2.0 AI Elements workflow subset into the client and adapt it to Valet UI primitives. Add conversion helpers between `dag/v1` definitions and React Flow nodes/edges, then use those helpers in a focused workflow editor component that saves drafts through the existing `/api/workflows/:id/draft` endpoint.

**Tech Stack:** React 19, Vite, TanStack Query/Router, `@xyflow/react`, existing Valet UI primitives.

---

### Task 1: Vendor Canvas Primitives

**Files:**
- Modify: `packages/client/package.json`
- Create: `packages/client/src/components/ai-elements/canvas.tsx`
- Create: `packages/client/src/components/ai-elements/node.tsx`
- Create: `packages/client/src/components/ai-elements/edge.tsx`
- Create: `packages/client/src/components/ai-elements/connection.tsx`
- Create: `packages/client/src/components/ai-elements/controls.tsx`
- Create: `packages/client/src/components/ai-elements/panel.tsx`
- Create: `packages/client/src/components/ai-elements/toolbar.tsx`

- [x] Add `@xyflow/react` dependency to the client.
- [x] Copy AI Elements workflow primitives and adapt imports to `@/components/ui/card` and `@/lib/cn`.
- [x] Preserve Apache-2.0 attribution comments in vendored files.

### Task 2: Add DAG/React Flow Conversion Helpers

**Files:**
- Create: `packages/client/src/components/workflows/workflow-editor-model.ts`
- Create: `packages/client/src/components/workflows/workflow-editor-model.test.ts`

- [x] Write tests for converting a `dag/v1` definition into React Flow nodes/edges with persisted positions.
- [x] Write tests for converting React Flow nodes/edges back into a `dag/v1` definition.
- [x] Implement helper functions for node labels, summaries, default node payloads, edge ids, and UI state.

### Task 3: Build Canvas Editor Component

**Files:**
- Create: `packages/client/src/components/workflows/visual-workflow-editor.tsx`
- Modify: `packages/client/src/routes/workflows/$workflowId.tsx`

- [x] Render a full-width canvas with Valet workflow node cards.
- [x] Add a top-left toolbar for adding supported node types.
- [x] Support drag, connect, edge delete, node delete, node click selection, and node config editing in a right-side panel.
- [x] Keep a raw JSON panel as an escape hatch.
- [x] Save drafts through the existing `onSave` handler.

### Task 4: Verify and Deploy

**Files:**
- Modify if needed: `docs/specs/workflows.md`

- [x] Run focused model tests.
- [x] Run client typecheck/build.
- [x] Deploy the dev environment from this branch.

### Task 5: Add Action Output Contracts

**Files:**
- Modify: `packages/sdk/src/integrations/index.ts`
- Modify: `packages/worker/src/routes/integrations.ts`
- Modify: `packages/worker/src/routes/integrations.test.ts`
- Modify: `packages/plugin-github/src/actions/actions.ts`
- Modify: `packages/client/src/api/action-catalog.ts`
- Modify: `packages/client/src/components/workflows/workflow-editor-model.ts`
- Modify: `packages/client/src/components/workflows/workflow-editor-model.test.ts`
- Modify: `packages/client/src/components/workflows/visual-workflow-editor.tsx`

- [x] Extend action definitions and the action catalog response with optional JSON Schema output contracts.
- [x] Add GitHub output contracts for issue and pull request list actions.
- [x] Derive typed array output sources from selected tool action schemas.
- [x] Add a For each source picker that writes the existing runtime expression format.
- [x] Show selected tool output contract metadata in the node editor.

### Task 6: Make Typed Dataflow Usable

**Files:**
- Modify: `packages/plugin-github/src/actions/actions.ts`
- Modify: `packages/worker/src/routes/integrations.test.ts`
- Modify: `packages/client/src/components/workflows/workflow-editor-model.ts`
- Modify: `packages/client/src/components/workflows/workflow-editor-model.test.ts`
- Modify: `packages/client/src/components/workflows/visual-workflow-editor.tsx`

- [x] Add GitHub output contracts for common list/search actions, including `github.list_workflows`.
- [x] Derive item fields for array outputs so foreach nodes can show the item shape.
- [x] Default `foreach.items` when a newly connected upstream tool has exactly one compatible array output.
- [x] Show tool input/output schemas as contract trees in the node editor.
- [x] Show available upstream inputs and foreach item fields in the node editor.
- [x] Surface dataflow warnings when a foreach node is connected to an upstream node without a typed array output.
- [x] Simplify the foreach editor around source, item fields, and typed body-node controls, with expressions and raw body JSON moved behind advanced sections.

### Task 7: Add Trigger Source Node

**Files:**
- Modify: `packages/shared/src/types/workflow-dag.ts`
- Modify: `packages/worker/src/lib/workflow-dag/schema.ts`
- Modify: `packages/worker/src/workflows/runtime.ts`
- Modify: `packages/worker/src/workflows/runtime.test.ts`
- Modify: `packages/client/src/components/workflows/workflow-editor-model.ts`
- Modify: `packages/client/src/components/workflows/workflow-editor-model.test.ts`
- Modify: `packages/client/src/components/workflows/visual-workflow-editor.tsx`
- Modify: `docs/specs/workflows.md`

- [x] Add a reserved `trigger` node type to the shared DAG contract and worker schema.
- [x] Execute `trigger` nodes as source nodes that return the runtime `WorkflowTriggerPayload`.
- [x] Normalize legacy editor definitions by adding a locked `trigger` node connected to root nodes.
- [x] Expose trigger data, metadata, type, timestamp, and declared workflow inputs as selectable dataflow sources.
- [x] Add a read-only trigger inspector in the visual editor.
