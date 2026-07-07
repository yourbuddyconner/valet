import { describe, expect, it } from 'vitest';
import { buildModelSelectorGroups, type ProviderModelGroup } from './model-selector-utils';

const providers: ProviderModelGroup[] = [
  {
    provider: 'Anthropic',
    models: [
      { id: 'anthropic/claude-opus-4-1', name: 'Claude Opus 4.1' },
      { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    ],
  },
  {
    provider: 'OpenAI',
    models: [
      { id: 'openai/gpt-5.1', name: 'GPT-5.1' },
      { id: 'openai/gpt-5.1-codex', name: 'GPT-5.1 Codex' },
    ],
  },
];

describe('model selector grouping', () => {
  it('pins user preferred models above provider groups and removes duplicates below', () => {
    const groups = buildModelSelectorGroups({
      availableModels: providers,
      userModelPreferences: ['openai/gpt-5.1-codex', 'anthropic/claude-sonnet-4-5'],
      orgModelPreferences: ['anthropic/claude-opus-4-1'],
    });

    expect(groups.preferredGroup).toEqual({
      heading: 'Preferred models',
      source: 'user',
      models: [
        { id: 'openai/gpt-5.1-codex', name: 'GPT-5.1 Codex', provider: 'OpenAI' },
        { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'Anthropic' },
      ],
    });
    expect(groups.providerGroups).toEqual([
      {
        provider: 'Anthropic',
        models: [{ id: 'anthropic/claude-opus-4-1', name: 'Claude Opus 4.1' }],
      },
      {
        provider: 'OpenAI',
        models: [{ id: 'openai/gpt-5.1', name: 'GPT-5.1' }],
      },
    ]);
  });

  it('falls back to org preferred models when the user has none', () => {
    const groups = buildModelSelectorGroups({
      availableModels: providers,
      userModelPreferences: [],
      orgModelPreferences: ['anthropic/claude-opus-4-1'],
    });

    expect(groups.preferredGroup).toEqual({
      heading: 'Org default models',
      source: 'org',
      models: [{ id: 'anthropic/claude-opus-4-1', name: 'Claude Opus 4.1', provider: 'Anthropic' }],
    });
    expect(groups.providerGroups[0]?.models).toEqual([
      { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    ]);
  });

  it('ignores stale preferred IDs that are not in the available model catalog', () => {
    const groups = buildModelSelectorGroups({
      availableModels: providers,
      userModelPreferences: ['missing/model', 'openai/gpt-5.1'],
      orgModelPreferences: ['anthropic/claude-opus-4-1'],
    });

    expect(groups.preferredGroup?.models).toEqual([
      { id: 'openai/gpt-5.1', name: 'GPT-5.1', provider: 'OpenAI' },
    ]);
  });
});
