/**
 * `llm` node executor.
 *
 * Renders the prompt + system templates against the runtime state, then
 * delegates to the worker-side structured-output adapter (Vercel AI SDK).
 * Returns the parsed JSON value as `nodes.<id>.data`. JSON-only contract:
 * if no `outputSchema` is set, the model is still prompted for JSON and
 * we return the parsed value as-is.
 */

import type { LlmNode } from '@valet/shared';
import { renderTemplate } from '../../lib/workflow-dag/expression.js';
import { generateStructured } from '../../lib/llm/structured-output.js';
import { assembleLlmProviderEnv } from '../../lib/llm/provider-env.js';
import { getDb } from '../../lib/drizzle.js';
import { buildTemplateContext } from '../context.js';
import { coerceTemplateString } from '../templates.js';
import type { NodeExecutorArgs } from '../types.js';

export async function executeLlm(args: NodeExecutorArgs<LlmNode>): Promise<unknown> {
  if (!args.node.model) {
    throw new Error(`llm node "${args.node.id}" has no model configured`);
  }

  const ctx = buildTemplateContext(args.state, args.aliases);
  const prompt = coerceTemplateString(renderTemplate(args.node.prompt, ctx));
  const system = args.node.system !== undefined
    ? coerceTemplateString(renderTemplate(args.node.system, ctx))
    : undefined;

  // Hard runtime ceiling on maxOutputTokens. Cloudflare Workflows
  // truncates step results that exceed its serialization limit; a model
  // configured with a 200k token budget can return a JSON blob that
  // breaks the step boundary and fails the whole instance with a
  // cryptic "step result too large". Clamp here so we instead get a
  // clean per-node failure (or a smaller response). Log when the clamp
  // bites so authors know their config was overridden.
  const MAX_OUTPUT_TOKENS_CEILING = 16_384;
  const requestedMaxTokens = args.node.maxOutputTokens;
  const maxOutputTokens = requestedMaxTokens !== undefined
    ? Math.min(requestedMaxTokens, MAX_OUTPUT_TOKENS_CEILING)
    : undefined;
  if (requestedMaxTokens !== undefined && maxOutputTokens !== requestedMaxTokens) {
    console.warn(`[workflow-dag] llm node "${args.node.id}": maxOutputTokens ${requestedMaxTokens} clamped to ${MAX_OUTPUT_TOKENS_CEILING}`);
  }

  const providerEnv = await assembleLlmProviderEnv(getDb(args.env.DB), args.env);
  const llmEnv = { ...args.env, ...providerEnv };

  const result = await generateStructured({
    env: llmEnv,
    modelId: args.node.model,
    prompt,
    ...(system !== undefined ? { system } : {}),
    ...(args.node.outputSchema !== undefined ? { outputSchema: args.node.outputSchema } : {}),
    ...(args.node.temperature !== undefined ? { temperature: args.node.temperature } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  });

  // Defensive: if the model still produces a payload past the step
  // boundary's safety margin, fail the node loudly. 512KB is roughly
  // half the documented step-result limit; serialized JSON beyond that
  // gets risky.
  const STEP_RESULT_LIMIT_BYTES = 512 * 1024;
  const serialized = JSON.stringify(result.value ?? null);
  if (serialized.length > STEP_RESULT_LIMIT_BYTES) {
    throw new Error(
      `llm node "${args.node.id}": output ${serialized.length} bytes exceeds the ${STEP_RESULT_LIMIT_BYTES}-byte safety ceiling — reduce maxOutputTokens or tighten the output schema`,
    );
  }

  return result.value;
}
