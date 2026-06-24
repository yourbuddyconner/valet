import type { NodeDocs } from '../docs.js';

export interface SetNode {
  id: string;
  type: 'set';
  values: unknown;
}

export function createDefaultSetNode(id: string): SetNode {
  return { id, type: 'set', values: {} };
}

export const setNodeDocs: NodeDocs = {
  label: 'Set values',
  description: 'Create values for downstream nodes',
  longDescription: `Constructs a value and emits it as this node's output. The most common
use is producing a shaped object for downstream nodes to consume, but
\`values\` can be any JSON — a string, array, number, or nested object.

Template expressions inside \`values\` are evaluated before storage, so this
is the natural place to combine multiple upstream outputs into one
structure or to derive a constant the rest of the workflow depends on.`,
  fields: {
    values: {
      help: 'The value to emit. Templates anywhere inside are evaluated (e.g. {"name": "${trigger.data.user}", "tags": ["${nodes.classify.output.label}"]}).',
    },
  },
};
