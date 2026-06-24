import type { NodeDocs } from '../docs.js';

export interface LlmNode {
  id: string;
  type: 'llm';
  model?: string;
  system?: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}

export function createDefaultLlmNode(id: string): LlmNode {
  return { id, type: 'llm', prompt: '' };
}

export const llmNodeDocs: NodeDocs<LlmNode> = {
  label: 'LLM',
  description: 'Generate or transform text with a model',
  longDescription: `Calls a chat model (Anthropic, OpenAI, or Google) with the rendered prompt
and returns the response. Use this for text generation, transformation,
classification, summarization, and structured-data extraction.

The prompt supports the standard template syntax — \`\${nodes.<id>.output…}\`,
\`\${trigger.data.<field>}\`, \`\${env.<KEY>}\` — so you can chain nodes together
without writing glue code.

If \`outputSchema\` is set, the model is asked to return JSON matching the
schema and the node's output is the parsed object. Otherwise the output is
the raw string. Use the schema option when downstream nodes need a typed
field rather than free-form text.`,
  fields: {
    model: {
      help: 'Optional. Falls back to the org default LLM key when unset. Use a vendor-prefixed ID (e.g. anthropic/claude-sonnet-4-6) to pin a specific model.',
    },
    outputSchema: {
      help: 'Optional JSON Schema. When set, the model is constrained to JSON matching this shape and the node output is the parsed object rather than a string.',
    },
    temperature: {
      help: 'Lower = more deterministic. Default is the model\'s natural value.',
    },
    maxOutputTokens: {
      help: 'Hard cap on response length. Long completions are truncated, not retried.',
    },
  },
  gotchas: [
    'LLM nodes opt out of step retries. A transient model error fails the run rather than re-running and duplicating billed work.',
    'Inside a foreach body, the same no-retry policy applies — one failed iteration doesn\'t spawn five more model calls.',
  ],
};
