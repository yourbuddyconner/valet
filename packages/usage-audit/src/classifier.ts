import type Anthropic from '@anthropic-ai/sdk';
import type { Classification, ClassifierFn, LabelDimension } from './types.js';

// Model IDs are pinned (vs floating aliases) so reports remain reproducible.
export const MODEL_IDS: Record<'haiku' | 'sonnet', string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
};

export interface ClassifierConfig {
  client: Anthropic;
  // Anthropic SDK has built-in retries; this just lets the caller tune them.
  maxRetries?: number;
}

const SYSTEM_PROMPT = `You are classifying conversations from an internal LLM usage audit. The
audit is investigating which threads burned the most tokens and why.

For each thread, return a structured classification with:
- task_type: what kind of work was happening
- cost_driver: what burned tokens (long tool loop, big context reads, etc.)
- outcome: what the thread produced
- summary: one sentence describing what was actually going on
- confidence: how sure you are

Each label field accepts an open vocabulary. The caller will pass a list of
preferred labels; PREFER those if any fits. Only invent a new label when none
of the preferred ones genuinely fit. Use lowercase kebab-case for new labels.

Be terse. The summary is one sentence, not a paragraph.`;

export function createClassifier(config: ClassifierConfig): ClassifierFn {
  return async ({ digest, preferredLabels, model }) => {
    const modelId = MODEL_IDS[model];
    const tools = buildTools(preferredLabels);

    const response = await config.client.messages.create(
      {
        model: modelId,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        tool_choice: { type: 'tool', name: 'classify_thread' },
        messages: [{ role: 'user', content: digest }],
      },
      { maxRetries: config.maxRetries ?? 5 },
    );

    const toolUse = response.content.find(
      (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use',
    );
    if (!toolUse) {
      throw new Error('classifier: model did not return a tool_use block');
    }
    return parseClassification(toolUse.input);
  };
}

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

function buildTools(preferred: Record<LabelDimension, string[]>): ToolDefinition[] {
  return [
    {
      name: 'classify_thread',
      description:
        'Record the classification of this thread along the four dimensions of the audit.',
      input_schema: {
        type: 'object',
        properties: {
          task_type: {
            type: 'string',
            description:
              `What kind of work the thread was doing. Prefer one of: ` +
              preferred.taskType.join(', ') +
              `. Invent a new lowercase-kebab-case label only if none fit.`,
          },
          cost_driver: {
            type: 'string',
            description:
              `Why the thread burned tokens. Prefer one of: ` +
              preferred.costDriver.join(', ') +
              `. Invent a new lowercase-kebab-case label only if none fit.`,
          },
          outcome: {
            type: 'string',
            description:
              `What the thread produced. Prefer one of: ` +
              preferred.outcome.join(', ') +
              `. Invent a new lowercase-kebab-case label only if none fit.`,
          },
          summary: {
            type: 'string',
            description: 'One sentence describing what was happening in this thread.',
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'How confident you are in this classification.',
          },
        },
        required: ['task_type', 'cost_driver', 'outcome', 'summary', 'confidence'],
      },
    },
  ];
}

export function parseClassification(input: unknown): Classification {
  if (!input || typeof input !== 'object') {
    throw new Error(`classifier: tool input was not an object: ${typeof input}`);
  }
  const obj = input as Record<string, unknown>;

  const taskType = requireString(obj, 'task_type');
  const costDriver = requireString(obj, 'cost_driver');
  const outcome = requireString(obj, 'outcome');
  const summary = requireString(obj, 'summary');
  const confidenceRaw = requireString(obj, 'confidence');
  const confidence =
    confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
      ? confidenceRaw
      : 'low';

  return { taskType, costDriver, outcome, summary, confidence };
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`classifier: missing or empty field "${key}"`);
  }
  return v;
}
