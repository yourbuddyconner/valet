import type { NodeDocs } from '../docs.js';

export interface WaitNode {
  id: string;
  type: 'wait';
  mode: 'duration';
  duration: string;
}

export function createDefaultWaitNode(id: string): WaitNode {
  return { id, type: 'wait', mode: 'duration', duration: '5m' };
}

export const waitNodeDocs: NodeDocs = {
  label: 'Wait',
  description: 'Pause for a fixed duration',
  longDescription: `Sleeps the workflow for the specified duration before continuing. The
Cloudflare Workflow runtime hibernates the run during the wait, so this
costs no compute — long waits (hours, days) are fine.

Use this for backoff between retries, scheduled follow-ups
("re-check in 24 hours"), or rate-limiting cascading workflows.`,
  fields: {
    duration: {
      help: 'Duration string like "30s", "5m", "2h", "1d". Maximum is set by the workflow policy (default 30 days).',
    },
  },
  gotchas: [
    'The workflow policy caps how long any wait can be (maxWaitDurationMs). Longer durations are clamped at policy time.',
  ],
};
