/**
 * Worker-side structured-output LLM adapter.
 *
 * Thin wrapper around the Vercel AI SDK's `generateText` that:
 *   - resolves a provider-prefixed model id (anthropic:/openai:/google:)
 *     to the right provider client using API keys from env
 *   - returns `{ response: text }` for schema-less text generation
 *   - parses JSON responses against authored output schemas and repairs
 *     malformed/schema-invalid JSON with the same model.
 *
 * Used by the `llm`, `session`, and `orchestrator` node executors.
 * Lives here (not under workflows/) so ad-hoc LLM callers can reuse the
 * same JSON parsing/repair behavior.
 */

import { generateText } from 'ai';
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

export interface StructuredJsonRepairRequest {
  env: Env;
  /** Provider-prefixed model id. Required only if the first parse/validation attempt fails. */
  modelId?: string;
  text: string;
  outputSchema: Record<string, unknown>;
  contextLabel: string;
  /** Number of model repair attempts after the original parse attempt. Default 3. */
  retries?: number;
  retryBackoffMs?: number[];
}

export interface StructuredJsonRepairResult {
  value: unknown;
  attempts: number;
  repaired: boolean;
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

  const result = await generateText({
    model: languageModel,
    prompt: withJsonSchemaInstruction(request.prompt, request.outputSchema),
    ...(request.system !== undefined ? { system: request.system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
  });
  const structured = await parseOrRepairStructuredJson({
    env: request.env,
    modelId: request.modelId,
    text: result.text,
    outputSchema: request.outputSchema,
    contextLabel: 'llm structured output',
    retries,
    retryBackoffMs: backoff,
  });
  return { value: structured.value, attempts: structured.attempts };
}

export async function parseOrRepairStructuredJson(
  request: StructuredJsonRepairRequest,
): Promise<StructuredJsonRepairResult> {
  const retries = request.retries ?? DEFAULT_RETRIES;
  const backoff = request.retryBackoffMs ?? DEFAULT_BACKOFF_MS;

  let currentText = request.text;
  let parsed = parseAndValidateText(currentText, request.outputSchema);
  if (parsed.ok) {
    return { value: parsed.value, attempts: 1, repaired: false };
  }
  let lastError = parsed.error;

  if (!request.modelId) {
    throw new Error(`${request.contextLabel}: response does not match outputSchema and no repair model is configured (${lastError})`);
  }

  const { provider, model } = parseModelId(request.modelId);
  const client = buildProviderClient(provider, request.env);
  const languageModel = client(model);

  for (let repairAttempt = 1; repairAttempt <= retries; repairAttempt += 1) {
    if (repairAttempt > 1) {
      const delay = backoff[Math.min(repairAttempt - 2, backoff.length - 1)] ?? backoff[backoff.length - 1] ?? 0;
      if (delay > 0) await sleep(delay);
    }

    const repair = await generateText({
      model: languageModel,
      prompt: buildRepairPrompt({
        contextLabel: request.contextLabel,
        text: currentText,
        outputSchema: request.outputSchema,
        error: lastError,
      }),
      temperature: 0,
    });
    currentText = repair.text;
    parsed = parseAndValidateText(currentText, request.outputSchema);
    if (parsed.ok) {
      return { value: parsed.value, attempts: repairAttempt + 1, repaired: true };
    }
    lastError = parsed.error;
  }

  throw new Error(`${request.contextLabel}: response does not match outputSchema after ${retries} repair attempts (${lastError})`);
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

function withJsonSchemaInstruction(prompt: string, outputSchema: Record<string, unknown>): string {
  return `${prompt}

Return only valid JSON matching this JSON Schema. Do not include Markdown fences, commentary, or prose.

JSON Schema:
${JSON.stringify(outputSchema, null, 2)}`;
}

function buildRepairPrompt(params: {
  contextLabel: string;
  text: string;
  outputSchema: Record<string, unknown>;
  error: string;
}): string {
  return `Repair the JSON output for ${params.contextLabel}.

Return only valid JSON matching the JSON Schema. Do not include Markdown fences, commentary, or prose.

Error:
${params.error}

JSON Schema:
${JSON.stringify(params.outputSchema, null, 2)}

Failed JSON:
${clipForRepairPrompt(params.text)}`;
}

function clipForRepairPrompt(text: string): string {
  const maxChars = 200_000;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}

[truncated ${text.length - maxChars} trailing characters before repair]`;
}

function parseAndValidateText(
  text: string,
  schema: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const parsed = parseJsonFromText(text);
  if (!parsed.ok) return parsed;
  const error = validateJsonSchemaValue(parsed.value, schema, '$');
  if (error) return { ok: false, error };
  return parsed;
}

function parseJsonFromText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidates = jsonCandidates(text);
  let lastError = 'no JSON object or array found';
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error: `invalid JSON: ${lastError}` };
}

function jsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());
  if (trimmed.length > 0) candidates.push(trimmed);

  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = trimmed.indexOf('[');
  const arrayEnd = trimmed.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(trimmed.slice(arrayStart, arrayEnd + 1));
  }

  return [...new Set(candidates)];
}

function validateJsonSchemaValue(value: unknown, schema: Record<string, unknown>, path: string): string | null {
  const allowedTypes = jsonSchemaTypes(schema.type);
  const type = allowedTypes.find((candidate) => candidate !== 'null');
  if (allowedTypes.length > 0) {
    const actual = jsonTypeName(value);
    if (!allowedTypes.includes(actual)) return `${path}: expected ${allowedTypes.join(' or ')}, received ${actual}`;
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues && !enumValues.some((item) => jsonEquals(item, value))) {
    return `${path}: expected one of ${enumValues.map((item) => JSON.stringify(item)).join(', ')}`;
  }

  if (type === 'object' || (type === undefined && isRecord(value) && isRecord(schema.properties))) {
    if (!isRecord(value)) return `${path}: expected object, received ${jsonTypeName(value)}`;
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];
    for (const key of required) {
      if (!(key in value)) return `${path}.${key}: required property is missing`;
    }

    const properties = isRecord(schema.properties) ? schema.properties : undefined;
    if (properties) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!(key in value)) continue;
        if (!isRecord(propertySchema)) continue;
        const error = validateJsonSchemaValue(value[key], propertySchema, `${path}.${key}`);
        if (error) return error;
      }
    }

    if (schema.additionalProperties === false && properties) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) return `${path}.${key}: additional property is not allowed`;
      }
    }
  }

  if (type === 'array' || (type === undefined && Array.isArray(value) && isRecord(schema.items))) {
    if (!Array.isArray(value)) return `${path}: expected array, received ${jsonTypeName(value)}`;
    if (isRecord(schema.items)) {
      for (let i = 0; i < value.length; i += 1) {
        const error = validateJsonSchemaValue(value[i], schema.items, `${path}[${i}]`);
        if (error) return error;
      }
    }
  }

  return null;
}

function jsonTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function jsonSchemaTypes(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return [...new Set(value.filter((item): item is string => typeof item === 'string'))];
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
