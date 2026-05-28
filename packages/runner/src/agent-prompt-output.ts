/**
 * Shape of the `output` field on a successfully-completed `agent_prompt` step.
 * Spec: docs/specs/2026-05-23-workflow-ui-design.md (Phase B).
 *
 * `response` carries whatever the agent returned (parsed structured value or
 * bare string). The remaining fields are captured for execution-page rendering:
 * which model ran, how many tokens it spent, and how long it took.
 */
export interface AgentPromptOutput {
  response: unknown;
  /**
   * The RESOLVED prompt actually sent to the agent (interpolation applied,
   * e.g. `{{loop.item}}` → `frontend`). The step's persisted `inputJson`
   * carries the raw template; this carries what the model really saw, so the
   * execution-page card can show the substituted text.
   */
  prompt: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/**
 * Build the typed output payload from the bits the caller already has.
 *
 * Keeping this a pure function (no Channel coupling) lets us regression-test
 * the contract without standing up the full Channel/agent runner machinery —
 * if `prompt.ts` ever drifts from this shape, the wire contract breaks.
 */
export function assembleAgentPromptOutput(args: {
  response: unknown;
  prompt: string;
  newUsageEntries: Iterable<{ inputTokens: number; outputTokens: number }>;
  model: string | null;
  durationMs: number;
}): AgentPromptOutput {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const entry of args.newUsageEntries) {
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
  }
  return {
    response: args.response,
    prompt: args.prompt,
    model: args.model,
    inputTokens,
    outputTokens,
    durationMs: args.durationMs,
  };
}
