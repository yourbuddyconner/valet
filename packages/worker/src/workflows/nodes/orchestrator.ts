/**
 * `orchestrator` node executor.
 *
 * Dispatches a prompt to the user's persistent orchestrator session via
 * the existing `dispatchOrchestratorPrompt` service helper.
 *
 * `wait.mode = "none"` (default) returns dispatch metadata immediately —
 * the orchestrator continues asynchronously.
 *
 * `wait.mode = "until_idle"` polls the workflow-created automation
 * thread's prompt status until that thread is idle or the wait times out.
 */

import type { OrchestratorNode } from '@valet/shared';
import { renderTemplate } from '../../lib/workflow-dag/expression.js';
import { parseDurationMs } from '../../lib/workflow-dag/duration.js';
import { dispatchOrchestratorPrompt } from '../../services/orchestrator.js';
import { buildTemplateContext } from '../context.js';
import { coerceTemplateString } from '../templates.js';
import { pollThreadUntilIdle } from '../polling.js';
import { iterationSuffix, NO_RETRY } from '../types.js';
import type { NodeExecutorArgs } from '../types.js';

export interface OrchestratorResult {
  dispatched: boolean;
  sessionId: string;
  threadId?: string;
  reason?: string;
  /** Present only when `wait.mode = "until_idle"`. */
  finalStatus?: string;
  waited?: boolean;
}

const DEFAULT_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h

export async function executeOrchestrator(args: NodeExecutorArgs<OrchestratorNode>): Promise<OrchestratorResult> {
  const ctx = buildTemplateContext(args.state, args.aliases);
  const prompt = coerceTemplateString(renderTemplate(args.node.prompt, ctx));

  // Wrap the dispatch in step.do so the DO fetch + DB writes inside
  // dispatchOrchestratorPrompt are cached across replays. Without this,
  // hibernation/wake (or any later step.do retry) replays the executor
  // body from the top and re-fires the same prompt at the orchestrator.
  // NO_RETRY (limit:1) keeps re-fire risk minimal on transient failure;
  // the dispatch helper is not idempotent across retries.
  const iSuffix = iterationSuffix(args.aliases);
  const dispatchJson = await args.step.do(
    `orchestrator-dispatch:${args.node.id}${iSuffix}`,
    { retries: { ...NO_RETRY } },
    async () => {
      const result = await dispatchOrchestratorPrompt(args.env, {
        userId: args.params.userId,
        content: prompt,
        forceNewThread: true,
        threadOrigin: {
          originType: 'automation',
          originTriggerType: args.params.trigger.type,
          originTriggerId: args.params.executionId,
        },
      });
      return JSON.stringify({
        dispatched: result.dispatched,
        sessionId: result.sessionId,
        threadId: result.threadId ?? null,
        reason: result.reason ?? null,
      });
    },
  );
  const dispatch = JSON.parse(dispatchJson) as { dispatched: boolean; sessionId: string; threadId: string | null; reason: string | null };

  const waitMode = args.node.wait?.mode ?? 'none';
  if (waitMode === 'none' || !dispatch.dispatched) {
    return {
      dispatched: dispatch.dispatched,
      sessionId: dispatch.sessionId,
      ...(dispatch.threadId ? { threadId: dispatch.threadId } : {}),
      ...(dispatch.reason ? { reason: dispatch.reason } : {}),
    };
  }

  if (!dispatch.threadId) {
    throw new Error(`orchestrator node "${args.node.id}" dispatched without a thread id`);
  }

  // until_idle — poll the specific automation thread created for this workflow node.
  const timeoutMs = args.node.wait?.timeout ? (parseDurationMs(args.node.wait.timeout) ?? DEFAULT_WAIT_TIMEOUT_MS) : DEFAULT_WAIT_TIMEOUT_MS;
  const finalStatus = await pollThreadUntilIdle(args.env, args.step, {
    sessionId: dispatch.sessionId,
    threadId: dispatch.threadId,
    pollKey: `orchestrator-poll:${args.node.id}${iSuffix}`,
    timeoutMs,
  });

  return {
    dispatched: dispatch.dispatched,
    sessionId: dispatch.sessionId,
    threadId: dispatch.threadId,
    finalStatus,
    waited: true,
  };
}
