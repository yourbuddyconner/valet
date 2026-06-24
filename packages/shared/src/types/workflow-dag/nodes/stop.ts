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

A workflow doesn't strictly need an explicit stop node — runs end naturally
when every reachable node has executed. Use stop when you want to:

- Mark a specific path as a failure (\`outcome: 'failure'\`)
- Return a structured result the API caller can read
- Short-circuit the rest of the DAG from inside an \`if\` branch`,
  fields: {
    outcome: {
      help: 'Marks the run as success or failure. Failure outcomes show up red in the executions list and surface the message as the error.',
    },
    output: {
      help: 'Optional payload returned as the workflow result. Templates are evaluated, so you can return upstream node output verbatim.',
    },
    message: {
      help: 'Optional human-readable message. Shown next to the outcome in the UI.',
    },
  },
};
