/**
 * `llm` node executor (node-completion plan decision 4). A single,
 * non-durable completion over `engine.llmComplete` — never parks, always
 * completes or fails within one `driveUntilPark` call.
 *
 * Determinism / at-least-once dispatch:
 *   - Unlike `session`/`thread`, `llmComplete` has no receiver-side
 *     idempotency handle (no `dispatchId` to dedupe against) — the engine
 *     contract (`engine-deps.ts`) is explicit that this is at-least-once:
 *     the intent checkpoint narrows the duplicate window, and one duplicate
 *     billed call on a crash-after-dispatch-before-checkpoint is the
 *     accepted cost.
 *   - The intent checkpoint needs no effects on first entry (no id to
 *     remember). If the model's response fails `outputSchema` validation,
 *     exactly one repair round is attempted; that decision — and the first
 *     failure's validation error, so a resume can rebuild the exact same
 *     repair prompt without re-running the original call — is persisted
 *     into `effects` before the repair call, mirroring `session`'s
 *     `repairAttempted` bookkeeping.
 *
 * Lifecycle:
 *   1. No prior checkpoint: write the (effects-less) intent.
 *   2. `effects.repairAttempted` not set (first entry, or resumed after a
 *      crash before the repair decision was persisted): render `prompt`/
 *      `system` over the template context, call `llmComplete` (clamped
 *      `maxOutputTokens`). A throw fails the node with the error message.
 *      No `outputSchema`, or `outputSchema` set and the response validates
 *      → node `completed` with `{ text, output? }` (size-guarded). Schema
 *      set and validation fails → persist `{ repairAttempted: true,
 *      firstError }` into effects (equal-attempt overwrite) and fall
 *      through to the repair call in the same drive (no park).
 *   3. `effects.repairAttempted` already set (freshly, or resumed after a
 *      crash before the repair call's result was checkpointed): re-render
 *      the repair prompt from the persisted `firstError` and call
 *      `llmComplete` again. Valid → completed; invalid or throw → node
 *      `failed`.
 *   4. Before any `completed` write, the result JSON is size-guarded
 *      (512KB) — oversized fails the node instead.
 */

import { extractStructuredOutput } from '@valet/engine';

import { renderTemplate, type TemplateContext } from '../dag/expression.js';
import type { LlmNode } from '../dag/nodes.js';
import type { NodeCheckpoint } from '../store.js';
import { resolveTemplateContext, type NodeExecuteResult, type NodeExecutorArgs } from './index.js';
import type { WorkflowLlmUsage } from '../engine-deps.js';

const MAX_OUTPUT_TOKENS_CEILING = 16_384;
const MAX_RESULT_BYTES = 512 * 1024;

export interface LlmResult {
  text: string;
  output?: unknown;
  /** Summed across BOTH calls when a repair round ran in the same drive
   * (both were real billed completions — reporting only the repair call
   * would silently undercount, the exact failure mode this field exists
   * to fix). On resume after a crash between the first call and the
   * repair-decision checkpoint, only the repair call's usage is
   * recoverable — the first call's cost is genuinely gone, the same
   * accepted at-least-once gap this executor's docstring already covers
   * for duplicate dispatch. */
  usage: WorkflowLlmUsage;
}

/**
 * Narrows a completed `llm` node's opaque `NodeExecuteResult.result` back
 * to its usage, for the interpreter's tracing wrapper to attach as span
 * attributes. `result` is `unknown` at that call site — `NodeExecuteResult`
 * is shared across every node type and isn't parameterized by `node.type` —
 * so this checks the real shape instead of trusting the caller's node-type
 * narrowing alone.
 */
export function llmUsageSpanAttributes(result: unknown): Record<string, number> | undefined {
  if (typeof result !== 'object' || result === null || !('usage' in result)) return undefined;
  const usage = (result as { usage: unknown }).usage;
  if (
    typeof usage !== 'object' ||
    usage === null ||
    typeof (usage as Partial<WorkflowLlmUsage>).inputTokens !== 'number' ||
    typeof (usage as Partial<WorkflowLlmUsage>).outputTokens !== 'number' ||
    typeof (usage as Partial<WorkflowLlmUsage>).cacheReadTokens !== 'number' ||
    typeof (usage as Partial<WorkflowLlmUsage>).cacheWriteTokens !== 'number' ||
    typeof (usage as Partial<WorkflowLlmUsage>).totalTokens !== 'number' ||
    typeof (usage as Partial<WorkflowLlmUsage>).costUsd !== 'number'
  ) {
    return undefined;
  }
  const u = usage as WorkflowLlmUsage;
  return {
    'valet.workflow.node.llm.usage.input_tokens': u.inputTokens,
    'valet.workflow.node.llm.usage.output_tokens': u.outputTokens,
    'valet.workflow.node.llm.usage.cache_read_tokens': u.cacheReadTokens,
    'valet.workflow.node.llm.usage.cache_write_tokens': u.cacheWriteTokens,
    'valet.workflow.node.llm.usage.total_tokens': u.totalTokens,
    'valet.workflow.node.llm.usage.cost_usd': u.costUsd,
  };
}

/** Rounded to 1e-10 USD (0.1 nano-dollar) — far finer than any real per-token
 * price, so no genuine cost precision is lost. This only clips the IEEE 754
 * binary-decimal noise that a plain `+` can introduce (e.g. `0.1 + 0.2 ===
 * 0.30000000000000004`), which would otherwise leak into billing/tracing
 * data and into every downstream `JSON.stringify` of this result. */
const COST_USD_PRECISION = 1e10;

function roundCostUsd(value: number): number {
  return Math.round(value * COST_USD_PRECISION) / COST_USD_PRECISION;
}

function sumUsage(a: WorkflowLlmUsage, b: WorkflowLlmUsage): WorkflowLlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: roundCostUsd(a.costUsd + b.costUsd),
  };
}

interface LlmEffects {
  repairAttempted: boolean;
  firstError?: string;
}

export async function executeLlm(args: NodeExecutorArgs<LlmNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, engine, existingCheckpoint } = args;
  const templateContext = resolveTemplateContext(args);

  let effects = readEffects(existingCheckpoint);

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
  }

  const promptText = renderText(node.prompt, templateContext);
  const systemText = node.system !== undefined ? renderText(node.system, templateContext) : undefined;
  const maxOutputTokens = clampMaxOutputTokens(node.maxOutputTokens);

  // Carries the first call's usage into the repair branch below (same
  // drive only — a resume that re-enters with `effects.repairAttempted`
  // already true skips this block entirely, so `firstCallUsage` stays
  // `undefined` and only the repair call's usage is reported; see
  // `LlmResult.usage`'s doc comment).
  let firstCallUsage: WorkflowLlmUsage | undefined;

  if (!effects.repairAttempted) {
    let completion;
    try {
      completion = await engine.llmComplete({
        runId: run.runId,
        model: node.model,
        system: systemText,
        prompt: promptText,
        temperature: node.temperature,
        maxOutputTokens,
      });
    } catch (err) {
      // No completion happened — nothing was billed, nothing to report.
      return await fail(args, effects, errorMessage(err));
    }
    firstCallUsage = completion.usage;

    if (node.outputSchema === undefined) {
      return await complete(args, effects, { text: completion.text, usage: completion.usage });
    }

    const extracted = extractStructuredOutput(completion.text, node.outputSchema);
    if (extracted.output !== undefined) {
      return await complete(args, effects, { text: completion.text, output: extracted.output, usage: completion.usage });
    }

    // Schema validation failed: persist the repair decision (+ the
    // validation error a resume would otherwise lose) before issuing the
    // repair call, then fall through to it in this same drive.
    effects = { repairAttempted: true, firstError: extracted.error };
    await store.putIntent({
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'intent',
      attempt,
      createdAt: clock(),
      effects: effectsToRecord(effects),
    });
  }

  const schema = node.outputSchema;
  if (schema === undefined) {
    // Contract violation: repair is only ever entered when outputSchema is
    // set (the definition never changes across drives), so this is
    // unreachable in practice — a defensive guard, not a real branch.
    return await fail(args, effects, `llm node "${node.id}" entered repair with no outputSchema — contract violation`);
  }

  const repairPrompt = buildRepairPrompt(promptText, schema, effects.firstError);
  let repairCompletion;
  try {
    repairCompletion = await engine.llmComplete({
      runId: run.runId,
      model: node.model,
      system: systemText,
      prompt: repairPrompt,
      temperature: node.temperature,
      maxOutputTokens,
    });
  } catch (err) {
    // The repair call itself never returned, but the FIRST call (if this
    // drive made one) genuinely happened and was billed — report it
    // rather than treating "the terminal call failed" as "nothing cost
    // anything."
    return await fail(args, effects, errorMessage(err), firstCallUsage);
  }

  const usage = firstCallUsage ? sumUsage(firstCallUsage, repairCompletion.usage) : repairCompletion.usage;

  const repairExtracted = extractStructuredOutput(repairCompletion.text, schema);
  if (repairExtracted.output !== undefined) {
    return await complete(args, effects, { text: repairCompletion.text, output: repairExtracted.output, usage });
  }

  const error = repairExtracted.error ?? `llm node "${node.id}" result did not match outputSchema after repair`;
  // Both calls were real, billed completions even though validation
  // failed twice — `usage` (already summed above) must not be discarded
  // just because the node's OUTCOME is failure.
  return await fail(args, effects, error, usage);
}

async function complete(args: NodeExecutorArgs<LlmNode>, effects: LlmEffects, result: LlmResult): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock } = args;

  const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
  if (bytes > MAX_RESULT_BYTES) {
    // The completion itself is real and billed — only the text was too
    // large to persist as a `result`, which is a reason to reject the
    // node output, not the usage that produced it.
    return await fail(
      args,
      effects,
      `llm node "${node.id}" result exceeds ${MAX_RESULT_BYTES} bytes (${bytes} bytes)`,
      result.usage,
    );
  }

  await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'completed',
    result,
    effects: effectsToRecord(effects),
    attempt,
    createdAt: clock(),
  });
  return { status: 'completed', result };
}

/** `usage` is optional because most failure paths never completed a call
 * (a throw before any completion) and genuinely have nothing to report —
 * but when a real, billed completion DID happen before the node's outcome
 * ended up `failed` (a repair round that also fails validation, or a
 * repair call that throws after the first call succeeded), the caller
 * passes it here so it isn't discarded. Stashed in `effects` rather than
 * `LlmResult` — a failed checkpoint has no `result`, and `effects` is
 * already this executor's home for terminal diagnostic data that isn't
 * itself the node's output. */
async function fail(
  args: NodeExecutorArgs<LlmNode>,
  effects: LlmEffects,
  error: string,
  usage?: WorkflowLlmUsage,
): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock } = args;
  const effectsRecord = effectsToRecord(effects);
  if (usage !== undefined) effectsRecord.usage = usage;
  await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'failed',
    error,
    effects: effectsRecord,
    attempt,
    createdAt: clock(),
  });
  return { status: 'failed', error };
}

function buildRepairPrompt(originalPrompt: string, schema: Record<string, unknown>, validationError: string | undefined): string {
  const errorText = validationError ?? 'result did not match the schema';
  return `${originalPrompt}\n\nYour previous response failed validation: ${errorText}\nRespond with ONLY JSON matching this schema:\n${JSON.stringify(schema)}`;
}

function clampMaxOutputTokens(requested: number | undefined): number | undefined {
  if (requested === undefined) return undefined;
  return Math.min(requested, MAX_OUTPUT_TOKENS_CEILING);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readEffects(existingCheckpoint: NodeCheckpoint | undefined): LlmEffects {
  const raw = existingCheckpoint?.effects;
  if (!raw) return { repairAttempted: false };
  return {
    repairAttempted: raw.repairAttempted === true,
    firstError: typeof raw.firstError === 'string' ? raw.firstError : undefined,
  };
}

function effectsToRecord(effects: LlmEffects): Record<string, unknown> {
  const record: Record<string, unknown> = { repairAttempted: effects.repairAttempted };
  if (effects.firstError !== undefined) record.firstError = effects.firstError;
  return record;
}

function renderText(source: string, ctx: TemplateContext): string {
  const v = renderTemplate(source, ctx);
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return JSON.stringify(v);
}
