import { describe, expect, it } from 'vitest';
import { getCustomModelCandidate, type FlatModel } from './model-preferences-utils';

const knownModels: FlatModel[] = [
  { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'Anthropic' },
  { id: 'openai/gpt-5.1', name: 'GPT-5.1', provider: 'OpenAI' },
];

describe('model preference settings helpers', () => {
  it('allows adding a typed provider/model ID that is not in the discovered catalog', () => {
    expect(
      getCustomModelCandidate({
        query: ' openrouter/qwen/qwen3-coder ',
        selectedModelIds: [],
        knownModels,
      })
    ).toBe('openrouter/qwen/qwen3-coder');
  });

  it('does not offer custom IDs that are already selected or already known', () => {
    expect(
      getCustomModelCandidate({
        query: 'openrouter/qwen/qwen3-coder',
        selectedModelIds: ['openrouter/qwen/qwen3-coder'],
        knownModels,
      })
    ).toBeNull();

    expect(
      getCustomModelCandidate({
        query: 'openai/gpt-5.1',
        selectedModelIds: [],
        knownModels,
      })
    ).toBeNull();
  });

  it('requires a provider/model-shaped ID to avoid turning normal searches into custom entries', () => {
    expect(
      getCustomModelCandidate({
        query: 'Claude Sonnet',
        selectedModelIds: [],
        knownModels,
      })
    ).toBeNull();
  });
});
