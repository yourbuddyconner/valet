import type { NodeDocs } from '../docs.js';

export interface StopNode {
  id: string;
  type: 'stop';
  outcome?: 'success' | 'failure';
  output?: unknown;
  message?: string;
}

export function createDefaultStopNode(id: string): StopNode {
  return { id, type: 'stop', outcome: 'success' };
}

export const stopNodeDocs: NodeDocs<StopNode> = {
  label: 'Stop',
  description: 'Finish the workflow',
  longDescription: `Terminates the run. The workflow's final status is the \`outcome\` of the
first stop node reached, and any \`output\` is captured as the workflow's
return value (visible in the execution detail page and the API response
for synchronous runs).

### Output vs message — what's the difference?

These look similar but serve different audiences:

- **\`output\`** — the **machine-readable return value** of the workflow. This
  is what synchronous API callers receive in the response body and what the
  execution log captures as the result. Use it for structured data: a
  computed score, a generated artifact URL, a JSON object summarizing what
  the run produced.
- **\`message\`** — a **human-readable status line** shown in the executions
  UI next to the outcome badge. Use it for one-line context: "skipped: no
  matching rows", "approved by @alice", "no changes needed". On a failure
  outcome, this is also surfaced as the error string.

Set both if you want the UI to read well **and** the API caller to get
structured data. Set neither if the outcome alone is enough.

### When you need stop

A workflow doesn't strictly need an explicit stop node — runs end naturally
when every reachable node has executed. Reach for stop when you want to:

- Mark a specific path as a failure (\`outcome: 'failure'\`)
- Return a structured result the API caller can read
- Short-circuit the rest of the DAG from inside an \`if\` branch`,
  fields: {
    outcome: {
      help: 'Marks the run as success or failure. Failure outcomes show up red in the executions list and surface the message as the error.',
    },
    output: {
      help: 'Machine-readable return value. Synchronous API callers receive this in the response body. Templates are evaluated — return upstream node output verbatim if you want.',
    },
    message: {
      help: 'Human-readable status line shown next to the outcome in the UI. Use this for context like "skipped: no rows" — not for structured data (use output for that).',
    },
  },
};
