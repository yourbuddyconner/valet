# Workflow UI MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the workflow UI MVP — a shared React Flow diagram component used across redesigned Schedules & Hooks, workflow create flow, workflow detail page, and live execution details — backed by real-time per-step events from the runner.

**Architecture:** Client adds one `WorkflowDiagram` React Flow + dagre component reused in `edit | view | runtime` modes. Server adds two LLM-backed draft endpoints. Runner forwards each step event over the existing runner ↔ DO WebSocket; SessionAgentDO upserts to D1 and publishes `workflow.execution.step` events to EventBus, which the client subscribes to via the existing session WebSocket. No schema changes.

**Tech Stack:** React 19, Vite 6, TanStack Router/Query, `@xyflow/react` v12, `dagre`, `cronstrue`, Hono on Cloudflare Workers, `@anthropic-ai/sdk` (server), Bun runner.

**Reference spec:** `docs/specs/2026-05-15-workflow-ui-mvp-design.md`.

---

## Phase 1 — Shared Diagram Component

The foundational piece. Built first so subsequent phases compose it. Pure logic (layout function) is TDD'd; the visual component is verified in browser.

### Task 1.1: Install React Flow and dagre

**Files:**
- Modify: `packages/client/package.json`

- [ ] **Step 1: Add dependencies**

```bash
cd /Users/connerswann/code/valet/packages/client && pnpm add @xyflow/react dagre && pnpm add -D @types/dagre
```

- [ ] **Step 2: Verify install**

```bash
cd /Users/connerswann/code/valet/packages/client && pnpm typecheck
```

Expected: no `Cannot find module '@xyflow/react'` errors.

- [ ] **Step 3: Commit**

```bash
git add packages/client/package.json packages/client/pnpm-lock.yaml ../pnpm-lock.yaml
git commit -m "feat(client): add @xyflow/react and dagre for workflow diagrams"
```

---

### Task 1.2: Define diagram types

**Files:**
- Create: `packages/client/src/components/workflows/workflow-diagram/types.ts`

- [ ] **Step 1: Create the file**

```typescript
import type { WorkflowData, WorkflowStep } from '@/api/workflows';

export type DiagramMode = 'edit' | 'view' | 'runtime';

export type StepRuntimeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'waiting_approval';

export interface WorkflowDiagramProps {
  workflow: WorkflowData;
  mode: DiagramMode;
  /** mode="runtime" only — per-stepId status */
  runtimeStatus?: Record<string, StepRuntimeStatus>;
  /** mode="runtime" only — step currently executing (for highlight) */
  currentStepId?: string;
  /** mode="runtime" only — error string per stepId for tooltip */
  stepErrors?: Record<string, string>;
  /** mode="edit" — invoked when a node is clicked to open scoped edit */
  onNodeClick?: (stepId: string) => void;
}

/** Internal node data shared across all custom node types. */
export interface WorkflowNodeData {
  step: WorkflowStep;
  mode: DiagramMode;
  status?: StepRuntimeStatus;
  isCurrent?: boolean;
  error?: string;
  onNodeClick?: (stepId: string) => void;
}

/** Synthetic START / END / MERGE nodes — not real workflow steps. */
export interface SyntheticNodeData {
  kind: 'start' | 'end' | 'merge';
  label?: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/components/workflows/workflow-diagram/types.ts
git commit -m "feat(client): workflow diagram types"
```

---

### Task 1.3: Layout function — tests first

The layout function walks the workflow JSON tree and produces flat `{ nodes, edges }` arrays with positions computed via dagre.

**Files:**
- Create: `packages/client/src/components/workflows/workflow-diagram/layout.ts`
- Create: `packages/client/src/components/workflows/workflow-diagram/layout.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// layout.test.ts
import { describe, it, expect } from 'vitest';
import { layoutWorkflow } from './layout';
import type { WorkflowData } from '@/api/workflows';

const linear: WorkflowData = {
  id: 'wf',
  name: 'Linear',
  steps: [
    { id: 'a', name: 'A', type: 'bash', command: 'echo a' },
    { id: 'b', name: 'B', type: 'bash', command: 'echo b' },
  ],
};

const branched: WorkflowData = {
  id: 'wf',
  name: 'Branched',
  steps: [
    {
      id: 'gate',
      name: 'Gate',
      type: 'conditional',
      condition: 'x > 0',
      then: [{ id: 't1', name: 'T1', type: 'bash', command: 'echo t' }],
      else: [{ id: 'e1', name: 'E1', type: 'bash', command: 'echo e' }],
    },
  ],
};

describe('layoutWorkflow', () => {
  it('produces start, step nodes, and end for a linear workflow', () => {
    const { nodes, edges } = layoutWorkflow(linear);
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('__start__');
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('__end__');
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: '__start__', target: 'a' }),
      expect.objectContaining({ source: 'a', target: 'b' }),
      expect.objectContaining({ source: 'b', target: '__end__' }),
    ]));
  });

  it('forks then/else under a conditional and merges back', () => {
    const { nodes, edges } = layoutWorkflow(branched);
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('gate');
    expect(ids).toContain('t1');
    expect(ids).toContain('e1');
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'gate', target: 't1', label: 'THEN' }),
      expect.objectContaining({ source: 'gate', target: 'e1', label: 'ELSE' }),
    ]));
  });

  it('assigns numeric x/y positions to every node', () => {
    const { nodes } = layoutWorkflow(linear);
    for (const node of nodes) {
      expect(typeof node.position.x).toBe('number');
      expect(typeof node.position.y).toBe('number');
    }
  });

  it('handles workflows with no steps without throwing', () => {
    const { nodes, edges } = layoutWorkflow({ id: 'empty', name: 'Empty', steps: [] });
    expect(nodes.length).toBeGreaterThanOrEqual(2); // start + end
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Verify tests fail (layout.ts does not exist)**

```bash
cd packages/client && pnpm vitest run src/components/workflows/workflow-diagram/layout.test.ts
```

Expected: FAIL with "Cannot find module './layout'".

- [ ] **Step 3: Implement `layout.ts`**

```typescript
import dagre from 'dagre';
import type { Node, Edge } from '@xyflow/react';
import type { WorkflowData, WorkflowStep } from '@/api/workflows';
import type { WorkflowNodeData, SyntheticNodeData, DiagramMode } from './types';

const NODE_WIDTH = 260;
const NODE_HEIGHT = 80;

type AnyNodeData = WorkflowNodeData | SyntheticNodeData;

interface LayoutOptions {
  mode?: DiagramMode;
  runtimeStatus?: Record<string, import('./types').StepRuntimeStatus>;
  currentStepId?: string;
  stepErrors?: Record<string, string>;
  onNodeClick?: (stepId: string) => void;
}

/**
 * Walk the workflow JSON tree, emitting flat nodes + edges with dagre-computed positions.
 * Synthetic node IDs use a `__name__` convention so they never collide with user step IDs.
 */
export function layoutWorkflow(
  workflow: WorkflowData,
  opts: LayoutOptions = {},
): { nodes: Node<AnyNodeData>[]; edges: Edge[] } {
  const nodes: Node<AnyNodeData>[] = [];
  const edges: Edge[] = [];

  const startId = '__start__';
  const endId = '__end__';

  nodes.push({
    id: startId,
    type: 'synthetic',
    position: { x: 0, y: 0 },
    data: { kind: 'start', label: 'START' },
  });
  nodes.push({
    id: endId,
    type: 'synthetic',
    position: { x: 0, y: 0 },
    data: { kind: 'end', label: 'END' },
  });

  // Walk the step tree.
  // Returns the list of "tail" node IDs that should connect to whatever follows.
  function walk(steps: WorkflowStep[], prevTails: string[]): string[] {
    let tails = prevTails;
    for (const step of steps) {
      const nodeData: WorkflowNodeData = {
        step,
        mode: opts.mode ?? 'view',
        status: opts.runtimeStatus?.[step.id],
        isCurrent: opts.currentStepId === step.id,
        error: opts.stepErrors?.[step.id],
        onNodeClick: opts.onNodeClick,
      };
      nodes.push({
        id: step.id,
        type: step.type,
        position: { x: 0, y: 0 },
        data: nodeData,
      });
      // Connect previous tails into this step.
      for (const t of tails) {
        edges.push({ id: `e_${t}_${step.id}`, source: t, target: step.id });
      }

      if (step.type === 'conditional') {
        const branchTails: string[] = [];
        if (step.then && step.then.length > 0) {
          const thenTails = walk(step.then, []);
          // Edge from conditional to first then child must carry the label.
          // Re-emit with label by mutating the most recent matching edge:
          const firstThen = step.then[0]?.id;
          if (firstThen) {
            const idx = edges.findIndex(e => e.source === step.id && e.target === firstThen);
            // walk() already added edges from "tails" (prevTails) into the first then-child,
            // but since we passed [] as prevTails, no edges from prior steps were added.
            // We need to add the conditional → firstThen edge ourselves with label.
            if (idx === -1) {
              edges.push({ id: `e_${step.id}_${firstThen}_then`, source: step.id, target: firstThen, label: 'THEN' });
            }
          }
          branchTails.push(...thenTails);
        }
        if (step.else && step.else.length > 0) {
          const elseTails = walk(step.else, []);
          const firstElse = step.else[0]?.id;
          if (firstElse) {
            const idx = edges.findIndex(e => e.source === step.id && e.target === firstElse);
            if (idx === -1) {
              edges.push({ id: `e_${step.id}_${firstElse}_else`, source: step.id, target: firstElse, label: 'ELSE' });
            }
          }
          branchTails.push(...elseTails);
        }
        // If a branch is empty, the conditional itself is a tail for that branch.
        if (!step.then || step.then.length === 0) branchTails.push(step.id);
        if (!step.else || step.else.length === 0) branchTails.push(step.id);
        tails = branchTails;
      } else if (step.type === 'parallel') {
        // Each substep gets a direct edge from this step; their tails all converge.
        const branchTails: string[] = [];
        for (const sub of step.steps ?? []) {
          const subTails = walk([sub], [step.id]);
          branchTails.push(...subTails);
        }
        tails = branchTails.length > 0 ? branchTails : [step.id];
      } else if (step.type === 'loop' || step.type === 'subworkflow') {
        // Render the body once; treat as linear-after for layout purposes.
        const innerTails = walk(step.steps ?? [], [step.id]);
        tails = innerTails.length > 0 ? innerTails : [step.id];
      } else {
        tails = [step.id];
      }
    }
    return tails;
  }

  const finalTails = walk(workflow.steps ?? [], [startId]);
  for (const t of finalTails) {
    edges.push({ id: `e_${t}_${endId}`, source: t, target: endId });
  }

  // Dagre layout.
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 50 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  for (const n of nodes) {
    const layout = g.node(n.id);
    n.position = {
      x: layout.x - NODE_WIDTH / 2,
      y: layout.y - NODE_HEIGHT / 2,
    };
  }

  return { nodes, edges };
}
```

- [ ] **Step 4: Run tests until they pass**

```bash
cd packages/client && pnpm vitest run src/components/workflows/workflow-diagram/layout.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/workflows/workflow-diagram/layout.ts packages/client/src/components/workflows/workflow-diagram/layout.test.ts
git commit -m "feat(client): workflow diagram layout function with dagre"
```

---

### Task 1.4: Custom node components

**Files:**
- Create: `packages/client/src/components/workflows/workflow-diagram/nodes/step-node.tsx`
- Create: `packages/client/src/components/workflows/workflow-diagram/nodes/synthetic-node.tsx`

The synthetic START/END node and one general-purpose `StepNode` cover every step type via the type badge variant. This keeps the node component count low.

- [ ] **Step 1: Write `synthetic-node.tsx`**

```typescript
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { SyntheticNodeData } from '../types';

export function SyntheticNode({ data }: NodeProps<SyntheticNodeData>) {
  const isEnd = data.kind === 'end';
  return (
    <div
      className={`px-4 py-1.5 rounded-full text-xs font-semibold tracking-wider text-white ${
        isEnd ? 'bg-emerald-700' : data.kind === 'merge' ? 'bg-neutral-400' : 'bg-neutral-900'
      }`}
    >
      <Handle type="target" position={Position.Top} />
      {data.label}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
```

- [ ] **Step 2: Write `step-node.tsx`**

```typescript
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { WorkflowNodeData, StepRuntimeStatus } from '../types';
import type { WorkflowStep } from '@/api/workflows';
import { cn } from '@/lib/cn';

const TYPE_LABEL: Record<WorkflowStep['type'], string> = {
  bash: 'BASH',
  tool: 'TOOL',
  agent: 'AGENT',
  agent_message: 'AGENT',
  conditional: 'CONDITIONAL',
  parallel: 'PARALLEL',
  loop: 'LOOP',
  subworkflow: 'SUBWORKFLOW',
  approval: 'APPROVAL',
};

const TYPE_BADGE_CLASSES: Record<WorkflowStep['type'], string> = {
  bash: 'bg-neutral-900 text-white',
  tool: 'bg-neutral-700 text-white',
  agent: 'bg-indigo-600 text-white',
  agent_message: 'bg-indigo-600 text-white',
  conditional: 'bg-amber-600 text-white',
  parallel: 'bg-fuchsia-600 text-white',
  loop: 'bg-teal-600 text-white',
  subworkflow: 'bg-slate-600 text-white',
  approval: 'bg-orange-600 text-white',
};

const STATUS_BORDER: Record<StepRuntimeStatus, string> = {
  pending: 'border-dashed border-neutral-300',
  running: 'border-2 border-blue-500 ring-4 ring-blue-200',
  completed: 'border-2 border-emerald-600',
  failed: 'border-2 border-red-600',
  skipped: 'border border-neutral-300 opacity-50',
  waiting_approval: 'border-2 border-orange-500 ring-4 ring-orange-200',
};

const STATUS_BADGE: Record<StepRuntimeStatus, { sym: string; cls: string }> = {
  pending: { sym: '○', cls: 'bg-neutral-300 text-neutral-700' },
  running: { sym: '●', cls: 'bg-blue-500 text-white' },
  completed: { sym: '✓', cls: 'bg-emerald-600 text-white' },
  failed: { sym: '✗', cls: 'bg-red-600 text-white' },
  skipped: { sym: '⊘', cls: 'bg-neutral-300 text-neutral-700' },
  waiting_approval: { sym: '⏸', cls: 'bg-orange-500 text-white' },
};

function summaryText(step: WorkflowStep): string {
  switch (step.type) {
    case 'bash':
      return step.command ?? '';
    case 'tool':
      return step.tool ? `tool: ${step.tool}` : '';
    case 'agent':
    case 'agent_message':
      return step.content ?? step.goal ?? step.prompt ?? '';
    case 'conditional':
      return typeof step.condition === 'string' ? step.condition : 'condition';
    case 'approval':
      return step.prompt ?? 'Approval required';
    case 'loop':
      return 'loop';
    case 'parallel':
      return 'parallel';
    case 'subworkflow':
      return 'subworkflow';
    default:
      return '';
  }
}

export function StepNode({ data }: NodeProps<WorkflowNodeData>) {
  const { step, mode, status, error } = data;
  const summary = summaryText(step);
  const clickable = mode === 'edit' && data.onNodeClick;

  return (
    <div
      onClick={clickable ? () => data.onNodeClick?.(step.id) : undefined}
      className={cn(
        'relative bg-white rounded-xl shadow-sm w-[260px] px-3 py-2.5',
        status ? STATUS_BORDER[status] : 'border border-neutral-300',
        clickable && 'cursor-pointer hover:shadow-md transition-shadow',
      )}
      title={error}
    >
      <Handle type="target" position={Position.Top} />
      {status && (
        <div
          className={cn(
            'absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center text-xs',
            STATUS_BADGE[status].cls,
          )}
        >
          {STATUS_BADGE[status].sym}
        </div>
      )}
      <div className="flex items-center gap-2 mb-0.5">
        <span
          className={cn(
            'text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded',
            TYPE_BADGE_CLASSES[step.type],
          )}
        >
          {TYPE_LABEL[step.type]}
        </span>
        <span className="text-sm font-semibold text-neutral-900 truncate">
          {step.name ?? step.id}
        </span>
      </div>
      {summary && (
        <div className="text-xs text-neutral-600 truncate font-mono">{summary}</div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/components/workflows/workflow-diagram/nodes/
git commit -m "feat(client): workflow diagram step and synthetic node components"
```

---

### Task 1.5: WorkflowDiagram component

**Files:**
- Create: `packages/client/src/components/workflows/workflow-diagram/index.tsx`

- [ ] **Step 1: Write the component**

```typescript
import { useMemo } from 'react';
import { ReactFlow, Background, Controls, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WorkflowDiagramProps } from './types';
import { layoutWorkflow } from './layout';
import { StepNode } from './nodes/step-node';
import { SyntheticNode } from './nodes/synthetic-node';

const NODE_TYPES: NodeTypes = {
  // Each step.type maps to StepNode. React Flow looks up `node.type` here.
  bash: StepNode,
  tool: StepNode,
  agent: StepNode,
  agent_message: StepNode,
  conditional: StepNode,
  parallel: StepNode,
  loop: StepNode,
  subworkflow: StepNode,
  approval: StepNode,
  synthetic: SyntheticNode,
};

export function WorkflowDiagram({
  workflow,
  mode,
  runtimeStatus,
  currentStepId,
  stepErrors,
  onNodeClick,
}: WorkflowDiagramProps) {
  const { nodes, edges } = useMemo(
    () => layoutWorkflow(workflow, { mode, runtimeStatus, currentStepId, stepErrors, onNodeClick }),
    [workflow, mode, runtimeStatus, currentStepId, stepErrors, onNodeClick],
  );

  return (
    <div className="w-full h-full min-h-[400px] bg-neutral-50 rounded-xl border border-neutral-200">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
```

- [ ] **Step 2: Add a barrel re-export for convenience**

Create `packages/client/src/components/workflows/workflow-diagram/index-export.ts` — no, simpler: this file *is* `index.tsx`. Done.

- [ ] **Step 3: Typecheck**

```bash
cd packages/client && pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/workflows/workflow-diagram/index.tsx
git commit -m "feat(client): WorkflowDiagram React Flow component with three modes"
```

---

### Task 1.6: Visual test — render an existing workflow

**Files:**
- Create: `packages/client/src/routes/_dev/workflow-diagram-preview.tsx`

A temporary dev route to verify the diagram renders. Removed in Task 6.x once execution / detail pages exist.

- [ ] **Step 1: Write the route**

```typescript
import { createFileRoute } from '@tanstack/react-router';
import { WorkflowDiagram } from '@/components/workflows/workflow-diagram';
import type { WorkflowData } from '@/api/workflows';

export const Route = createFileRoute('/_dev/workflow-diagram-preview')({
  component: Preview,
});

const sample: WorkflowData = {
  id: 'preview',
  name: 'CI Overnight Digest',
  steps: [
    { id: 'list_runs', name: 'List overnight runs', type: 'bash', command: 'gh run list --branch main --limit 20' },
    {
      id: 'gate',
      name: 'Any failures?',
      type: 'conditional',
      condition: 'outputs.list_runs.failed > 0',
      then: [
        { id: 'summarize', name: 'Summarize failures', type: 'agent_message', content: 'For each failed run, list name + link' },
        { id: 'post_fail', name: 'Post failures to Slack', type: 'agent_message', content: 'Channel: #engineering' },
      ],
      else: [
        { id: 'post_green', name: 'Post all-green', type: 'agent_message', content: '✅ Overnight CI: all green' },
      ],
    },
  ],
};

function Preview() {
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-4">View mode</h1>
      <div className="h-[600px]">
        <WorkflowDiagram workflow={sample} mode="view" />
      </div>

      <h1 className="text-xl font-semibold mt-8 mb-4">Runtime mode (mid-run)</h1>
      <div className="h-[600px]">
        <WorkflowDiagram
          workflow={sample}
          mode="runtime"
          currentStepId="summarize"
          runtimeStatus={{
            list_runs: 'completed',
            gate: 'completed',
            summarize: 'running',
            post_fail: 'pending',
            post_green: 'skipped',
          }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Start dev server**

```bash
cd packages/client && pnpm dev
```

- [ ] **Step 3: Open in browser**

Navigate to `http://localhost:5173/_dev/workflow-diagram-preview`. Verify:
- View mode shows the linear-then-branch workflow with START at top, END at bottom
- Conditional has THEN and ELSE edges labeled
- Runtime mode shows green checkmarks on completed steps, blue glow on `summarize`, dashed border on `post_fail`, gray strikethrough-feeling style on `post_green`

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/routes/_dev/workflow-diagram-preview.tsx
git commit -m "chore(client): dev preview route for WorkflowDiagram"
```

---

## Phase 2 — Schedules & Hooks Page

Rename `/automation/triggers` → `/automation/schedules-and-hooks`. Redesign cards with humanized cron + type badges.

### Task 2.1: Install cronstrue

**Files:**
- Modify: `packages/client/package.json`

- [ ] **Step 1: Install**

```bash
cd /Users/connerswann/code/valet/packages/client && pnpm add cronstrue
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/package.json packages/client/pnpm-lock.yaml ../pnpm-lock.yaml
git commit -m "feat(client): add cronstrue for humanizing cron expressions"
```

---

### Task 2.2: Cron humanize helper — tests first

**Files:**
- Create: `packages/client/src/components/workflows/cron-humanize.ts`
- Create: `packages/client/src/components/workflows/cron-humanize.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { humanizeCron } from './cron-humanize';

describe('humanizeCron', () => {
  it('humanizes a daily 9am schedule', () => {
    expect(humanizeCron('0 9 * * *')).toMatch(/9:00 AM/i);
  });

  it('returns null for invalid input', () => {
    expect(humanizeCron('not a cron')).toBeNull();
    expect(humanizeCron('')).toBeNull();
  });

  it('handles step expressions', () => {
    expect(humanizeCron('*/15 * * * *')).toMatch(/15 minutes/i);
  });

  it('handles multiple values', () => {
    expect(humanizeCron('0 9,18 * * *')).toMatch(/9:00 AM/i);
  });
});
```

- [ ] **Step 2: Verify tests fail**

```bash
cd packages/client && pnpm vitest run src/components/workflows/cron-humanize.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// cron-humanize.ts
import cronstrue from 'cronstrue';

export function humanizeCron(expression: string): string | null {
  if (!expression || expression.trim() === '') return null;
  try {
    return cronstrue.toString(expression, { verbose: false, use24HourTimeFormat: false });
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd packages/client && pnpm vitest run src/components/workflows/cron-humanize.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/workflows/cron-humanize.ts packages/client/src/components/workflows/cron-humanize.test.ts
git commit -m "feat(client): humanizeCron helper backed by cronstrue"
```

---

### Task 2.3: TriggerCard component

Extracted from `workflow-trigger-manager.tsx` so it can be reused.

**Files:**
- Create: `packages/client/src/components/workflows/trigger-card.tsx`

- [ ] **Step 1: Write the component**

```typescript
import { Link } from '@tanstack/react-router';
import { formatDistanceToNow } from 'date-fns';
import type { Trigger } from '@/api/triggers';
import { humanizeCron } from './cron-humanize';
import { cn } from '@/lib/cn';

const TYPE_META: Record<Trigger['type'], { label: string; classes: string; icon: string }> = {
  schedule: { label: 'SCHEDULE', classes: 'bg-indigo-100 text-indigo-800', icon: '◷' },
  webhook: { label: 'WEBHOOK', classes: 'bg-amber-100 text-amber-800', icon: '⚡' },
  manual: { label: 'MANUAL', classes: 'bg-neutral-100 text-neutral-700', icon: '▶' },
};

interface TriggerCardProps {
  trigger: Trigger;
  workflowName?: string;
  onEdit?: () => void;
  onToggleEnabled?: () => void;
  onDelete?: () => void;
}

export function TriggerCard({ trigger, workflowName, onEdit, onToggleEnabled, onDelete }: TriggerCardProps) {
  const meta = TYPE_META[trigger.type];
  const disabled = !trigger.enabled;

  const conditionLine = renderCondition(trigger);
  const targetLine = renderTarget(trigger, workflowName);
  const activityLine = renderActivity(trigger);

  return (
    <div
      className={cn(
        'flex gap-3.5 p-4 rounded-xl border bg-white',
        disabled ? 'opacity-50 border-neutral-200' : 'border-neutral-200',
      )}
    >
      <div className="text-2xl text-neutral-500 pt-0.5">{meta.icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={cn('text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded', meta.classes)}>
            {meta.label}
          </span>
          <span className="font-semibold text-neutral-900 truncate">{trigger.name}</span>
          <span
            className={cn(
              'text-[11px] px-2 py-0.5 rounded font-medium',
              trigger.enabled ? 'bg-emerald-50 text-emerald-800' : 'bg-neutral-100 text-neutral-500',
            )}
          >
            {trigger.enabled ? '● Enabled' : '○ Disabled'}
          </span>
        </div>
        {conditionLine}
        {targetLine}
        {activityLine && <div className="text-xs text-neutral-500 mt-1.5 flex gap-3.5">{activityLine}</div>}
      </div>
      <TriggerActionsMenu
        trigger={trigger}
        onEdit={onEdit}
        onToggleEnabled={onToggleEnabled}
        onDelete={onDelete}
      />
    </div>
  );
}

function renderCondition(trigger: Trigger) {
  if (trigger.type === 'schedule' && trigger.config.type === 'schedule') {
    const cron = trigger.config.cron;
    const tz = trigger.config.timezone;
    const human = humanizeCron(cron);
    return (
      <div className="text-sm text-neutral-700 mb-1">
        {human ?? cron}
        {tz && <span className="text-neutral-500"> ({tz})</span>}
        <span className="text-neutral-400 font-mono ml-2 cursor-default" title={`Raw: ${cron}`}>·</span>
      </div>
    );
  }
  if (trigger.type === 'webhook' && trigger.config.type === 'webhook') {
    return (
      <div className="text-sm text-neutral-700 mb-1 font-mono">
        {trigger.config.method ?? 'POST'} /webhooks/{trigger.config.path}
      </div>
    );
  }
  if (trigger.type === 'manual') {
    return <div className="text-sm text-neutral-700 mb-1">Run manually</div>;
  }
  return null;
}

function renderTarget(trigger: Trigger, workflowName?: string) {
  if (trigger.type === 'schedule' && trigger.config.type === 'schedule' && trigger.config.target === 'orchestrator') {
    return (
      <div className="text-sm text-indigo-700">
        → Sends prompt to your <strong>orchestrator</strong>
      </div>
    );
  }
  if (workflowName) {
    return (
      <div className="text-sm text-amber-800">
        → Runs workflow: <strong>{workflowName}</strong>
      </div>
    );
  }
  return null;
}

function renderActivity(trigger: Trigger) {
  if (!trigger.lastRunAt) return null;
  const last = formatDistanceToNow(new Date(trigger.lastRunAt), { addSuffix: true });
  return (
    <>
      <span>Last run: <strong>{last}</strong></span>
    </>
  );
}

function TriggerActionsMenu({ trigger, onEdit, onToggleEnabled, onDelete }: {
  trigger: Trigger;
  onEdit?: () => void;
  onToggleEnabled?: () => void;
  onDelete?: () => void;
}) {
  // Minimal version — replace with a DropdownMenu if the project has Radix DropdownMenu set up.
  return (
    <div className="flex gap-1">
      {onEdit && (
        <button onClick={onEdit} className="text-xs text-neutral-500 hover:text-neutral-900 px-1">Edit</button>
      )}
      {onToggleEnabled && (
        <button onClick={onToggleEnabled} className="text-xs text-neutral-500 hover:text-neutral-900 px-1">
          {trigger.enabled ? 'Disable' : 'Enable'}
        </button>
      )}
      {onDelete && (
        <button onClick={onDelete} className="text-xs text-red-600 hover:text-red-800 px-1">Delete</button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/components/workflows/trigger-card.tsx
git commit -m "feat(client): TriggerCard component with humanized cron and target line"
```

---

### Task 2.4: Add `triggerKeys.list` filtered queries + workflow-name lookup

We'll need to render each trigger's target workflow name. Reuse the existing `useWorkflows` query and resolve client-side.

**Files:**
- Modify: `packages/client/src/api/triggers.ts` (no API changes — just verify `Trigger.lastRunAt` is on the type)

- [ ] **Step 1: Verify the existing `Trigger` type has `lastRunAt`**

Read `packages/client/src/api/triggers.ts` lines 14–28. If `lastRunAt?: string | null` is missing, add it. If present, this task is a no-op — commit nothing.

- [ ] **Step 2 (if changes needed): Commit**

```bash
git add packages/client/src/api/triggers.ts
git commit -m "fix(client): ensure Trigger type includes lastRunAt"
```

---

### Task 2.5: Schedules & Hooks page route

**Files:**
- Create: `packages/client/src/routes/automation/schedules-and-hooks/index.tsx`
- Modify: `packages/client/src/routes/automation/triggers/index.tsx` (becomes a redirect)

- [ ] **Step 1: Write the new page**

```typescript
// schedules-and-hooks/index.tsx
import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useTriggers, useDeleteTrigger, useEnableTrigger, useDisableTrigger, type Trigger } from '@/api/triggers';
import { useWorkflows } from '@/api/workflows';
import { TriggerCard } from '@/components/workflows/trigger-card';

export const Route = createFileRoute('/automation/schedules-and-hooks/')({
  component: SchedulesAndHooksPage,
});

type Filter = 'all' | 'schedule' | 'webhook' | 'manual';

function SchedulesAndHooksPage() {
  const { data: triggersData, isLoading } = useTriggers();
  const { data: workflowsData } = useWorkflows();
  const deleteTrigger = useDeleteTrigger();
  const enableTrigger = useEnableTrigger();
  const disableTrigger = useDisableTrigger();
  const [filter, setFilter] = useState<Filter>('all');

  const triggers = triggersData?.triggers ?? [];
  const workflows = workflowsData?.workflows ?? [];
  const workflowName = (id: string | null) =>
    id ? workflows.find(w => w.id === id)?.name : undefined;

  const filtered = filter === 'all' ? triggers : triggers.filter(t => t.type === filter);

  const counts = {
    all: triggers.length,
    schedule: triggers.filter(t => t.type === 'schedule').length,
    webhook: triggers.filter(t => t.type === 'webhook').length,
    manual: triggers.filter(t => t.type === 'manual').length,
  };

  return (
    <div className="px-6 py-5">
      <div className="mb-1 text-xs text-neutral-500 tracking-wider">AUTOMATION</div>
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-2xl font-semibold text-neutral-900">Schedules &amp; Hooks</h1>
        <button className="px-4 py-1.5 rounded-lg bg-neutral-900 text-white text-sm font-medium hover:bg-neutral-800">
          + New trigger
        </button>
      </div>
      <p className="text-sm text-neutral-600 mb-5">
        Things that run on a schedule, fire from a webhook, or run on demand.
      </p>

      <FilterPills active={filter} counts={counts} onChange={setFilter} />

      {isLoading ? (
        <div className="text-sm text-neutral-500 mt-6">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-neutral-500 mt-6">No triggers yet.</div>
      ) : (
        <div className="flex flex-col gap-3 mt-4">
          {filtered.map((t: Trigger) => (
            <TriggerCard
              key={t.id}
              trigger={t}
              workflowName={workflowName(t.workflowId)}
              onToggleEnabled={() =>
                t.enabled
                  ? disableTrigger.mutate(t.id)
                  : enableTrigger.mutate(t.id)
              }
              onDelete={() => {
                if (confirm(`Delete trigger "${t.name}"?`)) {
                  deleteTrigger.mutate(t.id);
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterPills({
  active,
  counts,
  onChange,
}: {
  active: Filter;
  counts: Record<Filter, number>;
  onChange: (f: Filter) => void;
}) {
  const items: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'schedule', label: 'Schedules' },
    { id: 'webhook', label: 'Webhooks' },
    { id: 'manual', label: 'Manual' },
  ];
  return (
    <div className="flex gap-2">
      {items.map(({ id, label }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={
            'text-xs px-3 py-1 rounded-full cursor-pointer ' +
            (id === active
              ? 'bg-neutral-900 text-white'
              : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200')
          }
        >
          {label} · {counts[id]}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Convert the old triggers route to a redirect**

```typescript
// routes/automation/triggers/index.tsx — overwrite contents
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/automation/triggers/')({
  beforeLoad: () => {
    throw redirect({ to: '/automation/schedules-and-hooks' });
  },
});
```

- [ ] **Step 3: Update sidebar nav**

Find the relevant nav item in `packages/client/src/components/layout/sidebar.tsx` (or wherever sub-nav of /automation lives). If the sidebar entry is just "Automation" (a parent), no change. If there's a sub-menu link to `/automation/triggers`, change it to `/automation/schedules-and-hooks` with label "Schedules & Hooks".

- [ ] **Step 4: Build the client**

```bash
cd packages/client && pnpm build
```

Expected: clean. (Per CLAUDE.md, `pnpm build` enforces stricter checks than `pnpm typecheck`.)

- [ ] **Step 5: Visual test**

```bash
cd packages/client && pnpm dev
```

Open `http://localhost:5173/automation/triggers` — should redirect to `/automation/schedules-and-hooks`. The schedules and webhooks in your dev DB should render with humanized cron strings and proper target labels. Visit `/automation/schedules-and-hooks?filter=schedule` (or click the Schedules pill) to verify filtering.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/routes/automation/schedules-and-hooks/index.tsx packages/client/src/routes/automation/triggers/index.tsx packages/client/src/components/layout/sidebar.tsx
git commit -m "feat(client): Schedules & Hooks page replaces /automation/triggers"
```

---

## Phase 3 — Real-time Step Events

Runner → SessionAgentDO → D1 + EventBus → client subscription. No polling.

### Task 3.1: Define the runner-side event shape

**Files:**
- Create: `packages/runner/src/workflow-step-events.ts`
- Modify: `packages/runner/src/agent-client.ts` (add `sendWorkflowStepEvent`)

- [ ] **Step 1: Write the event-type module**

```typescript
// workflow-step-events.ts
export type WorkflowStepEventKind =
  | 'step.started'
  | 'step.completed'
  | 'step.failed'
  | 'step.skipped'
  | 'approval.required'
  | 'approval.approved'
  | 'approval.denied';

export interface WorkflowStepEvent {
  kind: WorkflowStepEventKind;
  stepId: string;
  attempt: number;
  timestamp: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export interface WorkflowStepEventMessage {
  type: 'workflow-step-event';
  executionId: string;
  event: WorkflowStepEvent;
}
```

- [ ] **Step 2: Add the sender in `agent-client.ts`**

In `packages/runner/src/agent-client.ts`, near the existing `sendOpenCodeConfigApplied` or similar `send*` helpers, add:

```typescript
import type { WorkflowStepEventMessage, WorkflowStepEvent } from './workflow-step-events';

// ...inside AgentClient class:
sendWorkflowStepEvent(executionId: string, event: WorkflowStepEvent): void {
  const msg: WorkflowStepEventMessage = {
    type: 'workflow-step-event',
    executionId,
    event,
  };
  this.sendMessage(msg as never); // existing send pattern
}
```

(Match the existing `sendMessage` / `socket.send(JSON.stringify(...))` shape — read the file at the existing `send*` method and copy.)

- [ ] **Step 3: Typecheck**

```bash
cd packages/runner && pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add packages/runner/src/workflow-step-events.ts packages/runner/src/agent-client.ts
git commit -m "feat(runner): workflow-step-event message + sender"
```

---

### Task 3.2: Wire the engine event sink to emit per-step events

**Files:**
- Modify: `packages/runner/src/workflow-engine.ts`
- Modify: `packages/runner/src/prompt.ts` (where the engine is invoked)

- [ ] **Step 1: Read the existing engine event sink**

Read `packages/runner/src/workflow-engine.ts` lines around the comment "The engine emits structured events to a sink" (search for `'execution.started'` or `step.started`). Identify the callback signature passed into `executeWorkflowRun()` / `executeWorkflowResume()`.

- [ ] **Step 2: In `prompt.ts`'s `handleWorkflowExecutionPrompt`, supply a sink that forwards to AgentClient**

Locate the call site of `executeWorkflowRun` / `executeWorkflowResume` in `packages/runner/src/prompt.ts`. Construct the event sink to call `agentClient.sendWorkflowStepEvent(executionId, …)` for each `step.*` and `approval.*` event:

```typescript
// In handleWorkflowExecutionPrompt (or similar) — add or augment the sink callback:
const stepEventForwarder = (event: { type: string; stepId?: string; attempt?: number; output?: unknown; error?: string; durationMs?: number; input?: unknown }) => {
  // Only forward step.* and approval.* events; ignore execution.* envelope events.
  const kind = event.type as
    | 'step.started' | 'step.completed' | 'step.failed' | 'step.skipped'
    | 'approval.required' | 'approval.approved' | 'approval.denied'
    | 'execution.started' | 'execution.finished' | 'execution.resumed' | 'execution.cancelled';
  if (!kind.startsWith('step.') && !kind.startsWith('approval.')) return;
  this.agentClient.sendWorkflowStepEvent(executionId, {
    kind: kind as never,
    stepId: event.stepId ?? '',
    attempt: event.attempt ?? 1,
    timestamp: new Date().toISOString(),
    input: event.input,
    output: event.output,
    error: event.error,
    durationMs: event.durationMs,
  });
};
// pass stepEventForwarder into the existing engine call (combine with any existing sink).
```

- [ ] **Step 3: Typecheck runner**

```bash
cd packages/runner && pnpm typecheck
```

- [ ] **Step 4: Run the engine tests to confirm no regression**

```bash
cd packages/runner && pnpm test
```

Expected: 22 vitest + 16 bun = 38 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/workflow-engine.ts packages/runner/src/prompt.ts
git commit -m "feat(runner): forward per-step engine events to SessionAgentDO"
```

---

### Task 3.3: Add `workflow.execution.step` to EventBus types

**Files:**
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Extend `EventBusEventType`**

```typescript
// In types/index.ts, replace the EventBusEventType union with:
export type EventBusEventType =
  | 'session.update'
  | 'session.started'
  | 'session.completed'
  | 'session.errored'
  | 'sandbox.status'
  | 'question.asked'
  | 'question.answered'
  | 'notification'
  | 'action.approval_required'
  | 'action.approved'
  | 'action.denied'
  | 'thread.created'
  | 'thread.updated'
  | 'workflow.execution.step'
  | 'workflow.execution.status';
```

- [ ] **Step 2: Typecheck everything**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean (or only pre-existing unrelated errors).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/index.ts
git commit -m "feat(shared): add workflow.execution.step EventBus event type"
```

---

### Task 3.4: SessionAgentDO handles `workflow-step-event`

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`
- Modify: `packages/worker/src/services/executions.ts` (add `upsertExecutionStepFromEvent`)

- [ ] **Step 1: Find the existing inbound message switch in `session-agent.ts`**

Read around lines 3300–3400 — the `case 'workflow-list'`, `case 'workflow-run'` handlers — to identify the inbound runner message dispatch shape. The new `workflow-step-event` handler lands in the same switch.

- [ ] **Step 2: Add the handler**

```typescript
// In the runner-message handler switch in session-agent.ts:
case 'workflow-step-event': {
  const executionId = (msg as { executionId?: string }).executionId;
  const event = (msg as { event?: Record<string, unknown> }).event;
  if (!executionId || !event || typeof event !== 'object') break;
  try {
    await upsertExecutionStepFromEvent(this.env, executionId, event as never);
  } catch (err) {
    console.error('[SessionAgentDO] upsertExecutionStepFromEvent error', err);
  }
  // Broadcast to connected session clients.
  this.broadcastToClients({
    type: 'workflow.execution.step',
    executionId,
    event,
  });
  // Publish to EventBus for non-session-attached subscribers.
  this.notifyEventBus({
    type: 'workflow.execution.step',
    sessionId: this.sessionState.sessionId,
    userId: this.sessionState.userId,
    data: { executionId, event },
    timestamp: new Date().toISOString(),
  });
  break;
}
```

- [ ] **Step 3: Implement `upsertExecutionStepFromEvent` in services**

```typescript
// In packages/worker/src/services/executions.ts — add:
import type { AppDb } from '@/lib/db';
import { workflowExecutionSteps, workflowExecutions } from '@/lib/schema';
import { eq, and } from 'drizzle-orm';

interface StepEvent {
  kind:
    | 'step.started' | 'step.completed' | 'step.failed' | 'step.skipped'
    | 'approval.required' | 'approval.approved' | 'approval.denied';
  stepId: string;
  attempt: number;
  timestamp: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export async function upsertExecutionStepFromEvent(
  env: { DB: D1Database; /* … existing env shape */ },
  executionId: string,
  event: StepEvent,
): Promise<void> {
  // Use the existing Drizzle instance pattern in this file.
  const db = /* derive db from env — match existing pattern in this file */;

  const status = mapKindToStatus(event.kind);
  const now = event.timestamp;

  // Upsert into workflow_execution_steps using INSERT ... ON CONFLICT pattern
  // mirroring the existing handleCompleteExecution flow.
  await db
    .insert(workflowExecutionSteps)
    .values({
      id: crypto.randomUUID(),
      executionId,
      stepId: event.stepId,
      attempt: event.attempt,
      status,
      inputJson: event.input !== undefined ? JSON.stringify(event.input) : null,
      outputJson: event.output !== undefined ? JSON.stringify(event.output) : null,
      error: event.error ?? null,
      startedAt: event.kind === 'step.started' ? now : null,
      completedAt:
        event.kind === 'step.completed' ||
        event.kind === 'step.failed' ||
        event.kind === 'step.skipped'
          ? now
          : null,
    })
    .onConflictDoUpdate({
      target: [workflowExecutionSteps.executionId, workflowExecutionSteps.stepId, workflowExecutionSteps.attempt],
      set: {
        status,
        // Preserve existing values when the new payload doesn't carry them.
        inputJson: event.input !== undefined ? JSON.stringify(event.input) : undefined,
        outputJson: event.output !== undefined ? JSON.stringify(event.output) : undefined,
        error: event.error ?? undefined,
        startedAt: event.kind === 'step.started' ? now : undefined,
        completedAt:
          event.kind === 'step.completed' ||
          event.kind === 'step.failed' ||
          event.kind === 'step.skipped'
            ? now
            : undefined,
      },
    });

  // If approval gate: update the execution row status so the UI can show "Waiting for approval".
  if (event.kind === 'approval.required') {
    await db.update(workflowExecutions)
      .set({ status: 'waiting_approval' })
      .where(eq(workflowExecutions.id, executionId));
  }
}

function mapKindToStatus(kind: StepEvent['kind']): string {
  switch (kind) {
    case 'step.started': return 'running';
    case 'step.completed': return 'completed';
    case 'step.failed': return 'failed';
    case 'step.skipped': return 'skipped';
    case 'approval.required': return 'waiting_approval';
    case 'approval.approved':
    case 'approval.denied': return 'completed';
  }
}
```

> Implementation note: match the existing Drizzle-usage pattern from this file. If it uses a helper like `getDb(env)`, reuse it; if it constructs `drizzle(env.DB)` inline, follow that. The conflict columns must match the `(executionId, stepId, attempt)` unique index documented in the workflows spec.

- [ ] **Step 4: Typecheck**

```bash
cd packages/worker && pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts packages/worker/src/services/executions.ts
git commit -m "feat(worker): SessionAgentDO handles workflow-step-event; service upserts step + publishes"
```

---

### Task 3.5: Client subscription hook

**Files:**
- Create: `packages/client/src/hooks/use-execution-step-events.ts`

- [ ] **Step 1: Write the hook**

```typescript
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/use-websocket';
import { executionKeys, type ExecutionStepTrace, type GetExecutionStepsResponse } from '@/api/executions';

interface StepEventMessage {
  type: 'workflow.execution.step';
  executionId: string;
  event: {
    kind: string;
    stepId: string;
    attempt: number;
    timestamp: string;
    input?: unknown;
    output?: unknown;
    error?: string;
  };
}

/**
 * Subscribes to the session's client WebSocket and patches step state into the
 * React Query cache for `executionKeys.steps(executionId)` as events arrive.
 *
 * Fallback: on initial mount, the existing useExecutionSteps query fetches once;
 * subsequent updates are push-only via this hook.
 */
export function useExecutionStepEvents(sessionId: string | null | undefined, executionId: string | null | undefined) {
  const qc = useQueryClient();
  const wsUrl = sessionId ? getSessionWsUrl(sessionId) : null;

  useWebSocket(wsUrl, {
    onMessage: (msg) => {
      if (!executionId) return;
      const data = msg as unknown as StepEventMessage;
      if (data.type !== 'workflow.execution.step') return;
      if (data.executionId !== executionId) return;

      qc.setQueryData<GetExecutionStepsResponse | undefined>(
        executionKeys.steps(executionId),
        (prev) => mergeStepEvent(prev, data.event),
      );
    },
  });
}

function getSessionWsUrl(sessionId: string): string {
  // Mirrors the existing pattern from create-session-dialog.tsx.
  return `/api/sessions/${sessionId}/ws?role=client`;
}

function mergeStepEvent(
  prev: GetExecutionStepsResponse | undefined,
  ev: StepEventMessage['event'],
): GetExecutionStepsResponse {
  const steps = prev?.steps ?? [];
  const idx = steps.findIndex(s => s.stepId === ev.stepId && s.attempt === ev.attempt);
  const updated: ExecutionStepTrace = {
    id: idx >= 0 ? steps[idx].id : crypto.randomUUID(),
    executionId: idx >= 0 ? steps[idx].executionId : '',
    stepId: ev.stepId,
    attempt: ev.attempt,
    status: mapKindToStatus(ev.kind),
    input: ev.input ?? (idx >= 0 ? steps[idx].input : null),
    output: ev.output ?? (idx >= 0 ? steps[idx].output : null),
    error: ev.error ?? (idx >= 0 ? steps[idx].error : null),
    startedAt: ev.kind === 'step.started' ? ev.timestamp : (idx >= 0 ? steps[idx].startedAt : null),
    completedAt:
      ev.kind === 'step.completed' || ev.kind === 'step.failed' || ev.kind === 'step.skipped'
        ? ev.timestamp
        : (idx >= 0 ? steps[idx].completedAt : null),
    createdAt: idx >= 0 ? steps[idx].createdAt : ev.timestamp,
    workflowStepIndex: idx >= 0 ? steps[idx].workflowStepIndex : null,
    sequence: idx >= 0 ? steps[idx].sequence : steps.length,
  };

  const next = [...steps];
  if (idx >= 0) next[idx] = updated;
  else next.push(updated);
  return { steps: next };
}

function mapKindToStatus(kind: string): string {
  switch (kind) {
    case 'step.started': return 'running';
    case 'step.completed': return 'completed';
    case 'step.failed': return 'failed';
    case 'step.skipped': return 'skipped';
    case 'approval.required': return 'waiting_approval';
    case 'approval.approved':
    case 'approval.denied': return 'completed';
    default: return 'pending';
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/hooks/use-execution-step-events.ts
git commit -m "feat(client): useExecutionStepEvents hook subscribes to live step updates"
```

---

## Phase 4 — Execution Details Page

Composes the diagram (runtime mode) with a step-trace panel, current-step card, variables, and actions.

### Task 4.1: Execution-details supporting components

**Files:**
- Create: `packages/client/src/components/workflows/execution-header.tsx`
- Create: `packages/client/src/components/workflows/execution-step-trace.tsx`
- Create: `packages/client/src/components/workflows/execution-step-panel.tsx`
- Create: `packages/client/src/components/workflows/execution-variables-panel.tsx`

- [ ] **Step 1: `execution-header.tsx`**

```typescript
import { Link } from '@tanstack/react-router';
import { formatDistanceToNow } from 'date-fns';
import type { Execution } from '@/api/executions';
import { cn } from '@/lib/cn';

const STATUS_CLASSES: Record<Execution['status'], string> = {
  pending: 'bg-neutral-100 text-neutral-700',
  running: 'bg-blue-100 text-blue-800',
  waiting_approval: 'bg-orange-100 text-orange-800',
  completed: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-neutral-200 text-neutral-700',
};

interface Props {
  execution: Execution;
  onCancel?: () => void;
  onApprove?: () => void;
  onDeny?: () => void;
  onToggleJson?: () => void;
}

export function ExecutionHeader({ execution, onCancel, onApprove, onDeny, onToggleJson }: Props) {
  const elapsed = execution.completedAt
    ? formatDistanceToNow(new Date(execution.completedAt), { addSuffix: false })
    : formatDistanceToNow(new Date(execution.startedAt), { addSuffix: false });

  return (
    <div className="px-6 py-4 bg-white border-b border-neutral-200">
      <div className="text-xs text-neutral-500 tracking-wider mb-1">AUTOMATION / EXECUTIONS</div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold text-neutral-900">{execution.workflowName ?? 'Workflow'}</h1>
            <span className={cn('text-[11px] px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider', STATUS_CLASSES[execution.status])}>
              {execution.status === 'running' ? `● Running · ${elapsed}` : execution.status}
            </span>
          </div>
          <div className="text-sm text-neutral-600 mt-1.5">
            Triggered by <strong>{execution.triggerType}</strong> · started {formatDistanceToNow(new Date(execution.startedAt), { addSuffix: true })} ·
            <code className="bg-neutral-100 px-1.5 py-0.5 rounded text-xs ml-1">{execution.id.slice(0, 8)}</code>
            {execution.sessionId && (
              <>
                {' · '}
                <Link to="/sessions/$sessionId" params={{ sessionId: execution.sessionId }} className="text-indigo-600 hover:underline">
                  view session ↗
                </Link>
              </>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {onToggleJson && <SmallButton onClick={onToggleJson}>{`{ } JSON`}</SmallButton>}
          {execution.status === 'waiting_approval' && (
            <>
              {onApprove && <SmallButton variant="success" onClick={onApprove}>✓ Approve</SmallButton>}
              {onDeny && <SmallButton variant="danger" onClick={onDeny}>Deny</SmallButton>}
            </>
          )}
          {(execution.status === 'running' || execution.status === 'pending') && onCancel && (
            <SmallButton variant="danger" onClick={onCancel}>✕ Cancel</SmallButton>
          )}
        </div>
      </div>
    </div>
  );
}

function SmallButton({ variant, ...rest }: { variant?: 'danger' | 'success' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const v =
    variant === 'danger'
      ? 'bg-red-50 text-red-800 border-red-200 hover:bg-red-100'
      : variant === 'success'
        ? 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
        : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-50';
  return <button {...rest} className={cn('text-sm px-3 py-1.5 rounded-md border font-medium', v)} />;
}
```

- [ ] **Step 2: `execution-step-trace.tsx`**

```typescript
import { useEffect, useRef } from 'react';
import type { ExecutionStepTrace } from '@/api/executions';

interface Props {
  steps: ExecutionStepTrace[];
  startedAt: string;
}

export function ExecutionStepTracePanel({ steps, startedAt }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight });
  }, [steps]);

  const start = new Date(startedAt).getTime();
  const sorted = [...steps].sort((a, b) => (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt));

  return (
    <div
      ref={containerRef}
      className="font-mono text-xs leading-relaxed text-neutral-700 bg-neutral-50 border border-neutral-200 rounded-lg p-2.5 max-h-72 overflow-y-auto"
    >
      <div className="text-emerald-700">[{fmtElapsed(0)}] ▶ START</div>
      {sorted.map((s) => (
        <StepTraceLines key={s.id} step={s} startMs={start} />
      ))}
    </div>
  );
}

function StepTraceLines({ step, startMs }: { step: ExecutionStepTrace; startMs: number }) {
  const lines: { text: string; cls: string }[] = [];
  if (step.startedAt) {
    lines.push({
      text: `[${fmtElapsed(new Date(step.startedAt).getTime() - startMs)}] ${(step.input as { type?: string })?.type?.toUpperCase() ?? 'STEP'} · ${step.stepId}`,
      cls: 'text-neutral-700',
    });
  }
  if (step.completedAt) {
    const sym = step.status === 'completed' ? '✓' : step.status === 'failed' ? '✗' : '⊘';
    const cls = step.status === 'completed' ? 'text-emerald-700' : step.status === 'failed' ? 'text-red-700' : 'text-neutral-500';
    lines.push({
      text: `[${fmtElapsed(new Date(step.completedAt).getTime() - startMs)}] ${sym} ${step.stepId} ${step.status}`,
      cls,
    });
  }
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} className={l.cls}>{l.text}</div>
      ))}
    </>
  );
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const millis = String(ms % 1000).padStart(3, '0');
  return `${mm}:${ss}.${millis}`;
}
```

- [ ] **Step 3: `execution-step-panel.tsx` (current step preview)**

```typescript
import type { WorkflowStep } from '@/api/workflows';

interface Props {
  step?: WorkflowStep;
}

export function ExecutionStepPanel({ step }: Props) {
  if (!step) {
    return <div className="text-sm text-neutral-500">No active step.</div>;
  }
  return (
    <div className="border border-neutral-200 rounded-lg p-3 bg-neutral-50">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-bold tracking-wider bg-neutral-900 text-white px-1.5 py-0.5 rounded">
          {step.type.toUpperCase()}
        </span>
        <span className="text-sm font-semibold">{step.name ?? step.id}</span>
      </div>
      <div className="text-xs text-neutral-600">
        {step.command && <>Command: <code>{step.command}</code></>}
        {step.content && <>Prompt: "{step.content}"</>}
        {step.tool && <>Tool: <code>{step.tool}</code></>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `execution-variables-panel.tsx`**

```typescript
interface Props {
  outputs?: Record<string, unknown> | null;
}

export function ExecutionVariablesPanel({ outputs }: Props) {
  if (!outputs || Object.keys(outputs).length === 0) {
    return <div className="text-xs text-neutral-500">No variables yet.</div>;
  }
  return (
    <div className="font-mono text-xs bg-neutral-50 border border-neutral-200 rounded-lg p-2.5">
      {Object.entries(outputs).map(([k, v]) => (
        <div key={k} className="truncate">
          <span className="text-neutral-500">{k}:</span> {summarize(v)}
        </div>
      ))}
    </div>
  );
}

function summarize(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  } catch {
    return String(v);
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/workflows/execution-header.tsx packages/client/src/components/workflows/execution-step-trace.tsx packages/client/src/components/workflows/execution-step-panel.tsx packages/client/src/components/workflows/execution-variables-panel.tsx
git commit -m "feat(client): execution detail supporting components"
```

---

### Task 4.2: Execution details route

**Files:**
- Create: `packages/client/src/routes/automation/executions/$executionId.tsx`

- [ ] **Step 1: Write the route**

```typescript
import { createFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useExecution, useExecutionSteps, useApproveExecution, useCancelExecution } from '@/api/executions';
import { useWorkflow } from '@/api/workflows';
import { WorkflowDiagram } from '@/components/workflows/workflow-diagram';
import type { StepRuntimeStatus } from '@/components/workflows/workflow-diagram/types';
import { ExecutionHeader } from '@/components/workflows/execution-header';
import { ExecutionStepTracePanel } from '@/components/workflows/execution-step-trace';
import { ExecutionStepPanel } from '@/components/workflows/execution-step-panel';
import { ExecutionVariablesPanel } from '@/components/workflows/execution-variables-panel';
import { useExecutionStepEvents } from '@/hooks/use-execution-step-events';
import type { WorkflowStep } from '@/api/workflows';

export const Route = createFileRoute('/automation/executions/$executionId')({
  component: ExecutionDetailPage,
});

function ExecutionDetailPage() {
  const { executionId } = Route.useParams();
  const { data: execData, isLoading } = useExecution(executionId);
  const { data: stepsData } = useExecutionSteps(executionId);
  const execution = execData?.execution;
  const { data: workflowData } = useWorkflow(execution?.workflowId ?? '');
  const workflow = workflowData?.workflow?.data;

  const approve = useApproveExecution();
  const cancel = useCancelExecution();

  // Subscribe to live step events.
  useExecutionStepEvents(execution?.sessionId ?? null, executionId);

  // Build runtime status map.
  const { runtimeStatus, currentStepId, stepErrors } = useMemo(() => {
    const map: Record<string, StepRuntimeStatus> = {};
    const errors: Record<string, string> = {};
    let current: string | undefined;
    for (const s of stepsData?.steps ?? []) {
      const st = s.status as StepRuntimeStatus;
      map[s.stepId] = st;
      if (st === 'running') current = s.stepId;
      if (s.error) errors[s.stepId] = s.error;
    }
    return { runtimeStatus: map, currentStepId: current, stepErrors: errors };
  }, [stepsData]);

  const currentStep = useMemo(() => {
    if (!currentStepId || !workflow) return undefined;
    return findStep(workflow.steps, currentStepId);
  }, [currentStepId, workflow]);

  if (isLoading || !execution) {
    return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <ExecutionHeader
        execution={execution}
        onCancel={() => cancel.mutate({ executionId, body: { reason: 'Cancelled by user' } })}
        onApprove={execution.resumeToken ? () => approve.mutate({ executionId, body: { approve: true, resumeToken: execution.resumeToken! } }) : undefined}
        onDeny={execution.resumeToken ? () => approve.mutate({ executionId, body: { approve: false, resumeToken: execution.resumeToken! } }) : undefined}
      />
      <div className="grid grid-cols-[1.5fr_1fr] gap-0 flex-1 min-h-0">
        <div className="p-6 bg-neutral-50 border-r border-neutral-200">
          <div className="text-[11px] tracking-wider text-neutral-500 mb-2">PROGRESS</div>
          <div className="h-[480px]">
            {workflow ? (
              <WorkflowDiagram
                workflow={workflow}
                mode="runtime"
                runtimeStatus={runtimeStatus}
                currentStepId={currentStepId}
                stepErrors={stepErrors}
              />
            ) : (
              <div className="text-sm text-neutral-500">Loading workflow…</div>
            )}
          </div>
        </div>
        <div className="p-6 bg-white space-y-6 overflow-y-auto">
          <div>
            <div className="text-[11px] tracking-wider text-neutral-500 mb-2">CURRENT STEP</div>
            <ExecutionStepPanel step={currentStep} />
          </div>
          <div>
            <div className="text-[11px] tracking-wider text-neutral-500 mb-2">STEP TRACE</div>
            <ExecutionStepTracePanel steps={stepsData?.steps ?? []} startedAt={execution.startedAt} />
          </div>
          <div>
            <div className="text-[11px] tracking-wider text-neutral-500 mb-2">VARIABLES</div>
            <ExecutionVariablesPanel outputs={execution.outputs} />
          </div>
        </div>
      </div>
    </div>
  );
}

function findStep(steps: WorkflowStep[], id: string): WorkflowStep | undefined {
  for (const s of steps) {
    if (s.id === id) return s;
    const nested = s.then ?? s.else ?? s.steps ?? [];
    const inner = findStep(nested, id);
    if (inner) return inner;
  }
  return undefined;
}
```

- [ ] **Step 2: Build to confirm**

```bash
cd packages/client && pnpm build
```

- [ ] **Step 3: Visual test against dev**

```bash
cd packages/client && VITE_API_URL=https://valet.conner-7e8.workers.dev/api pnpm dev
```

Open `http://localhost:5173/automation/executions/<some-real-execution-id>` (use the one you already have from earlier smoke tests, or trigger a new manual run). Verify the diagram renders with completed-state styling.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/routes/automation/executions/\$executionId.tsx
git commit -m "feat(client): execution details page with live diagram and step trace"
```

---

### Task 4.3: End-to-end real-time smoke test

- [ ] **Step 1: Deploy worker + runner-bearing image**

```bash
cd /Users/connerswann/code/valet && ENVIRONMENT=dev make deploy
```

- [ ] **Step 2: Trigger a workflow run against dev**

```bash
WORKER_URL=https://valet.conner-7e8.workers.dev API_TOKEN=<token> make test-workflow
```

- [ ] **Step 3: Open the execution page mid-run**

Take the returned `executionId`, navigate to `http://localhost:5173/automation/executions/<id>`. Watch the diagram transition START → step → END live, without polling.

- [ ] **Step 4: If updates don't arrive**

Check (in order):
- Runner logs (modal logs) for `workflow-step-event` send lines.
- SessionAgentDO logs for `[SessionAgentDO] workflow-step-event` handling.
- Worker logs for `upsertExecutionStepFromEvent` errors.
- Browser DevTools → WS frames on the session websocket.

- [ ] **Step 5: Cleanup test artifacts**

```bash
curl -X DELETE https://valet.conner-7e8.workers.dev/api/workflows/<test-workflow-id> -H "Authorization: Bearer <token>"
```

---

## Phase 5 — Workflow Detail Page Strip-Down

The current `$workflowId.tsx` is 2151 lines and conflates view + multiple edit dialogs. Strip to view + entry point.

### Task 5.1: Workflow detail page composition

**Files:**
- Modify: `packages/client/src/routes/automation/workflows/$workflowId.tsx`
- Create: `packages/client/src/components/workflows/workflow-detail-header.tsx`
- Create: `packages/client/src/components/workflows/recent-executions-section.tsx`

- [ ] **Step 1: Read the existing page to identify what to preserve**

```bash
wc -l /Users/connerswann/code/valet/packages/client/src/routes/automation/workflows/\$workflowId.tsx
```

Skim through; note useful logic (e.g. delete confirmation, useRunWorkflow integration). Keep that logic; remove the inline step-editor UI (it moves to Phase 6's create flow).

- [ ] **Step 2: Write `workflow-detail-header.tsx`**

```typescript
import type { Workflow } from '@/api/workflows';
import { cn } from '@/lib/cn';

interface Props {
  workflow: Workflow;
  onEdit?: () => void;
  onRun?: () => void;
  onToggleEnabled?: () => void;
  onDelete?: () => void;
}

export function WorkflowDetailHeader({ workflow, onEdit, onRun, onToggleEnabled, onDelete }: Props) {
  return (
    <div className="px-6 py-4 bg-white border-b border-neutral-200">
      <div className="text-xs text-neutral-500 tracking-wider mb-1">AUTOMATION / WORKFLOWS</div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-neutral-900">{workflow.name}</h1>
            <span className={cn('text-[11px] px-2 py-0.5 rounded-full font-medium', workflow.enabled ? 'bg-emerald-50 text-emerald-800' : 'bg-neutral-100 text-neutral-500')}>
              {workflow.enabled ? '● Enabled' : '○ Disabled'}
            </span>
          </div>
          {workflow.description && (
            <div className="text-sm text-neutral-600 mt-1.5">{workflow.description}</div>
          )}
          <div className="text-xs text-neutral-500 mt-1.5">
            slug: <code className="bg-neutral-100 px-1 py-0.5 rounded">{workflow.slug ?? '—'}</code> · v{workflow.version} · updated {new Date(workflow.updatedAt).toLocaleString()}
          </div>
        </div>
        <div className="flex gap-2">
          {onRun && <Btn onClick={onRun}>▶ Run now</Btn>}
          {onEdit && <Btn onClick={onEdit}>✎ Edit</Btn>}
          {onToggleEnabled && <Btn onClick={onToggleEnabled}>{workflow.enabled ? 'Disable' : 'Enable'}</Btn>}
          {onDelete && <Btn variant="danger" onClick={onDelete}>Delete</Btn>}
        </div>
      </div>
    </div>
  );
}

function Btn({ variant, ...rest }: { variant?: 'danger' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const v = variant === 'danger'
    ? 'bg-red-50 text-red-800 border-red-200 hover:bg-red-100'
    : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-50';
  return <button {...rest} className={cn('text-sm px-3 py-1.5 rounded-md border font-medium', v)} />;
}
```

- [ ] **Step 3: Write `recent-executions-section.tsx`**

```typescript
import { Link } from '@tanstack/react-router';
import { formatDistanceToNow } from 'date-fns';
import { useWorkflowExecutions } from '@/api/executions';

const STATUS_CLASSES: Record<string, string> = {
  pending: 'bg-neutral-100 text-neutral-700',
  running: 'bg-blue-100 text-blue-800',
  waiting_approval: 'bg-orange-100 text-orange-800',
  completed: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-neutral-200 text-neutral-700',
};

interface Props {
  workflowId: string;
  limit?: number;
}

export function RecentExecutionsSection({ workflowId, limit = 10 }: Props) {
  const { data } = useWorkflowExecutions(workflowId);
  const rows = (data?.executions ?? []).slice(0, limit);
  if (rows.length === 0) {
    return <div className="text-sm text-neutral-500">No runs yet.</div>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(e => {
        const ago = formatDistanceToNow(new Date(e.startedAt), { addSuffix: true });
        const duration = e.completedAt
          ? `${((new Date(e.completedAt).getTime() - new Date(e.startedAt).getTime()) / 1000).toFixed(1)}s`
          : 'running';
        return (
          <Link
            key={e.id}
            to="/automation/executions/$executionId"
            params={{ executionId: e.id }}
            className="flex items-center gap-3 px-3 py-2 rounded-lg border border-neutral-200 hover:bg-neutral-50"
          >
            <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${STATUS_CLASSES[e.status] ?? 'bg-neutral-100'}`}>
              {e.status}
            </span>
            <span className="text-sm text-neutral-700">{e.triggerType}</span>
            <span className="text-xs text-neutral-500 ml-auto">{ago} · {duration}</span>
          </Link>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Rewrite `$workflowId.tsx` as composition**

```typescript
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useWorkflow, useDeleteWorkflow, useUpdateWorkflow, useRunWorkflow } from '@/api/workflows';
import { useTriggers, useDeleteTrigger, useEnableTrigger, useDisableTrigger } from '@/api/triggers';
import { WorkflowDiagram } from '@/components/workflows/workflow-diagram';
import { WorkflowDetailHeader } from '@/components/workflows/workflow-detail-header';
import { TriggerCard } from '@/components/workflows/trigger-card';
import { RecentExecutionsSection } from '@/components/workflows/recent-executions-section';

export const Route = createFileRoute('/automation/workflows/$workflowId')({
  component: WorkflowDetailPage,
});

function WorkflowDetailPage() {
  const { workflowId } = Route.useParams();
  const nav = useNavigate();
  const { data, isLoading } = useWorkflow(workflowId);
  const workflow = data?.workflow;
  const { data: triggersData } = useTriggers();
  const del = useDeleteWorkflow();
  const update = useUpdateWorkflow();
  const run = useRunWorkflow();
  const deleteTrigger = useDeleteTrigger();
  const enableTrigger = useEnableTrigger();
  const disableTrigger = useDisableTrigger();

  if (isLoading || !workflow) {
    return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  }

  const triggers = (triggersData?.triggers ?? []).filter(t => t.workflowId === workflow.id);

  return (
    <div className="flex flex-col h-full">
      <WorkflowDetailHeader
        workflow={workflow}
        onRun={() => run.mutate({ workflowId: workflow.id })}
        onEdit={() => nav({ to: '/automation/workflows/new', search: { editId: workflow.id } as never })}
        onToggleEnabled={() => update.mutate({ id: workflow.id, body: { enabled: !workflow.enabled } })}
        onDelete={() => {
          if (confirm(`Delete workflow "${workflow.name}"?`)) {
            del.mutate(workflow.id, { onSuccess: () => nav({ to: '/automation/workflows' }) });
          }
        }}
      />
      <div className="flex-1 overflow-y-auto p-6 space-y-8">
        <Section title="Definition">
          <div className="h-[480px]">
            <WorkflowDiagram workflow={workflow.data} mode="view" />
          </div>
        </Section>

        <Section title={`Triggers (${triggers.length})`}>
          {triggers.length === 0 ? (
            <div className="text-sm text-neutral-500">No triggers attached.</div>
          ) : (
            <div className="flex flex-col gap-3">
              {triggers.map(t => (
                <TriggerCard
                  key={t.id}
                  trigger={t}
                  workflowName={workflow.name}
                  onToggleEnabled={() => (t.enabled ? disableTrigger.mutate(t.id) : enableTrigger.mutate(t.id))}
                  onDelete={() => deleteTrigger.mutate(t.id)}
                />
              ))}
            </div>
          )}
        </Section>

        <Section title="Recent executions">
          <RecentExecutionsSection workflowId={workflow.id} />
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold text-neutral-900 mb-3">{title}</h2>
      {children}
    </section>
  );
}
```

- [ ] **Step 5: Build + visual test**

```bash
cd packages/client && pnpm build && pnpm dev
```

Open `/automation/workflows/<id>` for a real workflow. Verify: header renders, diagram renders, triggers section lists this workflow's triggers, recent executions section lists this workflow's executions.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/routes/automation/workflows/\$workflowId.tsx packages/client/src/components/workflows/workflow-detail-header.tsx packages/client/src/components/workflows/recent-executions-section.tsx
git commit -m "feat(client): strip workflow detail page to view + entry point composition"
```

---

### Task 5.2: Delete obsolete editing dialogs (carefully)

**Files:**
- Delete or keep: `packages/client/src/components/workflows/edit-workflow-dialog.tsx`, `edit-workflow-step-dialog.tsx`, `step-behavior-editors.tsx`

- [ ] **Step 1: Check if anything still imports the old dialogs**

```bash
grep -rn "edit-workflow-dialog\|edit-workflow-step-dialog\|step-behavior-editors" /Users/connerswann/code/valet/packages/client/src --include="*.tsx" --include="*.ts"
```

- [ ] **Step 2: If only the just-rewritten `$workflowId.tsx` referenced them (and references are now gone), delete the files**

```bash
git rm packages/client/src/components/workflows/edit-workflow-dialog.tsx
git rm packages/client/src/components/workflows/edit-workflow-step-dialog.tsx
git rm packages/client/src/components/workflows/step-behavior-editors.tsx
git rm packages/client/src/components/workflows/edit-workflow-dialog.d.ts
git rm packages/client/src/components/workflows/edit-workflow-dialog.d.ts.map
git rm packages/client/src/components/workflows/edit-workflow-step-dialog.d.ts
git rm packages/client/src/components/workflows/edit-workflow-step-dialog.d.ts.map
```

If any other route or component still imports them, leave them alone — they'll be addressed in Phase 6 or a follow-up.

- [ ] **Step 3: Build**

```bash
cd packages/client && pnpm build
```

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(client): remove obsolete workflow editing dialogs"
```

---

## Phase 6 — Create Flow

LLM-backed draft endpoint + create page with diagram + refine modes + trigger attachment.

### Task 6.1: Server-side dependency

**Files:**
- Modify: `packages/worker/package.json`

- [ ] **Step 1: Add SDK**

```bash
cd /Users/connerswann/code/valet/packages/worker && pnpm add @anthropic-ai/sdk
```

- [ ] **Step 2: Commit**

```bash
git add packages/worker/package.json packages/worker/pnpm-lock.yaml ../pnpm-lock.yaml
git commit -m "feat(worker): add @anthropic-ai/sdk for workflow draft generation"
```

---

### Task 6.2: Workflow draft service — TDD

**Files:**
- Create: `packages/worker/src/services/workflow-draft.ts`
- Create: `packages/worker/src/services/workflow-draft.test.ts`

- [ ] **Step 1: Write failing tests for prompt-building and JSON extraction**

```typescript
// workflow-draft.test.ts
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, extractWorkflowFromResponse } from './workflow-draft';

describe('buildSystemPrompt', () => {
  it('mentions every step type by name', () => {
    const sys = buildSystemPrompt();
    for (const t of ['agent_message', 'tool', 'bash', 'conditional', 'parallel', 'loop', 'subworkflow', 'approval']) {
      expect(sys).toContain(t);
    }
  });
});

describe('extractWorkflowFromResponse', () => {
  it('parses bare JSON', () => {
    const wf = extractWorkflowFromResponse('{"id":"x","name":"X","steps":[]}');
    expect(wf).toEqual({ id: 'x', name: 'X', steps: [] });
  });

  it('parses fenced ```json blocks', () => {
    const wf = extractWorkflowFromResponse('Here is your workflow:\n```json\n{"id":"x","name":"X","steps":[]}\n```');
    expect(wf).toEqual({ id: 'x', name: 'X', steps: [] });
  });

  it('returns null when no JSON is present', () => {
    expect(extractWorkflowFromResponse('I cannot help with that.')).toBeNull();
  });
});
```

- [ ] **Step 2: Verify tests fail**

```bash
cd packages/worker && pnpm vitest run src/services/workflow-draft.test.ts
```

- [ ] **Step 3: Implement `workflow-draft.ts`**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type { WorkflowData } from '@/lib/workflow-definition';

const SYSTEM_PROMPT = `You are a workflow drafting assistant for Valet, an automation platform.

Output ONLY a JSON object matching this schema:
{
  "id": "kebab-case-id",
  "name": "Human Name",
  "description": "What this does",
  "steps": [WorkflowStep, ...]
}

A WorkflowStep is one of these types: agent_message, tool, bash, conditional, parallel, loop, subworkflow, approval.
Common fields: id (kebab-case), name (human), type, outputVariable (optional).

Type-specific fields:
- bash: { command: string }
- tool: { tool: string, arguments?: object }
- agent_message: { content: string }
- conditional: { condition: string, then: WorkflowStep[], else?: WorkflowStep[] }
- parallel: { steps: WorkflowStep[] }
- loop: { steps: WorkflowStep[] }
- subworkflow: { steps: WorkflowStep[] }
- approval: { prompt: string }

Respond with the JSON object only — no prose, no markdown fences.`;

export function buildSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

export function extractWorkflowFromResponse(text: string): WorkflowData | null {
  const trimmed = text.trim();
  // Bare JSON object.
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as WorkflowData;
    } catch {
      // Fall through to fence detection.
    }
  }
  // Fenced.
  const match = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (match) {
    try {
      return JSON.parse(match[1]) as WorkflowData;
    } catch {
      return null;
    }
  }
  return null;
}

export async function draftWorkflow(opts: {
  apiKey: string;
  userPrompt: string;
  baseDraft?: WorkflowData;
}): Promise<{ workflow: WorkflowData | null; rawResponse: string }> {
  const anthropic = new Anthropic({ apiKey: opts.apiKey });
  const userMessage = opts.baseDraft
    ? `Current draft:\n\`\`\`json\n${JSON.stringify(opts.baseDraft, null, 2)}\n\`\`\`\n\nRefinement: ${opts.userPrompt}\n\nReturn the updated workflow JSON.`
    : opts.userPrompt;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  return { workflow: extractWorkflowFromResponse(text), rawResponse: text };
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd packages/worker && pnpm vitest run src/services/workflow-draft.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/services/workflow-draft.ts packages/worker/src/services/workflow-draft.test.ts
git commit -m "feat(worker): workflow draft service backed by Anthropic SDK"
```

---

### Task 6.3: `/api/workflows/draft` endpoint

**Files:**
- Modify: `packages/worker/src/routes/workflows.ts`

- [ ] **Step 1: Find the user's Anthropic key resolution pattern**

Search for how other routes resolve the user's LLM key (custom provider work, or just `env.ANTHROPIC_API_KEY`):

```bash
grep -rn "ANTHROPIC_API_KEY\|anthropic\|getAnthropicClient\|getUserLlmKey" /Users/connerswann/code/valet/packages/worker/src --include="*.ts" | head -10
```

Reuse whatever convention exists. If none, fall back to `env.ANTHROPIC_API_KEY`.

- [ ] **Step 2: Add the route**

```typescript
// In workflows.ts — add near other routes:
import { draftWorkflow } from '@/services/workflow-draft';
import { validateWorkflowDefinition } from '@/lib/workflow-definition';

workflowsRouter.post('/draft', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized', code: 'UNAUTHORIZED' }, 401);

  const body = await c.req.json<{ prompt: string; baseDraft?: unknown }>().catch(() => null);
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return c.json({ error: 'prompt is required', code: 'VALIDATION' }, 400);
  }

  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) return c.json({ error: 'no ANTHROPIC_API_KEY configured', code: 'CONFIG' }, 500);

  const baseDraft = (body.baseDraft && typeof body.baseDraft === 'object') ? body.baseDraft as never : undefined;
  const maxAttempts = 3;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { workflow, rawResponse } = await draftWorkflow({ apiKey, userPrompt: body.prompt, baseDraft });
    if (!workflow) {
      lastError = 'LLM did not return valid JSON';
      continue;
    }
    const validation = validateWorkflowDefinition(workflow);
    if (validation.ok) {
      return c.json({ workflow, attempts: attempt });
    }
    lastError = validation.errors?.join('; ') ?? 'validation failed';
  }

  return c.json({ error: lastError ?? 'failed to draft workflow', code: 'DRAFT_FAILED' }, 502);
});
```

> The `validateWorkflowDefinition` import path is from `packages/worker/src/lib/workflow-definition.ts` — verify with `grep -n 'validateWorkflowDefinition' packages/worker/src/lib/workflow-definition.ts`. Match the actual exported name.

- [ ] **Step 3: Typecheck**

```bash
cd packages/worker && pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/routes/workflows.ts
git commit -m "feat(worker): /api/workflows/draft endpoint for LLM-drafted workflows"
```

---

### Task 6.4: `/api/workflows/draft/step` endpoint (scoped per-step refine)

- [ ] **Step 1: Add the route below the draft route**

```typescript
workflowsRouter.post('/draft/step', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized', code: 'UNAUTHORIZED' }, 401);

  const body = await c.req.json<{ workflow: unknown; stepId: string; instruction: string }>().catch(() => null);
  if (!body || !body.workflow || typeof body.stepId !== 'string' || typeof body.instruction !== 'string') {
    return c.json({ error: 'workflow, stepId, and instruction required', code: 'VALIDATION' }, 400);
  }

  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) return c.json({ error: 'no ANTHROPIC_API_KEY configured', code: 'CONFIG' }, 500);

  const userPrompt = `In the workflow below, edit ONLY the step with id "${body.stepId}" per this instruction: "${body.instruction}". Preserve every other step exactly. Return the full updated workflow JSON.`;

  const maxAttempts = 3;
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { workflow } = await draftWorkflow({ apiKey, userPrompt, baseDraft: body.workflow as never });
    if (!workflow) {
      lastError = 'LLM did not return valid JSON';
      continue;
    }
    const validation = validateWorkflowDefinition(workflow);
    if (validation.ok) return c.json({ workflow, attempts: attempt });
    lastError = validation.errors?.join('; ') ?? 'validation failed';
  }

  return c.json({ error: lastError ?? 'failed to draft step', code: 'DRAFT_FAILED' }, 502);
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/worker/src/routes/workflows.ts
git commit -m "feat(worker): /api/workflows/draft/step for scoped step refinement"
```

---

### Task 6.5: Client API hooks for draft

**Files:**
- Modify: `packages/client/src/api/workflows.ts`

- [ ] **Step 1: Add hooks**

```typescript
// Append to workflows.ts:
export function useDraftWorkflow() {
  return useMutation({
    mutationFn: async (vars: { prompt: string; baseDraft?: WorkflowData }) =>
      api<{ workflow: WorkflowData; attempts: number }>('/workflows/draft', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
  });
}

export function useDraftWorkflowStep() {
  return useMutation({
    mutationFn: async (vars: { workflow: WorkflowData; stepId: string; instruction: string }) =>
      api<{ workflow: WorkflowData; attempts: number }>('/workflows/draft/step', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/api/workflows.ts
git commit -m "feat(client): useDraftWorkflow and useDraftWorkflowStep hooks"
```

---

### Task 6.6: Workflow create page — empty state and draft state

**Files:**
- Create: `packages/client/src/routes/automation/workflows/new.tsx`

- [ ] **Step 1: Write the route**

```typescript
import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useDraftWorkflow, useDraftWorkflowStep, useSyncWorkflow, type WorkflowData } from '@/api/workflows';
import { useCreateTrigger } from '@/api/triggers';
import { WorkflowDiagram } from '@/components/workflows/workflow-diagram';
import { WorkflowDraftEditor } from '@/components/workflows/workflow-draft-editor';
import { WorkflowDraftTriggerForm } from '@/components/workflows/workflow-draft-trigger-form';
import { WorkflowDraftStepEditDialog } from '@/components/workflows/workflow-draft-step-edit-dialog';

export const Route = createFileRoute('/automation/workflows/new')({
  component: NewWorkflowPage,
});

function NewWorkflowPage() {
  const nav = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [draft, setDraft] = useState<WorkflowData | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<{ kind: 'schedule' | 'webhook' | 'manual'; config: Record<string, unknown> } | null>({ kind: 'manual', config: {} });

  const draftMut = useDraftWorkflow();
  const stepMut = useDraftWorkflowStep();
  const syncMut = useSyncWorkflow();
  const createTrigger = useCreateTrigger();

  const handleGenerate = (text: string) => {
    setPrompt(text);
    draftMut.mutate(
      { prompt: text, baseDraft: draft ?? undefined },
      { onSuccess: (data) => setDraft(data.workflow) },
    );
  };

  const handleStepEdit = async (stepId: string, instruction: string) => {
    if (!draft) return;
    const result = await stepMut.mutateAsync({ workflow: draft, stepId, instruction });
    setDraft(result.workflow);
    setEditingStepId(null);
  };

  const handleSave = async () => {
    if (!draft) return;
    const wf = await syncMut.mutateAsync({ body: {
      id: draft.id,
      name: draft.name,
      description: draft.description,
      data: draft,
      version: draft.version ?? '1.0.0',
    } });
    if (trigger && trigger.kind !== 'manual') {
      await createTrigger.mutateAsync({
        workflowId: draft.id,
        name: `${draft.name} ${trigger.kind}`,
        enabled: true,
        type: trigger.kind,
        config: trigger.config as never,
      });
    }
    nav({ to: '/automation/workflows/$workflowId', params: { workflowId: draft.id } });
  };

  return (
    <div className="flex flex-col h-full">
      <header className="px-6 py-4 bg-white border-b border-neutral-200">
        <div className="text-xs text-neutral-500 tracking-wider mb-1">AUTOMATION / WORKFLOWS</div>
        <h1 className="text-xl font-semibold">New workflow</h1>
        <p className="text-sm text-neutral-600 mt-1">
          Describe what you want it to do. The agent drafts a workflow; you can refine it before saving.
        </p>
      </header>

      {!draft ? (
        <EmptyState onSubmit={handleGenerate} loading={draftMut.isPending} />
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          <WorkflowDraftEditor
            prompt={prompt}
            onRegenerate={() => handleGenerate(prompt)}
            onEditPrompt={(p) => setPrompt(p)}
            workflow={draft}
            onJsonToggle={() => setShowJson((v) => !v)}
            jsonOpen={showJson}
            onNodeClick={(stepId) => setEditingStepId(stepId)}
            onRefine={handleGenerate}
            refining={draftMut.isPending}
          />
          <WorkflowDraftTriggerForm value={trigger} onChange={setTrigger} />
          <div className="px-6 py-3 bg-white border-t border-neutral-200 flex justify-end gap-2">
            <button onClick={() => nav({ to: '/automation/workflows' })} className="px-4 py-1.5 text-sm border border-neutral-300 rounded-md hover:bg-neutral-50">Discard</button>
            <button onClick={handleSave} disabled={syncMut.isPending} className="px-4 py-1.5 text-sm bg-emerald-700 text-white rounded-md font-medium hover:bg-emerald-800 disabled:opacity-50">
              {syncMut.isPending ? 'Saving…' : 'Save workflow'}
            </button>
          </div>
        </div>
      )}

      {editingStepId && draft && (
        <WorkflowDraftStepEditDialog
          workflow={draft}
          stepId={editingStepId}
          onSubmit={(instruction) => handleStepEdit(editingStepId, instruction)}
          onClose={() => setEditingStepId(null)}
          loading={stepMut.isPending}
        />
      )}
    </div>
  );
}

function EmptyState({ onSubmit, loading }: { onSubmit: (s: string) => void; loading: boolean }) {
  const [text, setText] = useState('');
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Every weekday at 9am, check my open PRs and send a summary to Slack…"
          className="w-full min-h-[120px] rounded-xl border border-neutral-300 px-4 py-3 text-sm"
        />
        <div className="flex justify-end mt-3">
          <button
            onClick={() => onSubmit(text)}
            disabled={loading || !text.trim()}
            className="px-5 py-2 bg-neutral-900 text-white rounded-lg text-sm font-medium hover:bg-neutral-800 disabled:opacity-50"
          >
            {loading ? 'Drafting…' : 'Draft workflow →'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit (file may not yet compile — supporting components in next tasks)**

```bash
git add packages/client/src/routes/automation/workflows/new.tsx
git commit -m "feat(client): /automation/workflows/new route skeleton"
```

---

### Task 6.7: WorkflowDraftEditor component

**Files:**
- Create: `packages/client/src/components/workflows/workflow-draft-editor.tsx`

- [ ] **Step 1: Write**

```typescript
import { useState } from 'react';
import type { WorkflowData } from '@/api/workflows';
import { WorkflowDiagram } from './workflow-diagram';

interface Props {
  prompt: string;
  workflow: WorkflowData;
  onRegenerate: () => void;
  onEditPrompt: (p: string) => void;
  onJsonToggle: () => void;
  jsonOpen: boolean;
  onNodeClick: (stepId: string) => void;
  onRefine: (text: string) => void;
  refining: boolean;
}

export function WorkflowDraftEditor({
  prompt, workflow, onRegenerate, onEditPrompt, onJsonToggle, jsonOpen, onNodeClick, onRefine, refining,
}: Props) {
  const [refineText, setRefineText] = useState('');
  const [editPrompt, setEditPrompt] = useState(false);
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-3 bg-white border-b border-neutral-200">
        <div className="text-[11px] text-neutral-500 tracking-wider mb-1">YOUR PROMPT</div>
        {editPrompt ? (
          <textarea
            defaultValue={prompt}
            onBlur={(e) => { onEditPrompt(e.target.value); setEditPrompt(false); }}
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            autoFocus
          />
        ) : (
          <div className="bg-indigo-50 border-l-4 border-indigo-500 px-3 py-2 rounded text-sm text-neutral-800">{prompt}</div>
        )}
        <div className="mt-2 flex gap-2">
          <button onClick={onRegenerate} disabled={refining} className="text-xs text-indigo-600 border border-indigo-600 px-3 py-1 rounded-md hover:bg-indigo-50 disabled:opacity-50">↻ Regenerate</button>
          <button onClick={() => setEditPrompt(true)} className="text-xs text-neutral-600 border border-neutral-300 px-3 py-1 rounded-md hover:bg-neutral-50">✎ Edit prompt</button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 p-6 bg-neutral-50">
          <div className="h-full">
            <WorkflowDiagram workflow={workflow} mode="edit" onNodeClick={onNodeClick} />
          </div>
        </div>
        {jsonOpen && (
          <aside className="w-96 bg-white border-l border-neutral-200 p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">Workflow JSON</h3>
              <button onClick={onJsonToggle} className="text-xs text-neutral-500">close</button>
            </div>
            <pre className="text-xs bg-neutral-50 border border-neutral-200 rounded p-3 overflow-x-auto">{JSON.stringify(workflow, null, 2)}</pre>
          </aside>
        )}
      </div>

      <div className="px-6 py-3 bg-white border-t border-neutral-200 flex gap-2">
        <input
          type="text"
          value={refineText}
          onChange={(e) => setRefineText(e.target.value)}
          placeholder="Refine — e.g. 'add a step that pings on-call if more than 3 failed'"
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && refineText.trim()) {
              onRefine(refineText.trim());
              setRefineText('');
            }
          }}
        />
        <button onClick={() => { if (refineText.trim()) { onRefine(refineText.trim()); setRefineText(''); } }} disabled={refining || !refineText.trim()} className="px-4 py-2 bg-neutral-900 text-white rounded-md text-sm font-medium disabled:opacity-50">Send</button>
        <button onClick={onJsonToggle} className="px-3 py-2 border border-neutral-300 rounded-md text-sm">{'{ } JSON'}</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/components/workflows/workflow-draft-editor.tsx
git commit -m "feat(client): WorkflowDraftEditor — chat-style refine with side panel JSON"
```

---

### Task 6.8: WorkflowDraftTriggerForm component

**Files:**
- Create: `packages/client/src/components/workflows/workflow-draft-trigger-form.tsx`

- [ ] **Step 1: Write**

```typescript
interface TriggerValue { kind: 'schedule' | 'webhook' | 'manual'; config: Record<string, unknown>; }

interface Props {
  value: TriggerValue | null;
  onChange: (v: TriggerValue | null) => void;
}

export function WorkflowDraftTriggerForm({ value, onChange }: Props) {
  const kind = value?.kind ?? 'manual';
  return (
    <div className="px-6 py-4 bg-white border-t border-neutral-200">
      <div className="text-sm font-semibold text-neutral-900 mb-2">How should this run?</div>
      <div className="flex gap-2 mb-3">
        {(['schedule', 'webhook', 'manual'] as const).map(k => (
          <button
            key={k}
            onClick={() => onChange({ kind: k, config: defaultConfig(k) })}
            className={
              'text-xs px-3 py-1 rounded-full border ' +
              (kind === k ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white text-neutral-700 border-neutral-300')
            }
          >{k}</button>
        ))}
      </div>
      {kind === 'schedule' && (
        <div className="grid grid-cols-2 gap-3 max-w-lg">
          <label className="text-xs">
            <span className="block mb-1 text-neutral-500">Cron</span>
            <input
              type="text"
              defaultValue={(value?.config.cron as string) ?? '0 9 * * *'}
              onChange={(e) => onChange({ kind: 'schedule', config: { ...value?.config, cron: e.target.value } })}
              className="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm font-mono"
            />
          </label>
          <label className="text-xs">
            <span className="block mb-1 text-neutral-500">Timezone</span>
            <input
              type="text"
              defaultValue={(value?.config.timezone as string) ?? 'America/Los_Angeles'}
              onChange={(e) => onChange({ kind: 'schedule', config: { ...value?.config, timezone: e.target.value } })}
              className="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm"
            />
          </label>
        </div>
      )}
      {kind === 'webhook' && (
        <div className="grid grid-cols-2 gap-3 max-w-lg">
          <label className="text-xs">
            <span className="block mb-1 text-neutral-500">Path</span>
            <input
              type="text"
              defaultValue={(value?.config.path as string) ?? ''}
              onChange={(e) => onChange({ kind: 'webhook', config: { ...value?.config, path: e.target.value } })}
              placeholder="my-workflow"
              className="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm font-mono"
            />
          </label>
          <label className="text-xs">
            <span className="block mb-1 text-neutral-500">Method</span>
            <select
              defaultValue={(value?.config.method as string) ?? 'POST'}
              onChange={(e) => onChange({ kind: 'webhook', config: { ...value?.config, method: e.target.value } })}
              className="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm"
            >
              <option>POST</option>
              <option>GET</option>
              <option>PUT</option>
            </select>
          </label>
        </div>
      )}
      {kind === 'manual' && (
        <div className="text-sm text-neutral-500">This workflow can only be run on demand from the UI or API.</div>
      )}
    </div>
  );
}

function defaultConfig(k: 'schedule' | 'webhook' | 'manual'): Record<string, unknown> {
  if (k === 'schedule') return { cron: '0 9 * * *', timezone: 'America/Los_Angeles', target: 'workflow' };
  if (k === 'webhook') return { path: '', method: 'POST' };
  return {};
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/components/workflows/workflow-draft-trigger-form.tsx
git commit -m "feat(client): WorkflowDraftTriggerForm for attaching schedule/webhook/manual"
```

---

### Task 6.9: WorkflowDraftStepEditDialog

**Files:**
- Create: `packages/client/src/components/workflows/workflow-draft-step-edit-dialog.tsx`

- [ ] **Step 1: Write**

```typescript
import { useState } from 'react';
import type { WorkflowData, WorkflowStep } from '@/api/workflows';

interface Props {
  workflow: WorkflowData;
  stepId: string;
  onSubmit: (instruction: string) => void;
  onClose: () => void;
  loading: boolean;
}

export function WorkflowDraftStepEditDialog({ workflow, stepId, onSubmit, onClose, loading }: Props) {
  const [text, setText] = useState('');
  const step = findStep(workflow.steps, stepId);
  if (!step) return null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl w-full max-w-lg p-5">
        <h2 className="text-base font-semibold mb-1">Edit step: {step.name ?? step.id}</h2>
        <pre className="text-xs bg-neutral-50 border border-neutral-200 rounded p-2 mt-2 mb-3 max-h-40 overflow-y-auto">{JSON.stringify(step, null, 2)}</pre>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='Change this step to… (e.g. "use bash instead of an agent message")'
          className="w-full min-h-[80px] rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border border-neutral-300 rounded-md">Cancel</button>
          <button onClick={() => onSubmit(text)} disabled={loading || !text.trim()} className="px-3 py-1.5 text-sm bg-neutral-900 text-white rounded-md disabled:opacity-50">
            {loading ? 'Updating…' : 'Update step'}
          </button>
        </div>
      </div>
    </div>
  );
}

function findStep(steps: WorkflowStep[], id: string): WorkflowStep | undefined {
  for (const s of steps) {
    if (s.id === id) return s;
    const inner = findStep(s.then ?? s.else ?? s.steps ?? [], id);
    if (inner) return inner;
  }
}
```

- [ ] **Step 2: Build the client**

```bash
cd packages/client && pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/components/workflows/workflow-draft-step-edit-dialog.tsx
git commit -m "feat(client): WorkflowDraftStepEditDialog for scoped LLM-driven step edits"
```

---

### Task 6.10: "Edit workflow" handoff from detail page

The detail page's "Edit" button already navigates to `/automation/workflows/new` with `?editId=<id>` per Task 5.1. Make `new.tsx` honor that.

**Files:**
- Modify: `packages/client/src/routes/automation/workflows/new.tsx`

- [ ] **Step 1: Add `editId` search param handling**

```typescript
// Near the top of new.tsx (after Route definition):
export const Route = createFileRoute('/automation/workflows/new')({
  component: NewWorkflowPage,
  validateSearch: (search: Record<string, unknown>) => ({
    editId: typeof search.editId === 'string' ? search.editId : undefined,
  }),
});
```

In `NewWorkflowPage`:

```typescript
const { editId } = Route.useSearch();
const existing = useWorkflow(editId ?? '');

useEffect(() => {
  if (existing.data?.workflow && !draft) {
    setDraft(existing.data.workflow.data);
    setPrompt(`Workflow loaded for editing: ${existing.data.workflow.name}`);
  }
}, [existing.data, draft]);
```

- [ ] **Step 2: Visual test**

From the detail page, click "Edit" — should land on `/automation/workflows/new?editId=...` with the existing workflow loaded as a draft. Modify via refine; save → uses the same `id` so it updates instead of creates.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/routes/automation/workflows/new.tsx
git commit -m "feat(client): support editId search param for editing existing workflows from /new"
```

---

### Task 6.11: Remove the dev-preview route

**Files:**
- Delete: `packages/client/src/routes/_dev/workflow-diagram-preview.tsx`

- [ ] **Step 1: Delete**

```bash
cd /Users/connerswann/code/valet && git rm packages/client/src/routes/_dev/workflow-diagram-preview.tsx
```

- [ ] **Step 2: Build**

```bash
cd packages/client && pnpm build
```

- [ ] **Step 3: Commit**

```bash
git commit -m "chore(client): remove temporary diagram preview route"
```

---

### Task 6.12: Full E2E verification

- [ ] **Step 1: Deploy worker (if any worker changes since last deploy)**

```bash
ENVIRONMENT=dev make deploy
```

- [ ] **Step 2: Walk through the full flow against deployed dev**

```bash
cd packages/client && VITE_API_URL=https://valet.conner-7e8.workers.dev/api pnpm dev
```

1. Open `/automation/schedules-and-hooks` — confirm cards render with humanized cron + targets.
2. Click "+ New trigger" (placeholder — actual creation handled by existing trigger CRUD, may need its own UI; verify it routes somewhere sensible).
3. Open `/automation/workflows/new`. Type a prompt (e.g. "every weekday at 9am, run `bash echo hello`").
4. Wait for the draft. Verify the diagram renders.
5. Click a node — step edit dialog opens. Type a refinement, submit, watch the diagram update.
6. Type a whole-workflow refinement in the bottom input.
7. Configure a schedule trigger (cron `0 9 * * *`, PT).
8. Click Save. Should land on `/automation/workflows/<id>`.
9. Verify: diagram renders, trigger is listed, recent executions empty.
10. Click "Run now". Trigger executes.
11. Navigate to `/automation/executions/<executionId>` — watch the diagram update in real time as the runner reports step events.

- [ ] **Step 3: Document any gaps as follow-up issues — do not fix in this plan**

---

## Self-review snapshot

Run through each spec section vs. the tasks:

- **Spec §1 (Schedules & Hooks):** Phase 2 covers rename, card design, humanized cron, gray-out-in-place. ✓
- **Spec §2 (Create flow):** Phase 6 covers chat-to-draft, diagram render, refine modes (whole + per-step), JSON side panel, trigger attachment before save. ✓
- **Spec §3 (Workflow detail page):** Phase 5 strips the 2151-line file to view + composition. ✓
- **Spec §4 (Execution details):** Phase 4 covers diagram in runtime mode + step trace + variables + actions. ✓
- **Spec Shared Diagram:** Phase 1 covers React Flow + dagre, three modes, custom node components. ✓
- **Spec Real-time:** Phase 3 covers runner emit, SessionAgentDO + service upsert, EventBus, client subscription. ✓
- **Spec API additions:** Tasks 6.3 / 6.4 add `/api/workflows/draft` and `/api/workflows/draft/step`. ✓

No placeholders, no TBDs, all referenced types defined.
