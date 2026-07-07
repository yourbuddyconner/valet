/**
 * `stop` node executor — terminates a branch with an explicit outcome
 * and optional rendered output / message.
 *
 * A successful `stop` completes the node and persists its rendered
 * output for the workflow's final result. A failed `stop` throws a
 * StopFailure that the runtime translates into a workflow failure with
 * the rendered message.
 */

import type { StopNode } from '@valet/shared';
import { renderJsonTemplates, renderTemplate } from '../../lib/workflow-dag/expression.js';
import { buildTemplateContext } from '../context.js';
import { coerceTemplateString } from '../templates.js';
import type { NodeExecutorArgs } from '../types.js';

export interface StopOutput {
  outcome: 'success' | 'failure';
  output?: unknown;
  message?: string;
}

export class StopFailure extends Error {
  constructor(public readonly stopOutput: StopOutput) {
    super(stopOutput.message ?? 'Workflow stopped with failure outcome');
    this.name = 'StopFailure';
  }
}

export async function executeStop(args: NodeExecutorArgs<StopNode>): Promise<StopOutput> {
  const ctx = buildTemplateContext(args.state, args.aliases);
  const outcome = args.node.outcome ?? 'success';
  const output = args.node.output !== undefined ? renderJsonTemplates(args.node.output, ctx) : undefined;
  const message = args.node.message !== undefined ? coerceTemplateString(renderTemplate(args.node.message, ctx)) : undefined;

  if (outcome === 'failure') {
    throw new StopFailure({ outcome, output, message });
  }
  return { outcome, output, message };
}
