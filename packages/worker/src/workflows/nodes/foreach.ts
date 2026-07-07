/**
 * `foreach` node executor.
 *
 * Iterates over a bounded array, running a single inline body node per
 * item. The body's template context is extended with `<itemAlias>` and
 * `<indexAlias>` (defaulting to `item` and `index`).
 *
 * Each iteration runs in its own `step.do` named `node:<id>:i:<index>`
 * so iterations are individually retriable and observable.
 *
 * onItemError modes:
 *   - 'fail' (default): first failed item rejects the foreach node.
 *   - 'skip': failed items are recorded with status='skipped'.
 *   - 'collect': failed items are recorded with status='failed' + error.
 */

import type { ForeachNode } from '@valet/shared';
import { renderTemplate } from '../../lib/workflow-dag/expression.js';
import { buildTemplateContext } from '../context.js';
import type { NodeExecutorArgs } from '../types.js';
// Lazy import to break a cycle: runtime.ts → executor → dispatchNode → executor.
// dispatchNode is loaded at call time.
import { dispatchNode, isStepDrivenNode } from '../runtime.js';
import { CancelledError, NO_RETRY, type CorrelationIds } from '../types.js';

export interface ForeachItemResult {
  status: 'completed' | 'skipped' | 'failed';
  data?: unknown;
  error?: string;
}

export interface ForeachResult {
  items: ForeachItemResult[];
  count: number;
  inputCount: number;
  truncatedCount: number;
  completedCount: number;
  skippedCount: number;
  failedCount: number;
}

const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_CONCURRENCY = 1;
// Per spec §"Retry, Concurrency, And Quota": the 5001st cumulative
// foreach iteration across the entire execution aborts the workflow.
const CUMULATIVE_ITERATION_CAP = 5000;

export async function executeForeach(args: NodeExecutorArgs<ForeachNode>): Promise<ForeachResult> {
  const ctx = buildTemplateContext(args.state, args.aliases);

  // Resolve items expression to an array.
  const rendered = renderTemplate(args.node.items, ctx);
  if (!Array.isArray(rendered)) {
    throw new Error(`foreach "${args.node.id}": items expression did not resolve to an array (got ${typeof rendered})`);
  }
  const inputItems = rendered as unknown[];

  // Limit per-node fanout without failing the workflow. Policy validation
  // still rejects maxItems values above the environment ceiling.
  const maxItems = args.node.maxItems ?? DEFAULT_MAX_ITEMS;
  const items = inputItems.slice(0, maxItems);
  const truncatedCount = Math.max(0, inputItems.length - items.length);

  // Cumulative across-execution cap. Track on state so multiple
  // foreach nodes in the same workflow share the budget. The counter
  // is bumped per-iteration in runIteration below so a foreach that
  // throws on the first item doesn't pre-charge the whole batch.
  const priorCount = args.state.foreachIterationCount ?? 0;
  if (priorCount >= CUMULATIVE_ITERATION_CAP) {
    throw new Error(
      `foreach "${args.node.id}": prior foreach nodes already consumed the per-execution cap of ${CUMULATIVE_ITERATION_CAP} iterations`,
    );
  }

  const itemAlias = args.node.itemAlias ?? 'item';
  const indexAlias = args.node.indexAlias ?? 'index';
  const concurrency = args.node.concurrency ?? DEFAULT_CONCURRENCY;
  const onItemError = args.node.onItemError ?? 'fail';

  const results: ForeachItemResult[] = new Array(items.length);

  // Helper that bumps the cumulative counter only after the iteration
  // actually attempted (replay-safe: the counter is recomputed from
  // cached step.do values on each replay, so increment timing here is
  // observational only).
  const bumpAndCheck = (): void => {
    const next = (args.state.foreachIterationCount ?? 0) + 1;
    args.state.foreachIterationCount = next;
    if (next > CUMULATIVE_ITERATION_CAP) {
      throw new Error(
        `foreach "${args.node.id}": cumulative iteration ${next} exceeds the per-execution cap of ${CUMULATIVE_ITERATION_CAP}`,
      );
    }
  };

  // Sequential vs concurrent dispatch.
  if (concurrency <= 1) {
    for (let i = 0; i < items.length; i++) {
      bumpAndCheck();
      results[i] = await runIteration(args, i, items[i]!, itemAlias, indexAlias);
      if (results[i]!.status === 'failed' && onItemError === 'fail') {
        throw new Error(`foreach "${args.node.id}": item ${i} failed: ${results[i]!.error}`);
      }
    }
  } else {
    // Batch into chunks of `concurrency`. Each batch is awaited before
    // dispatching the next — bounded parallelism without unbounded Promise.all.
    for (let start = 0; start < items.length; start += concurrency) {
      const end = Math.min(start + concurrency, items.length);
      // Bump the counter once per item in this batch BEFORE dispatch.
      for (let k = 0; k < end - start; k++) bumpAndCheck();
      const batch = await Promise.all(
        Array.from({ length: end - start }, (_, k) => {
          const i = start + k;
          return runIteration(args, i, items[i]!, itemAlias, indexAlias);
        }),
      );
      for (let k = 0; k < batch.length; k++) {
        results[start + k] = batch[k]!;
      }
      // Honor onItemError: if any batch item failed with fail-mode, stop.
      if (onItemError === 'fail') {
        const failedInBatch = batch.find((r) => r.status === 'failed');
        if (failedInBatch) {
          throw new Error(`foreach "${args.node.id}": item failed: ${failedInBatch.error}`);
        }
      }
    }
  }

  // Fill in any unset slots (only possible if we broke out early; defensive).
  for (let i = 0; i < results.length; i++) {
    if (results[i] === undefined) results[i] = { status: 'skipped' };
  }

  const completedCount = results.filter((r) => r.status === 'completed').length;
  const skippedCount = results.filter((r) => r.status === 'skipped').length;
  const failedCount = results.filter((r) => r.status === 'failed').length;
  return {
    items: results,
    count: results.length,
    inputCount: inputItems.length,
    truncatedCount,
    completedCount,
    skippedCount,
    failedCount,
  };
}

/**
 * Run one iteration's body inside its own step.do so it's individually
 * cached + retriable. Returns the iteration result envelope, never
 * throws — the caller decides how to handle a 'failed' result based on
 * onItemError mode.
 */
async function runIteration(
  args: NodeExecutorArgs<ForeachNode>,
  index: number,
  item: unknown,
  itemAlias: string,
  indexAlias: string,
): Promise<ForeachItemResult> {
  const aliases = {
    ...(args.aliases ?? {}),
    [itemAlias]: item,
    [indexAlias]: index,
    // Reserved key for executors that need the raw iteration index
    // regardless of how the author named indexAlias — e.g. tool.ts
    // uses it to construct unique action_invocations IDs per iteration.
    __iterationIndex: index,
  };

  const stepName = `node:${args.node.id}:i:${index}`;
  const onItemError = args.node.onItemError ?? 'fail';

  // Fresh correlations side-channel per iteration so iteration N's
  // invocationId/approvalId cannot leak into iteration N+1's trace
  // row. DO NOT reuse args.correlations — that would conflate the
  // parent foreach node's correlations with the child body's.
  const iterationCorrelations: CorrelationIds = {};

  // Per-iteration recordWaiting: forwards the parent runtime callback
  // with the body's nodeId, this iteration's index, and the freshly
  // surfaced invocation/approval correlation ids. Without this, a
  // tool-policy approval inside foreach parks the workflow in
  // waiting_approval with no per-iteration trace row and no
  // approvalId link in the audit chain.
  const recordWaiting: NodeExecutorArgs['recordWaiting'] = args.recordWaiting
    ? async (transition) => {
        await args.recordWaiting!({
          ...transition,
          iterationIndex: index,
          ...(iterationCorrelations.invocationId
            ? { invocationId: iterationCorrelations.invocationId }
            : {}),
          ...(iterationCorrelations.approvalId
            ? { approvalId: iterationCorrelations.approvalId }
            : {}),
        });
      }
    : undefined;

  try {
    // Step-driven body types (tool, session, orchestrator) own their
    // own step.do calls — wrapping them again here would nest step.do,
    // which CF rejects. Bypass the outer wrap in that case.
    let data: unknown;
    if (isStepDrivenNode(args.node.body)) {
      data = await dispatchNode(args.node.body, {
        node: args.node.body,
        state: args.state,
        params: args.params,
        env: args.env,
        step: args.step,
        aliases,
        correlations: iterationCorrelations,
        ...(recordWaiting ? { recordWaiting } : {}),
      });
    } else {
      // Side-effectful non-step-driven body types (currently just llm)
      // need NO_RETRY to match the top-level runtime policy. Without
      // this, CF's default 5-retry policy would duplicate billed model
      // calls and re-render user-visible content on a transient error.
      // Mirrors runtime.ts:executeNodeStep — the policy must hold for a
      // node wherever it appears in the graph.
      const stepConfig = args.node.body.type === 'llm' ? { retries: { ...NO_RETRY } } : undefined;
      const callback = async () => {
        const out = await dispatchNode(args.node.body, {
          node: args.node.body,
          state: args.state,
          params: args.params,
          env: args.env,
          step: args.step,
          aliases,
          correlations: iterationCorrelations,
          ...(recordWaiting ? { recordWaiting } : {}),
        });
        return JSON.stringify(out ?? null);
      };
      const json = stepConfig
        ? await args.step.do(stepName, stepConfig, callback)
        : await args.step.do(stepName, callback);
      data = JSON.parse(json) as unknown;
    }
    return { status: 'completed', data };
  } catch (err) {
    // CancelledError is a workflow-control signal, NOT a per-item
    // failure. Re-throw so the runtime wave loop sees it and writes
    // a 'skipped:cancelled' terminal trace + 'cancelled' final status.
    // Coercing it into ForeachItemResult{status:'failed'} would make a
    // system cancel look like a workflow-author bug and let downstream
    // nodes keep running under onItemError='skip'/'collect'.
    //
    // NOTE: StopFailure is INTENTIONALLY caught here and treated as a
    // per-item failure. A `stop outcome=failure` inside a foreach body
    // semantically halts THAT iteration (with onItemError logic
    // applied) rather than the whole workflow — matches the existing
    // tests + documented foreach semantics.
    if (err instanceof CancelledError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (onItemError === 'skip') {
      return { status: 'skipped', error: message };
    }
    // Both 'fail' and 'collect' record the failure. The caller decides
    // whether to short-circuit (fail) or continue (collect).
    return { status: 'failed', error: message };
  }
}
