import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the structured-output module so we don't make real LLM calls and
// don't have to thread MockLanguageModelV3 through the provider clients.
const generateStructured = vi.fn();
vi.mock('../../lib/llm/structured-output.js', () => ({
  generateStructured: (...args: unknown[]) => generateStructured(...args),
}));

import { executeLlm } from './llm.js';
import type { LlmNode, WorkflowDagState } from '@valet/shared';
import type { WorkflowRunParams } from '../types.js';
import type { Env } from '../../env.js';
import type { WorkflowStep } from 'cloudflare:workers';

function args(node: LlmNode, triggerData: Record<string, unknown> = {}) {
  const fullState: WorkflowDagState = {
    trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: triggerData, metadata: {} },
    inputs: {},
    nodes: {},
    skipped: {},
  };
  return {
    node,
    state: fullState,
    params: {} as WorkflowRunParams,
    env: { ANTHROPIC_API_KEY: 'test-key' } as Env,
    step: {} as WorkflowStep,
  };
}

beforeEach(() => {
  generateStructured.mockReset();
});

describe('executeLlm', () => {
  it('renders templates in prompt + system and calls the structured-output adapter', async () => {
    generateStructured.mockResolvedValue({ value: { greeting: 'hello world' }, attempts: 1 });
    const node: LlmNode = {
      id: 'extract',
      type: 'llm',
      model: 'anthropic:claude-3-5-sonnet',
      system: 'You are a {{trigger.data.role}}',
      prompt: 'Summarize: {{trigger.data.body}}',
      maxOutputTokens: 200,
    };
    const out = await executeLlm(args(node, { role: 'assistant', body: 'long text' }));

    expect(out).toEqual({ greeting: 'hello world' });
    expect(generateStructured).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'anthropic:claude-3-5-sonnet',
      prompt: 'Summarize: long text',
      system: 'You are a assistant',
      maxOutputTokens: 200,
    }));
  });

  it('passes outputSchema through when provided', async () => {
    generateStructured.mockResolvedValue({ value: { ok: true }, attempts: 1 });
    const node: LlmNode = {
      id: 'extract',
      type: 'llm',
      model: 'openai:gpt-4o',
      prompt: 'do it',
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      maxOutputTokens: 100,
    };
    await executeLlm(args(node));
    expect(generateStructured).toHaveBeenCalledWith(expect.objectContaining({
      outputSchema: node.outputSchema,
    }));
  });

  it('rejects nodes without a configured model', async () => {
    const node: LlmNode = { id: 'extract', type: 'llm', prompt: 'do it', maxOutputTokens: 100 };
    await expect(executeLlm(args(node))).rejects.toThrow(/no model configured/);
  });

  it('returns the adapter value unchanged', async () => {
    generateStructured.mockResolvedValue({ value: [1, 2, 3], attempts: 1 });
    const node: LlmNode = {
      id: 'extract',
      type: 'llm',
      model: 'google:gemini-2.0-flash',
      prompt: 'list',
      maxOutputTokens: 100,
    };
    expect(await executeLlm(args(node))).toEqual([1, 2, 3]);
  });
});
