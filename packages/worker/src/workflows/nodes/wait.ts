/**
 * `wait` node executor — durably pauses the workflow for a relative
 * duration via `step.sleep`. `wait.mode = "until"` is out of MVP and is
 * rejected at validation, so this executor only handles `duration`.
 *
 * The step.sleep call uses the deterministic `wait:<id>` name so
 * Cloudflare Workflows can hibernate / replay correctly.
 */

import type { WaitNode } from '@valet/shared';
import { renderTemplate } from '../../lib/workflow-dag/expression.js';
import { parseDurationMs } from '../../lib/workflow-dag/duration.js';
import { buildTemplateContext } from '../context.js';
import { setExecutionStatus } from '../execution-status.js';
import { iterationSuffix } from '../types.js';
import type { NodeExecutorArgs } from '../types.js';

export interface WaitResult {
  mode: 'duration';
  resumedAt: string;
}

export async function executeWait(args: NodeExecutorArgs<WaitNode>): Promise<WaitResult> {
  const ctx = buildTemplateContext(args.state, args.aliases);
  const renderedDuration = renderTemplate(args.node.duration, ctx);
  const durationStr = typeof renderedDuration === 'string' ? renderedDuration : String(renderedDuration);

  // Cloudflare's step.sleep accepts EITHER a number (ms) or a verbose
  // template-literal type like "5 seconds" — NOT the compact "5s" form
  // the validator parses. Convert compact → ms here so we hit the
  // number overload and skip the string-format mismatch entirely.
  const ms = parseDurationMs(durationStr);
  if (ms === null) {
    throw new Error(`wait node "${args.node.id}": duration "${durationStr}" is not parseable`);
  }
  const iSuffix = iterationSuffix(args.aliases);
  await setExecutionStatus({
    env: args.env,
    step: args.step,
    executionId: args.params.executionId,
    status: 'waiting_time',
    stepKey: `node:${args.node.id}${iSuffix}:enter:waiting_time`,
    allowedPrior: ['running'],
  });

  // Persist a waiting_time trace row so the execution detail UI shows
  // this node as parked on step.sleep (rather than 'running') for the
  // duration of the wait. Captured `startedAt` inside step.do upstream
  // so the value is replay-stable.
  const waitStartedAt = await args.step.do(`wait:${args.node.id}${iSuffix}:started-at`, async () => new Date().toISOString());
  await args.recordWaiting?.({
    nodeId: args.node.id,
    nodeType: 'wait',
    status: 'waiting_time',
    startedAt: waitStartedAt,
  });

  // try/finally guarantees the exit transition fires even if
  // step.sleep throws on wake. Without this, the row would stay in
  // waiting_time and the runtime's terminal write would no-op.
  try {
    await args.step.sleep(`wait:${args.node.id}${iSuffix}`, ms);
  } finally {
    await setExecutionStatus({
      env: args.env,
      step: args.step,
      executionId: args.params.executionId,
      status: 'running',
      stepKey: `node:${args.node.id}${iSuffix}:exit:running`,
      allowedPrior: ['waiting_time'],
    });
  }

  // resumedAt captured inside step.do so the cached value is stable
  // across replays; a fresh new Date() outside step.do would diverge
  // each wake and leak into state/trace inconsistently.
  const resumedAt = await args.step.do(`wait:${args.node.id}${iSuffix}:resumed-at`, async () => new Date().toISOString());
  return { mode: 'duration', resumedAt };
}
