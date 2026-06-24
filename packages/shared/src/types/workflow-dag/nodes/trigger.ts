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

export const triggerNodeDocs: NodeDocs = {
  label: 'Trigger',
  description: 'Where the workflow starts and what data it receives',
  longDescription: `Every workflow has exactly one trigger node — it's the entrypoint. The trigger
runs when the workflow is invoked manually, on a schedule, or by a webhook;
whatever data the trigger sends becomes this node's output, and the rest of
the DAG reads from there.

Other nodes reference the trigger's data with template expressions like
\`\${nodes.trigger.output.data.<field>}\`. Declaring expected input fields in
the schema below has two effects:

- **Manual runs** render an input form with those fields.
- **Authoring suggestions** in template pickers across the editor include the
  declared fields so they're easier to find.

The schema is advisory — webhook and schedule triggers can deliver any
payload at runtime; the workflow runs whatever shape arrives.`,
  fields: {
    dataSchema: {
      help: 'Optional. Declare the fields you expect the trigger to provide. Manual runs prompt for these; other nodes get template suggestions for the declared keys.',
    },
  },
};
