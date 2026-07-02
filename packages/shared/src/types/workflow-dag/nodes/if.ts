import type { NodeDocs } from '../docs.js';

export interface IfNode {
  id: string;
  type: 'if';
  combinator?: 'and' | 'or';
  conditions: IfCondition[];
}

export interface IfCondition {
  left: string;
  dataType: 'string' | 'number' | 'date' | 'boolean' | 'array' | 'object';
  operation: string;
  right?: unknown;
}

export function createDefaultIfNode(id: string): IfNode {
  return { id, type: 'if', conditions: [] };
}

export const ifNodeDocs: NodeDocs<IfNode> = {
  label: 'If',
  description: 'Branch based on conditions',
  longDescription: `Splits the DAG along a true/false fork. Each condition compares a template
expression on the left to a literal or template on the right; the
combinator decides whether all conditions must match (\`and\`, the default)
or any of them (\`or\`).

Outbound edges from an if-node are labeled — drag from the right edge to
get the true branch, or from the lower handle to get the false branch.
Downstream nodes can connect to either or both; the runtime skips the
branch that doesn't fire.`,
  fields: {
    combinator: {
      help: 'How multiple conditions combine. and = every condition must match. or = any condition matching is enough. Defaults to and.',
    },
    conditions: {
      help: 'Each condition compares left (usually a template like ${nodes.x.output.status}) to right using the operation. The dataType drives which operations are available.',
    },
  },
};
