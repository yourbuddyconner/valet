/**
 * `thread` node executor (node-completion plan decision 5). Mirrors
 * the `session` executor's shape with `engine.promptOrchestrator` standing
 * in for `createSession` + `prompt`: dispatch a followup to the run
 * owner's orchestrator session, optionally park behind it, and on
 * settlement map the outcome the same way `session` does — including the
 * one-shot schema-repair round trip. All of that shared machinery lives in
 * `submission-node.ts`; this file supplies only the orchestrator-specific
 * dispatch primitive and result shapes.
 *
 * Determinism / at-most-once dispatch:
 *   - `dispatchId = workflow:{runId}:{nodeId}[:{iteration}]` (repair turn:
 *     `dispatchId + ':repair'`), derived from ids already durable in the
 *     checkpoint PK.
 *   - `promptOrchestrator` is idempotent by `dispatchId` (engine contract,
 *     `engine-deps.ts`): re-issuing after a crash between "dispatched" and
 *     "receipt persisted" returns the *original* receipt.
 *   - Unlike `session`, the session id isn't minted up front — it's
 *     resolved by `promptOrchestrator` from `ownerHint` and round-tripped
 *     through `effects` from the first dispatch onward (see
 *     `submission-node.ts`'s `initialEffects: {}` for this node).
 *   - `queueMode` is always `'followup'`: an internal workflow signal must
 *     never steer-abort the orchestrator's live turn (Phase 4 rule) — this
 *     is asserted on every dispatch, including the repair one.
 *
 * A run with no recorded `owner` (`WorkflowRun.owner`) has nowhere to
 * dispatch to: the node fails immediately with a descriptive error,
 * without ever calling `promptOrchestrator`.
 */

import type { ThreadNode } from '../dag/nodes.js';
import { renderTemplate, type TemplateContext } from '../dag/expression.js';
import { executeSubmissionNode, type SubmissionDispatch } from './submission-node.js';
import { iterationSuffix, resolveTemplateContext, type NodeExecuteResult, type NodeExecutorArgs } from './index.js';

export interface ThreadDispatchedResult {
  sessionId: string;
  threadId: string;
  receipt: { threadId: string; queueItemId: string };
}

export interface ThreadSettledResult {
  sessionId: string;
  threadId: string;
  response?: string;
  output?: unknown;
}

export async function executeThread(args: NodeExecutorArgs<ThreadNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, engine, existingCheckpoint } = args;
  const templateContext = resolveTemplateContext(args);

  const owner = run.owner;
  if (owner === undefined) {
    const error = `thread node "${node.id}" requires a run owner`;
    await store.putIntent({
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'intent',
      attempt,
      createdAt: clock(),
      effects: {},
    });
    await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'failed',
      error,
      effects: {},
      attempt,
      createdAt: clock(),
    });
    return { status: 'failed', error };
  }

  const suffix = iterationSuffix(iteration);
  const dispatchId = `workflow:${run.runId}:${node.id}${suffix}`;

  return await executeSubmissionNode<ThreadDispatchedResult, ThreadSettledResult>(
    { run, nodeId: node.id, attempt, iteration, store, clock, engine, existingCheckpoint },
    {
      nodeKind: 'thread',
      dispatchId,
      initialEffects: {},
      waitMode: node.wait?.mode,
      outputSchema: node.outputSchema,
      dispatch: async (id): Promise<SubmissionDispatch> => {
        const promptText = renderText(node.prompt, templateContext);
        const dispatched = await engine.promptOrchestrator(promptText, {
          dispatchId: id,
          queueMode: 'followup',
          ownerHint: owner,
        });
        return {
          sessionId: dispatched.sessionId,
          receipt: { threadId: dispatched.threadId, queueItemId: dispatched.queueItemId },
        };
      },
      dispatchRepair: async (repairDispatchId, repairPrompt) => {
        const dispatched = await engine.promptOrchestrator(repairPrompt, {
          dispatchId: repairDispatchId,
          queueMode: 'followup',
          ownerHint: owner,
        });
        return { threadId: dispatched.threadId, queueItemId: dispatched.queueItemId };
      },
      buildDispatchedResult: (dispatch) => ({ sessionId: dispatch.sessionId, threadId: dispatch.receipt.threadId, receipt: dispatch.receipt }),
      buildSettledResult: (id, result, receipt) => ({ sessionId: id, threadId: receipt.threadId, response: result.text, output: result.output }),
    },
  );
}

function renderText(source: string, ctx: TemplateContext): string {
  const v = renderTemplate(source, ctx);
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return JSON.stringify(v);
}
