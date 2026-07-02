import type { NodeDocs } from '../docs.js';
import type { WorkflowInputDefinition } from '../shape.js';

export interface TriggerNode {
  id: string;
  type: 'trigger';
  dataSchema?: Record<string, WorkflowInputDefinition>;
}

export function createDefaultTriggerNode(id: string): TriggerNode {
  return { id, type: 'trigger' };
}

export const triggerNodeDocs: NodeDocs<TriggerNode> = {
  label: 'Trigger',
  description: 'Where the workflow starts and what data it receives',
  longDescription: `Every workflow has exactly one trigger node — it's the entrypoint. The trigger
runs when the workflow is invoked, and whatever data it sends becomes this
node's output. Downstream nodes read it with template expressions like
\`\${nodes.trigger.output.data.<field>}\`.

### Trigger output shape

The output is always:

\`\`\`json
{
  "type": "manual" | "schedule" | "webhook",
  "timestamp": "2026-06-23T12:00:00Z",
  "data": { /* depends on trigger type — see below */ },
  "metadata": { /* delivery metadata */ }
}
\`\`\`

\`data\` is what you usually want — it's the payload specific to how the
workflow was invoked:

- **Manual** — the fields you declared in this node's schema below, filled in
  by whoever started the run.
- **Schedule** — the fixed payload configured on the schedule trigger
  (declared per-trigger, not here).
- **Webhook** — the parsed JSON body that hit the webhook URL. Shape is
  whatever the caller sends; declaring expected fields here just helps
  authoring.

### Declaring expected fields

The schema below is advisory. It does two things:

- **Manual runs** render an input form with the declared fields.
- **Authoring suggestions** across the editor (template pickers, autocomplete)
  surface the declared keys.

Webhook and schedule triggers will still deliver whatever payload arrives at
runtime — the workflow doesn't reject unexpected shapes.`,
  fields: {
    dataSchema: {
      help: 'Optional. The fields you expect the trigger to provide. Manual runs prompt for these; template autocomplete suggests them. Webhook/schedule payloads are not validated against this schema.',
    },
  },
  gotchas: [
    "The schema doesn't validate runtime payloads — it's advisory only. A webhook caller can send any shape and the workflow will run with whatever arrives.",
  ],
};
