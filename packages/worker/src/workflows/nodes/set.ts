/**
 * `set` node executor — builds a deterministic JSON object by rendering
 * templates in the node's `values` field against the runtime state.
 *
 * No side effects, no network calls. Pure transformation.
 */

import type { SetNode } from '@valet/shared';
import { renderJsonTemplates } from '../../lib/workflow-dag/expression.js';
import { buildTemplateContext } from '../context.js';
import type { NodeExecutorArgs } from '../types.js';

export async function executeSet(args: NodeExecutorArgs<SetNode>): Promise<unknown> {
  const ctx = buildTemplateContext(args.state, args.aliases);
  return renderJsonTemplates(args.node.values, ctx);
}
