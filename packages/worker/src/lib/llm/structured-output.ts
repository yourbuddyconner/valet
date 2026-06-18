/**
 * Worker-side structured-output LLM adapter.
 *
 * Thin wrapper around the Vercel AI SDK's `generateObject` that:
 *   - resolves a provider-prefixed model id (anthropic:/openai:/google:)
 *     to the right provider client using API keys from env
 *   - bridges JSON Schema → the SDK's `jsonSchema()` helper
 *   - returns `{ response: text }` for schema-less text generation
 *   - retries structured parse / schema-validation failure with backoff
 *
 * Used by the `llm` node executor. Lives here (not under workflows/) so
 * future ad-hoc LLM callers (e.g. orchestrator summary nodes) can reuse it.
 */

import {
  generateObject,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  JSONParseError,
  TypeValidationError,
} from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { Env } from '../../env.js';
import { parseModelId, type LlmProvider } from './model-id.js';

export { parseModelId, hasProviderKey, type LlmProvider } from './model-id.js';

export interface StructuredOutputRequest {
  env: Env;
  /** Provider-prefixed model id, e.g. "anthropic:claude-sonnet-4-5". */
  modelId: string;
  prompt: string;
  system?: string;
  /** JSON Schema describing the desired output shape. Omit for plain text `{ response }`. */
  outputSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  /** Retry policy for parse / schema-validation failures. Default 3 tries, 2s/4s/8s backoff. */
  retries?: number;
  retryBackoffMs?: number[];
}

export interface StructuredOutputResult {
  value: unknown;
  attempts: number;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = [2000, 4000, 8000];

export async function generateStructured(
  request: StructuredOutputRequest,
): Promise<StructuredOutputResult> {
  const { provider, model } = parseModelId(request.modelId);
  const client = buildProviderClient(provider, request.env);
  const languageModel = client(model);

  const retries = request.retries ?? DEFAULT_RETRIES;
  const backoff = request.retryBackoffMs ?? DEFAULT_BACKOFF_MS;

  if (!request.outputSchema) {
    const result = await generateText({
      model: languageModel,
      prompt: request.prompt,
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
    });
    return { value: { response: result.text }, attempts: 1 };
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await generateObject({
        model: languageModel,
        // JSON Schema validation is enforced when authors declare an
        // outputSchema. Schema-less LLM nodes use generateText above.
        schema: jsonSchema(request.outputSchema as Parameters<typeof jsonSchema>[0]),
        prompt: request.prompt,
        ...(request.system !== undefined ? { system: request.system } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      });
      return { value: result.object, attempts: attempt };
    } catch (err) {
      lastErr = err;
      // Only retry parse / schema-validation failures. Network errors
      // (APICallError, etc.) are already retried by the SDK with its
      // own backoff; we don't double-retry those.
      if (!isParseFailure(err)) throw err;
      if (attempt < retries) {
        const delay = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? backoff[backoff.length - 1] ?? 0;
        if (delay > 0) await sleep(delay);
      }
    }
  }
  throw lastErr ?? new Error('generateStructured failed without an error');
}

function buildProviderClient(provider: LlmProvider, env: Env) {
  switch (provider) {
    case 'anthropic':
      if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
    case 'openai':
      if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
      return createOpenAI({ apiKey: env.OPENAI_API_KEY });
    case 'google':
      if (!env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY is not configured');
      return createGoogleGenerativeAI({ apiKey: env.GOOGLE_API_KEY });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classifies the AI SDK errors that represent "the model returned
 * something we can't parse / validate against the schema" — those are
 * worth retrying. Wraps SDK-internal error types so callers don't have
 * to know all three.
 */
function isParseFailure(err: unknown): boolean {
  return (
    err instanceof NoObjectGeneratedError ||
    err instanceof JSONParseError ||
    err instanceof TypeValidationError
  );
}
