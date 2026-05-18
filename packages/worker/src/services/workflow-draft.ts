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

CRITICAL: The Valet agent inside a workflow CANNOT ask the user clarifying questions. There is no UI for the workflow to receive answers. Do NOT generate agent_prompt steps that tell the agent to ask the user something. Instead:
- Use outputSchema when you need structured data from the agent.
- Use approval steps when you need a human checkpoint with optional reason text.
- Use trigger variables when the user should supply input before the workflow runs.

A WorkflowStep is one of these types: agent_prompt, notify, tool, bash, conditional, parallel, loop, approval.
Common fields: id (kebab-case), name (human), type, outputVariable (optional), thread (optional, only on agent_prompt).

Template interpolation: any \`content\`, \`prompt\`, \`command\`, \`condition\`, or string-valued \`arguments\` field can include \`{{variables.<name>}}\` or \`{{outputs.<stepOutputVariable>.<field>}}\` tokens. The runner resolves these at execution time against trigger variables and prior step outputs. Use this to flow data through the workflow without inlining values.

Type-specific fields:
- bash: { command: string }
- tool: { tool: string, arguments?: object }
- agent_prompt: { prompt: string, awaitTimeoutMs?: number, interrupt?: boolean, outputSchema?: object, thread?: string }
    Use this when you want the Valet agent to do work and capture its reply. The workflow blocks until the agent responds (or awaitTimeoutMs is hit).
    Prefer outputSchema for structured output that later steps reference via \`outputs.<outputVariable>.<field>\`.
    outputSchema shape: { "<fieldName>": { "type": "string"|"number"|"boolean"|"array"|"object", "description": "what this field represents" } }
    The runner enforces the schema and retries the agent with the error if the response is invalid.
- notify: { content: string, target?: 'orchestrator' }
    Sends a prompt to the user's orchestrator agent so it can react to the workflow's result — forward to Slack/Telegram, message the user, take follow-up action, etc. Use this as the FINAL step of most workflows when the user should be informed of the outcome. The content is a self-contained instruction to the orchestrator, e.g. "The morning PR digest workflow found 3 failed runs: {{outputs.digest.summary}}". Fire-and-forget — the workflow does not wait for the orchestrator. Template interpolation is supported.
- agent_message: DEPRECATED — do not generate. Use \`notify\` to inform the orchestrator, or a \`tool\` step with the appropriate channel integration for direct user delivery.
- conditional: { condition: string, then: WorkflowStep[], else?: WorkflowStep[] }
- parallel: { steps: WorkflowStep[] }
- loop: { over: string, steps: WorkflowStep[], itemVar?: string, indexVar?: string }
    Iterates over an array (foreach). \`over\` is a dot-path resolved against execution context, e.g. "outputs.prs.failed" or "variables.targetUsers". Each iteration runs \`steps\` with \`{{loop.item}}\` and \`{{loop.index}}\` available for interpolation. Also accessible as \`{{variables.<itemVar>}}\` if you set custom names. Required: \`over\` and a non-empty \`steps\` body.
- approval: { prompt: string }

The optional \`thread\` field on agent_prompt routes the message to a named thread within the workflow execution. Omit it to use a single shared thread for the whole workflow. Use distinct thread names like "researcher" or "writer" to give different agents their own context. Use the literal value "@new" to spawn a fresh thread for that step (useful inside parallel branches or loops where each iteration needs isolation).

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
  // Accept any object shape — baseDraft is serialized into the LLM context as JSON,
  // and the caller validates the LLM's output rigorously via validateWorkflowDefinition.
  baseDraft?: Record<string, unknown>;
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
