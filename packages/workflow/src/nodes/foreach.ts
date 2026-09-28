/**
 * `foreach` node executor (node-completion plan decision 8 — the hardest
 * executor in the plan). Iterates over a bounded, template-resolved array,
 * running one inline body node per item, with bounded concurrency and
 * three `onItemError` policies. Unlike every other executor, `foreach`
 * OWNS a second tier of checkpoints: one per `(runId, body.id, i)` — the
 * body node's id never appears in `definition.nodes`, so the interpreter's
 * wave loop never sees these rows; only this executor reads/writes them.
 *
 * ─── Items resolution + truncation ──────────────────────────────────────
 * `node.items` is template-rendered against `{ trigger, nodes }` (+ any
 * inherited aliases — irrelevant in practice since a foreach can never be
 * a foreach body, but threaded for uniformity). A non-array result fails
 * the node immediately (no iterations attempted).
 *
 * Over-length input is never dropped in silence (batch fan-out phase 3):
 *
 *   - `maxItems` absent → the author never chose a bound, so the built-in
 *     ceiling of 100 is a guard, not an instruction. An array over the
 *     ceiling FAILS the node, and the message names the two corrections
 *     (set `maxItems`, or narrow the items expression). Before this, the
 *     run completed against the first 100 rows and reported success.
 *   - `maxItems` present → the author chose the bound, so the array is
 *     truncated to it. The aggregate then carries `truncated: true` and a
 *     `truncationWarning` sentence, both visible on the run page, and the
 *     first entry into the node logs the same sentence.
 *
 * `truncatedCount = inputCount - count` in both shapes.
 *
 * Items re-resolve deterministically on every entry (upstream checkpoints
 * are immutable, so the same render always yields the same array) — this
 * executor does NOT cache the resolved items themselves in `effects`.
 * `{ itemCount, truncatedCount, inputCount }` IS persisted into the first
 * intent's effects purely as a defensive consistency check: if a resumed
 * entry's fresh render disagrees with the persisted counts, that indicates
 * upstream determinism was violated (a checkpoint mutated, or the
 * definition changed under a live run) and this executor throws rather
 * than silently iterating a different array than the one it started.
 *
 * ─── Per-iteration execution ────────────────────────────────────────────
 * One pass runs in three phases. The phases exist so that `concurrency`
 * bounds real parallelism (batch fan-out phase 3) while the aggregate
 * stays byte-for-byte deterministic: every outcome is stored at its own
 * index, and every index-ordered decision is made after the phase ends,
 * never from whichever body happened to settle first.
 *
 *   1. **Terminal scan** (synchronous, index order). An iteration with a
 *      terminal body checkpoint (completed/failed) takes its recorded
 *      outcome and is never re-entered. Under `onItemError: 'fail'`, a
 *      failure found here halts the pass before anything is dispatched.
 *   2. **Re-entry** (concurrent, width `concurrency`). An `intent` body
 *      checkpoint was parked by an earlier pass, so re-invoking its body
 *      executor only re-checks `isSettled`/`awaitResult` — it dispatches
 *      nothing new. Every re-entry is visited; the width bounds how many
 *      run at once. A re-entry that parks again holds the slot it already
 *      held, and that is what `inFlight` counts.
 *   3. **Dispatch** (concurrent, width `concurrency - inFlight`). An
 *      iteration with no checkpoint has never started. A worker takes the
 *      next such index, runs the body, and — when that body PARKS — the
 *      worker stops, because the slot it spent stays spent for the rest of
 *      the pass. A worker whose body reaches a terminal outcome frees the
 *      slot at once and takes the next index. Indices no worker reaches
 *      are deferred (left absent) for a later pass.
 *
 * Phase 3's "stop this worker on a park" rule is what makes the width a
 * bound on OUTSTANDING work rather than on wall-clock parallelism. It is
 * also why a concurrency=1 run of purely synchronous bodies (e.g. `set`)
 * finishes the whole array in one call: nothing parks, so the single
 * worker walks every index.
 *
 * Before phase 3, every body ran behind one `await` in an ordinary `for`
 * loop, and `inFlight` counted parked submissions only. A hundred `tool`
 * or `llm` items therefore ran strictly one after another whatever
 * `concurrency` said, because those bodies never park.
 *
 * ─── onItemError ─────────────────────────────────────────────────────────
 *   - 'skip': a failed body iteration is recorded as `{status:'skipped',
 *     error}` (no `data`); the pass continues.
 *   - 'collect': a failed body iteration is recorded as `{status:'failed',
 *     error}`; the pass continues; the foreach node itself still
 *     completes once every item is terminal.
 *   - 'fail' (default): a failed iteration halts the pass. No iteration
 *     that has not started yet is dispatched, and the failure the node
 *     reports is the one at the LOWEST index, so two bodies failing in the
 *     same wave still produce one deterministic error. The aggregate is
 *     written with whatever is known: every terminal iteration keeps its
 *     real status (phase 1 reads them all before anything is dispatched,
 *     so a completed item at a higher index than the failure is no longer
 *     mis-reported as skipped), and every other iteration (still
 *     `intent`/in-flight, or never reached) is recorded as
 *     `{status:'skipped'}`. The foreach node itself is marked
 *     `failed`. Body iterations left in-flight (this pass's `waitingOn`,
 *     or an earlier pass's still-`intent` checkpoint the break never
 *     revisited) are aborted best-effort by this executor itself
 *     (`session`/`thread` bodies persist a `{sessionId,
 *     receipt:{threadId, queueItemId}}` effects shape this reads back for
 *     `engine.abort`) before returning failed — the interpreter's
 *     cancel/terminate paths never see these sub-run-level submissions, so
 *     nothing else would ever abort them.
 *
 * ─── Aggregate result ────────────────────────────────────────────────────
 * Once every item (0..count-1) has a terminal outcome for this pass (i.e.
 * `waitingOn` came back empty and no fail-mode short-circuit fired), the
 * foreach's OWN checkpoint (at `args.iteration`, top-level so always 0 —
 * a foreach can never be a foreach body) is completed with the
 * `ForeachResult` aggregate. Downstream nodes read
 * `nodes.<foreachId>.output.items[i].data`.
 */

import { renderTemplate } from '../dag/expression.js';
import type { ForeachBodyNode, ForeachNode } from '../dag/nodes.js';
import type { NodeCheckpoint, RunWaitCondition } from '../store.js';
import { executeLlm } from './llm.js';
import { executeThread } from './thread.js';
import { executeWorkflowCall } from './workflow-call.js';
import { executeSession } from './session.js';
import { executeSet } from './set.js';
import { executeTool } from './tool.js';
import { resolveTemplateContext, type NodeExecuteResult, type NodeExecutorArgs } from './index.js';

const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_CONCURRENCY = 1;

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
  /** Present only when rows were dropped. Absent reads as "nothing dropped". */
  truncated?: true;
  /** The sentence a reader of the run page needs. Present with `truncated`. */
  truncationWarning?: string;
}

interface ForeachEffects {
  itemCount: number;
  truncatedCount: number;
  inputCount: number;
}

export async function executeForeach(args: NodeExecutorArgs<ForeachNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, existingCheckpoint } = args;
  const templateContext = resolveTemplateContext(args);

  const rendered = renderTemplate(node.items, templateContext);
  if (!Array.isArray(rendered)) {
    return await failWithoutIterating(
      args,
      `foreach "${node.id}": items expression did not resolve to an array (got ${typeof rendered})`,
    );
  }

  const inputItems: unknown[] = rendered;
  const maxItems = node.maxItems ?? DEFAULT_MAX_ITEMS;

  // An unbounded foreach over an oversized array is the silent-data-loss
  // case: the node has no author-chosen bound, so the built-in ceiling is
  // a guard. Stopping here is the whole point — the alternative is a run
  // that reports success over a prefix of the data.
  if (node.maxItems === undefined && inputItems.length > maxItems) {
    return await failWithoutIterating(
      args,
      `foreach "${node.id}": items resolved to ${inputItems.length} entries, over the built-in limit of ${maxItems}. ` +
        `Set maxItems on this foreach to the number of entries to process, or narrow the items expression.`,
    );
  }

  const items = inputItems.slice(0, maxItems);
  const effects: ForeachEffects = {
    itemCount: items.length,
    truncatedCount: Math.max(0, inputItems.length - items.length),
    inputCount: inputItems.length,
  };
  // Warn once per node, not once per drive pass: this executor re-enters
  // on every pass while items are still in flight.
  if (effects.truncatedCount > 0 && existingCheckpoint === undefined) {
    console.warn(truncationWarning(node.id, effects));
  }

  if (existingCheckpoint === undefined) {
    await store.putIntent({
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'intent',
      attempt,
      createdAt: clock(),
      effects: effectsToRecord(effects),
    });
  } else {
    const persisted = readEffects(existingCheckpoint);
    if (persisted !== undefined && !effectsEqual(persisted, effects)) {
      // Upstream checkpoints are immutable, so a resumed drive must
      // re-derive the exact same array every time. Disagreement here means
      // a determinism invariant was violated elsewhere — not a per-item
      // failure, a structural bug — so this throws rather than silently
      // iterating a different array than the one the run started with.
      throw new Error(
        `foreach "${node.id}": items re-resolved to a different shape on resume ` +
          `(persisted ${JSON.stringify(persisted)}, now ${JSON.stringify(effects)}) — contract violation`,
      );
    }
  }

  const itemAlias = node.itemAlias ?? 'item';
  const indexAlias = node.indexAlias ?? 'index';
  // The validator holds `concurrency` to 1..10, so the floor is defensive
  // only. A width of 0 would defer every item forever.
  const concurrency = Math.max(1, node.concurrency ?? DEFAULT_CONCURRENCY);
  const onItemError = node.onItemError ?? 'fail';
  const failMode = onItemError === 'fail';

  const bodyCheckpoints = await loadBodyCheckpoints(store, run.runId, node.body.id);

  const results: (ForeachItemResult | undefined)[] = new Array(items.length);
  /** Waits per index, flattened in index order at the end so a park's shape does not depend on settle order. */
  const waitsByIndex: (RunWaitCondition[] | undefined)[] = new Array(items.length);

  const runItem = async (i: number): Promise<'terminal' | 'parked'> => {
    const bodyArgs: Omit<NodeExecutorArgs, 'node'> = {
      run,
      attempt,
      iteration: i,
      aliases: { ...(args.aliases ?? {}), [itemAlias]: items[i], [indexAlias]: i },
      templateContext: args.templateContext,
      existingCheckpoint: bodyCheckpoints.get(i),
      store,
      clock,
      engine: args.engine,
      onApprovalPending: args.onApprovalPending,
      onGateResolved: args.onGateResolved,
    };

    const outcome = await invokeBody(node.body, bodyArgs);

    if (outcome.status === 'parked') {
      waitsByIndex[i] = outcome.waitingOn;
      return 'parked';
    }
    if (outcome.status === 'completed') {
      results[i] = { status: 'completed', data: outcome.result };
      return 'terminal';
    }
    if (outcome.status === 'failed') {
      results[i] =
        onItemError === 'skip' ? { status: 'skipped', error: outcome.error } : { status: 'failed', error: outcome.error };
      return 'terminal';
    }
    // No allowed body type (llm/tool/set/session/orchestrator) ever
    // returns 'skipped' from its own executor — that status is reserved
    // for the interpreter's definition-level skip propagation, which
    // never touches foreach body checkpoints.
    throw new Error(
      `foreach "${node.id}": body node "${node.body.id}" returned status "skipped", which is not a valid body outcome`,
    );
  };

  // Phase 1 — terminal rows, index order, nothing dispatched.
  const reentries: number[] = [];
  const unstarted: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const existingBodyCp = bodyCheckpoints.get(i);
    if (existingBodyCp !== undefined && existingBodyCp.status !== 'intent') {
      results[i] = itemResultFromTerminalCheckpoint(existingBodyCp, onItemError);
      continue;
    }
    if (existingBodyCp !== undefined) reentries.push(i); // status === 'intent'
    else unstarted.push(i);
  }

  // Phase 2 — re-entries. Each already holds a slot, so the width bounds
  // how many run at once but never how many are visited.
  if (!(failMode && hasFailure(results))) {
    await runPool(reentries, concurrency, runItem, failMode ? () => hasFailure(results) : undefined);
  }

  // Phase 3 — dispatch, with the slots the parked re-entries left free.
  const inFlight = reentries.filter((i) => waitsByIndex[i] !== undefined).length;
  if (!(failMode && hasFailure(results))) {
    await runPool(unstarted, concurrency - inFlight, runItem, failMode ? () => hasFailure(results) : undefined, true);
  }

  const waitingOn: RunWaitCondition[] = [];
  for (const waits of waitsByIndex) {
    if (waits !== undefined) waitingOn.push(...waits);
  }

  const failure = failMode ? firstFailure(results) : undefined;

  if (failure !== undefined) {
    // Best-effort: abort every body submission left in-flight because of
    // this failure — both ones this pass just parked (`waitingOn`) and
    // ones that were already parked from an earlier pass and that the
    // fail-mode halt never revisited. Must run BEFORE the placeholder-fill
    // below, which would otherwise erase the "never resolved this pass"
    // signal `results[i] === undefined` relies on. Deduped by
    // sessionId+queueItemId; a throw from any single abort must not mask the
    // failure this executor is about to return.
    const abortTargets = new Map<string, { sessionId: string; threadId: string; queueItemId?: string }>();
    const cancelRunIds = new Set<string>();
    for (const wait of waitingOn) {
      if (wait.kind === 'run') {
        cancelRunIds.add(wait.runId);
        continue;
      }
      if (wait.kind !== 'submission') continue;
      abortTargets.set(`${wait.sessionId}:${wait.queueItemId}`, { sessionId: wait.sessionId, threadId: wait.threadId, queueItemId: wait.queueItemId });
    }
    for (let i = 0; i < items.length; i++) {
      if (results[i] !== undefined) continue; // resolved this pass, or already terminal from an earlier pass
      const cp = bodyCheckpoints.get(i);
      if (cp === undefined || cp.status !== 'intent') continue;
      const target = extractSubmissionTarget(cp);
      if (target === undefined) continue; // no receipt persisted yet (or a non-submission body type)
      abortTargets.set(`${target.sessionId}:${target.queueItemId ?? target.threadId}`, target);
    }
    for (const target of abortTargets.values()) {
      try {
        await args.engine.abort(target.sessionId, target.threadId, target.queueItemId);
      } catch {
        // Best-effort: the failure outcome below is authoritative regardless.
      }
    }
    for (const childRunId of cancelRunIds) {
      try {
        await store.insertSignal({ runId: childRunId, signalId: 'cancel', signalType: 'cancel', createdAt: clock() });
        await store.requestWake(childRunId);
      } catch {
        // Best-effort, same as submission aborts above.
      }
    }

    for (let i = 0; i < results.length; i++) {
      if (results[i] === undefined) results[i] = { status: 'skipped' };
    }
    const aggregate = buildAggregate(collectSettled(results, node.id), effects, node.id);
    await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'failed',
      error: `foreach "${node.id}": ${failure.error}`,
      result: aggregate,
      effects: effectsToRecord(effects),
      attempt,
      createdAt: clock(),
    });
    return { status: 'failed', error: `foreach "${node.id}": ${failure.error}` };
  }

  if (waitingOn.length > 0) {
    return { status: 'parked', waitingOn };
  }

  // Every item must have resolved to a terminal outcome. A worker only
  // stops taking indices when its body parks, so an absent item always has
  // a park to account for it, and `waitingOn` is empty here. The check
  // turns a broken invariant into a named error instead of an aggregate
  // with holes in it.
  const settled = collectSettled(results, node.id);
  const aggregate = buildAggregate(settled, effects, node.id);
  await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'completed',
    result: aggregate,
    effects: effectsToRecord(effects),
    attempt,
    createdAt: clock(),
  });
  return { status: 'completed', result: aggregate };
}

/**
 * Runs `indices` through `width` concurrent workers, in index order.
 *
 * `halted` is polled before each index is taken, so a fail-mode pass stops
 * taking new work as soon as any body fails. `stopWorkerOnPark` is the
 * dispatch-phase rule: a body that parks holds its concurrency slot for the
 * rest of the pass, so the worker that spent that slot must stop.
 *
 * A throw from any worker propagates only after every other worker has
 * settled, so no body write is left mid-air when the drive aborts. This
 * mirrors `executeWave` in the interpreter, for the same reason.
 */
async function runPool(
  indices: number[],
  width: number,
  runItem: (i: number) => Promise<'terminal' | 'parked'>,
  halted?: () => boolean,
  stopWorkerOnPark = false,
): Promise<void> {
  // `Math.max(0, width)` is load-bearing, not defensive. The re-entry phase
  // passes `concurrency - inFlight`, and parked re-entries can hold every
  // slot, which makes that negative. A negative width must run no worker and
  // return, rather than throw: the parked bodies still hold the slots, and
  // the next pass runs the rest once they release them.
  const workers = Math.min(Math.max(0, width), indices.length);
  if (workers === 0) return;

  let next = 0;
  const settled = await Promise.allSettled(
    Array.from({ length: workers }, async () => {
      while (true) {
        if (halted?.() === true) return;
        const at = next++;
        if (at >= indices.length) return;
        const outcome = await runItem(indices[at]);
        if (outcome === 'parked' && stopWorkerOnPark) return;
      }
    }),
  );
  const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (rejected) throw rejected.reason;
}

function hasFailure(results: (ForeachItemResult | undefined)[]): boolean {
  return results.some((r) => r?.status === 'failed');
}

/** The lowest-index failure, so a wave with two failures still reports one deterministic error. */
function firstFailure(results: (ForeachItemResult | undefined)[]): { error: string } | undefined {
  for (const result of results) {
    if (result?.status === 'failed') return { error: result.error ?? 'unknown error' };
  }
  return undefined;
}

/** Narrows the per-index results to a dense array, naming the node when the invariant is broken. */
function collectSettled(results: (ForeachItemResult | undefined)[], nodeId: string): ForeachItemResult[] {
  const out: ForeachItemResult[] = [];
  for (const [i, result] of results.entries()) {
    if (result === undefined) {
      throw new Error(
        `foreach "${nodeId}": item ${i} has no outcome and nothing is parked for it — contract violation`,
      );
    }
    out.push(result);
  }
  return out;
}

function truncationWarning(nodeId: string, effects: ForeachEffects): string {
  return (
    `foreach "${nodeId}": ${effects.truncatedCount} of ${effects.inputCount} entries were dropped by maxItems=${effects.itemCount}. ` +
    `Raise maxItems to process them, or narrow the items expression so the count is intentional.`
  );
}

/** The intent-then-failed checkpoint pair for a failure raised before any iteration starts. */
async function failWithoutIterating(args: NodeExecutorArgs<ForeachNode>, error: string): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, existingCheckpoint } = args;
  if (existingCheckpoint === undefined) {
    await store.putIntent({ runId: run.runId, nodeId: node.id, iteration, status: 'intent', attempt, createdAt: clock() });
  }
  await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'failed',
    error,
    attempt,
    createdAt: clock(),
  });
  return { status: 'failed', error };
}

async function invokeBody(body: ForeachBodyNode, argsBase: Omit<NodeExecutorArgs, 'node'>): Promise<NodeExecuteResult> {
  switch (body.type) {
    case 'set':
      return executeSet({ ...argsBase, node: body });
    case 'llm':
      return executeLlm({ ...argsBase, node: body });
    case 'tool':
      return executeTool({ ...argsBase, node: body });
    case 'session':
      return executeSession({ ...argsBase, node: body });
    case 'thread':
      return executeThread({ ...argsBase, node: body });
    case 'workflow':
      return executeWorkflowCall({ ...argsBase, node: body });
  }
}

async function loadBodyCheckpoints(
  store: NodeExecutorArgs['store'],
  runId: string,
  bodyId: string,
): Promise<Map<number, NodeCheckpoint>> {
  const all = await store.getCheckpoints(runId);
  const byIteration = new Map<number, NodeCheckpoint>();
  for (const cp of all) {
    if (cp.nodeId === bodyId) byIteration.set(cp.iteration, cp);
  }
  return byIteration;
}

/**
 * Reads a `session`/`thread` body checkpoint's persisted submission
 * receipt (`submission-node.ts`'s `{ sessionId, receipt: { threadId,
 * queueItemId } }` effects shape) — the coordinates `engine.abort` needs.
 * Returns `undefined` for a body checkpoint that hasn't dispatched yet (no
 * receipt persisted this attempt) or belongs to a non-submission body type
 * (`set`/`llm`/`tool`), neither of which has anything to abort.
 */
function extractSubmissionTarget(cp: NodeCheckpoint): { sessionId: string; threadId: string; queueItemId?: string } | undefined {
  const effects = cp.effects;
  if (!effects || typeof effects.sessionId !== 'string') return undefined;
  const receipt = effects.receipt;
  if (!receipt || typeof receipt !== 'object') return undefined;
  const threadId = 'threadId' in receipt ? receipt.threadId : undefined;
  if (typeof threadId !== 'string') return undefined;
  const queueItemId = "queueItemId" in receipt && typeof receipt.queueItemId === "string" ? receipt.queueItemId : undefined;
  return { sessionId: effects.sessionId, threadId, queueItemId };
}

function itemResultFromTerminalCheckpoint(cp: NodeCheckpoint, onItemError: 'fail' | 'skip' | 'collect'): ForeachItemResult {
  if (cp.status === 'completed') return { status: 'completed', data: cp.result };
  if (cp.status === 'failed') {
    return onItemError === 'skip' ? { status: 'skipped', error: cp.error } : { status: 'failed', error: cp.error };
  }
  throw new Error(`foreach body checkpoint "${cp.nodeId}" has unexpected terminal status "${cp.status}"`);
}

function buildAggregate(items: ForeachItemResult[], effects: ForeachEffects, nodeId: string): ForeachResult {
  const completedCount = items.filter((r) => r.status === 'completed').length;
  const skippedCount = items.filter((r) => r.status === 'skipped').length;
  const failedCount = items.filter((r) => r.status === 'failed').length;
  return {
    items,
    count: items.length,
    inputCount: effects.inputCount,
    truncatedCount: effects.truncatedCount,
    completedCount,
    skippedCount,
    failedCount,
    // Only present when rows were dropped, so an untruncated aggregate
    // keeps the exact shape every existing consumer reads.
    ...(effects.truncatedCount > 0
      ? { truncated: true as const, truncationWarning: truncationWarning(nodeId, effects) }
      : {}),
  };
}

function effectsToRecord(effects: ForeachEffects): Record<string, unknown> {
  return { itemCount: effects.itemCount, truncatedCount: effects.truncatedCount, inputCount: effects.inputCount };
}

function readEffects(cp: NodeCheckpoint | undefined): ForeachEffects | undefined {
  const raw = cp?.effects;
  if (!raw) return undefined;
  if (typeof raw.itemCount !== 'number' || typeof raw.truncatedCount !== 'number' || typeof raw.inputCount !== 'number') {
    return undefined;
  }
  return { itemCount: raw.itemCount, truncatedCount: raw.truncatedCount, inputCount: raw.inputCount };
}

function effectsEqual(a: ForeachEffects, b: ForeachEffects): boolean {
  return a.itemCount === b.itemCount && a.truncatedCount === b.truncatedCount && a.inputCount === b.inputCount;
}
