import type { NodeDocs } from '../docs.js';
import type { LlmNode } from './llm.js';
import type { ToolNode } from './tool.js';
import type { SetNode } from './set.js';
import type { StopNode } from './stop.js';
import type { OrchestratorNode } from './orchestrator.js';
import type { SessionNode } from './session.js';

// Body of a foreach is restricted — no nested foreach, no if (control flow at
// the DAG level), no approval. The runtime executes one body per item.
export type ForeachBodyNode =
  | LlmNode
  | ToolNode
  | SetNode
  | StopNode
  | OrchestratorNode
  | SessionNode;

export interface ForeachNode {
  id: string;
  type: 'foreach';
  items: string;
  body: ForeachBodyNode;
  maxItems?: number;
  concurrency?: number;
  itemAlias?: string;
  indexAlias?: string;
  onItemError?: 'fail' | 'skip' | 'collect';
}

export function createDefaultForeachNode(id: string): ForeachNode {
  return {
    id,
    type: 'foreach',
    items: '',
    body: { id: `${id}-body`, type: 'set', values: {} },
  };
}

export const foreachNodeDocs: NodeDocs = {
  label: 'For each',
  description: 'Run one body node for every item',
  longDescription: `Iterates a list and runs the body node once per element. The body is a
single node (LLM, tool, set, stop, orchestrator, or session) — control-flow
nodes (foreach, if, approval) are not allowed as bodies because the
runtime treats the foreach as a single step boundary.

Items can be referenced inside the body with \`\${item}\` (or whatever
\`itemAlias\` you set) and \`\${index}\` (or \`indexAlias\`). The node's output
is an array of the per-item outputs, in the same order as the input list.

Iteration semantics:

- \`concurrency\` controls how many items run in parallel (default 1).
- \`onItemError = 'fail'\` aborts the workflow on the first failure (default).
- \`onItemError = 'skip'\` records the failure and continues.
- \`onItemError = 'collect'\` returns successes plus error markers in the output array.`,
  fields: {
    items: {
      help: 'Template expression that resolves to an array. The body runs once per element.',
    },
    body: {
      help: 'The node executed per item. Restricted to step-driven types — no nested foreach, if, or approval.',
    },
    maxItems: {
      help: 'Optional cap. The runtime always enforces the workflow-level maxForeachItems policy (default 5000); this is a per-node tighter limit.',
    },
    concurrency: {
      help: 'Parallel iterations. 1 = strictly sequential. Higher values speed up I/O-bound bodies but spend more compute simultaneously.',
    },
    itemAlias: {
      help: 'Name the current item is bound to inside the body. Defaults to "item" — references the value as ${item}.',
    },
    indexAlias: {
      help: 'Name the 0-based item index is bound to inside the body. Defaults to "index".',
    },
    onItemError: {
      help: 'How to handle a failed iteration. fail (default) aborts the run; skip continues without the result; collect returns error markers in the output array alongside successes.',
    },
  },
  gotchas: [
    'Foreach LLM bodies inherit the same no-retry policy as top-level LLM nodes — one failed iteration doesn\'t spawn five more model calls.',
    'The runtime tracks cumulative foreach iterations across the whole workflow; the 5001st iteration aborts the run regardless of per-node maxItems.',
  ],
};
