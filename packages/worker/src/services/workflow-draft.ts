import Anthropic from '@anthropic-ai/sdk';

export type WorkflowDraft = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  steps: unknown[];
} & Record<string, unknown>;

const SYSTEM_PROMPT = `You are a workflow drafting assistant for Valet, an automation platform.

Output ONLY a JSON object matching this schema:
{
  "id": "kebab-case-id",
  "name": "Human Name",
  "description": "What this does",
  "steps": [WorkflowStep, ...]
}

A WorkflowStep is one of these types: agent_message, tool, bash, conditional, parallel, loop, subworkflow, approval.
Common fields: id (kebab-case), name (human), type, outputVariable (optional).

Type-specific fields:
- bash: { command: string }
- tool: { tool: string, arguments?: object }
- agent_message: { content: string }
- conditional: { condition: string, then: WorkflowStep[], else?: WorkflowStep[] }
- parallel: { steps: WorkflowStep[] }
- loop: { steps: WorkflowStep[] }
- subworkflow: { steps: WorkflowStep[] }
- approval: { prompt: string }

Respond with the JSON object only — no prose, no markdown fences.`;

export function buildSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

export function extractWorkflowFromResponse(text: string): WorkflowDraft | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as WorkflowDraft;
    } catch {
      // Fall through to fenced-block extraction — model may have wrapped JSON in prose.
    }
  }
  const match = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (match) {
    try {
      return JSON.parse(match[1]) as WorkflowDraft;
    } catch {
      return null;
    }
  }
  return null;
}

export async function draftWorkflow(opts: {
  apiKey: string;
  userPrompt: string;
  baseDraft?: WorkflowDraft;
}): Promise<{ workflow: WorkflowDraft | null; rawResponse: string }> {
  const anthropic = new Anthropic({ apiKey: opts.apiKey });
  const userMessage = opts.baseDraft
    ? `Current draft:\n\`\`\`json\n${JSON.stringify(opts.baseDraft, null, 2)}\n\`\`\`\n\nRefinement: ${opts.userPrompt}\n\nReturn the updated workflow JSON.`
    : opts.userPrompt;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('\n');

  return { workflow: extractWorkflowFromResponse(text), rawResponse: text };
}
