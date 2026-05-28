import { parseCondition } from './workflow-condition.js';
import { validateOutputSchemaShape } from './workflow-structured-output.js';

export interface WorkflowCompileError {
  message: string;
  path?: string;
}

export interface NormalizedWorkflowStep extends Record<string, unknown> {
  id: string;
  type: string;
}

export interface NormalizedWorkflowDefinition extends Record<string, unknown> {
  steps: NormalizedWorkflowStep[];
}

export interface CompileWorkflowResult {
  ok: boolean;
  workflow: NormalizedWorkflowDefinition | null;
  workflowHash: string | null;
  stepOrder: string[];
  errors: WorkflowCompileError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStep(stepValue: unknown, path: string, errors: WorkflowCompileError[]): NormalizedWorkflowStep | null {
  if (!isRecord(stepValue)) {
    errors.push({ message: 'Step must be an object', path });
    return null;
  }

  const type = stepValue.type;
  if (typeof type !== 'string' || !type.trim()) {
    errors.push({ message: 'Step type is required', path: `${path}.type` });
    return null;
  }
  const normalizedType = type.trim();

  const VALID_STEP_TYPES = new Set([
    'agent_prompt', 'notify', 'tool', 'bash', 'conditional', 'loop', 'parallel', 'approval',
  ]);
  if (!VALID_STEP_TYPES.has(normalizedType)) {
    errors.push({
      message: `Unknown step type "${normalizedType}". Valid types: ${[...VALID_STEP_TYPES].join(', ')}`,
      path: `${path}.type`,
    });
    return null;
  }

  if (normalizedType === 'bash') {
    const command = stepValue.command;
    if (typeof command !== 'string' || !command.trim()) {
      errors.push({
        message: 'bash step requires a "command" field (string). Example: { "type": "bash", "command": "echo hello" }',
        path: `${path}.command`,
      });
    }
  }

  if (normalizedType === 'tool') {
    const tool = stepValue.tool;
    if (typeof tool !== 'string' || !tool.trim()) {
      errors.push({
        message: 'tool step requires a "tool" field (string). For bash commands, prefer type: "bash" with a "command" field instead.',
        path: `${path}.tool`,
      });
    }
  }

  if (normalizedType === 'agent_prompt') {
    const content =
      (typeof stepValue.prompt === 'string' ? stepValue.prompt : '') ||
      (typeof stepValue.content === 'string' ? stepValue.content : '') ||
      (typeof stepValue.message === 'string' ? stepValue.message : '') ||
      (typeof stepValue.goal === 'string' ? stepValue.goal : '');
    if (!content.trim()) {
      errors.push({ message: 'agent_prompt step requires a prompt (prompt, content, message, or goal)', path });
    }
    if (stepValue.thread !== undefined && typeof stepValue.thread !== 'string') {
      errors.push({ message: 'agent_prompt.thread must be a string', path: `${path}.thread` });
    }
    if (stepValue.persona !== undefined && typeof stepValue.persona !== 'string') {
      errors.push({ message: 'agent_prompt.persona must be a string (persona id)', path: `${path}.persona` });
    }
    if (stepValue.outputSchema !== undefined) {
      const schemaErrors = validateOutputSchemaShape(stepValue.outputSchema, `${path}.outputSchema`);
      for (const e of schemaErrors) errors.push(e);
    }
  }

  if (normalizedType === 'loop') {
    // Accept two forms: an inline array literal (`over: [1,2,3]`) or a path
    // string (`over: "outputs.list"` / `"variables.items"`).
    const overIsArray = Array.isArray(stepValue.over);
    const overIsNonEmptyString =
      typeof stepValue.over === 'string' && stepValue.over.trim().length > 0;
    if (!overIsArray && !overIsNonEmptyString) {
      errors.push({
        message:
          'loop step requires "over" — either an inline array (e.g. [1,2,3]) or a string path to an array (e.g. "outputs.list" or "variables.items")',
        path: `${path}.over`,
      });
    }
    const itemVar = stepValue.itemVar;
    if (itemVar !== undefined && (typeof itemVar !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(itemVar))) {
      errors.push({ message: 'loop.itemVar must be a valid identifier', path: `${path}.itemVar` });
    }
    const indexVar = stepValue.indexVar;
    if (indexVar !== undefined && (typeof indexVar !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(indexVar))) {
      errors.push({ message: 'loop.indexVar must be a valid identifier', path: `${path}.indexVar` });
    }
    const childSteps = stepValue.steps;
    if (!Array.isArray(childSteps) || childSteps.length === 0) {
      errors.push({
        message: 'loop step requires non-empty "steps" array (body to run per iteration)',
        path: `${path}.steps`,
      });
    }
  }

  if (normalizedType === 'conditional') {
    const condition = stepValue.condition;
    if (condition === undefined || condition === null) {
      errors.push({
        message: 'conditional step requires a "condition" (string expression or boolean)',
        path: `${path}.condition`,
      });
    } else if (typeof condition === 'string') {
      if (!condition.trim()) {
        errors.push({
          message: 'conditional.condition string must not be empty',
          path: `${path}.condition`,
        });
      } else if (!parseCondition(condition)) {
        // Surface syntax errors at compile time so authors don't ship workflows whose
        // conditions silently evaluate to false at runtime.
        errors.push({
          message: `conditional.condition has invalid syntax: ${condition}`,
          path: `${path}.condition`,
        });
      }
    } else if (typeof condition !== 'boolean' && !isRecord(condition)) {
      errors.push({
        message: 'conditional.condition must be a string, boolean, or legacy { variable, equals } object',
        path: `${path}.condition`,
      });
    }
  }

  if (normalizedType === 'notify') {
    if (typeof stepValue.content !== 'string' || !stepValue.content.trim()) {
      errors.push({ message: 'notify step requires content (string)', path: `${path}.content` });
    }
    if (stepValue.target !== undefined && stepValue.target !== 'orchestrator') {
      errors.push({
        message: `notify.target must be 'orchestrator' (only supported target in v1)`,
        path: `${path}.target`,
      });
    }
  }

const providedId = stepValue.id;
  const id = typeof providedId === 'string' && providedId.trim() ? providedId.trim() : path.replace(/\./g, '_');

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stepValue)) {
    if (key === 'then' || key === 'else' || key === 'steps') {
      if (Array.isArray(value)) {
        const nested = value
          .map((entry, index) => normalizeStep(entry, `${path}.${key}[${index}]`, errors))
          .filter((entry): entry is NormalizedWorkflowStep => entry !== null);
        normalized[key] = nested;
      } else if (value !== undefined && value !== null) {
        errors.push({ message: `${key} must be an array`, path: `${path}.${key}` });
      }
      continue;
    }
    normalized[key] = deepSort(value);
  }

  normalized.id = id;
  normalized.type = normalizedType;

  return deepSort(normalized) as NormalizedWorkflowStep;
}

function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => deepSort(item));
  }
  if (!isRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = deepSort(value[key]);
  }
  return out;
}

function collectStepOrder(steps: NormalizedWorkflowStep[], order: string[]): void {
  for (const step of steps) {
    order.push(step.id);

    const branches = ['then', 'else', 'steps'] as const;
    for (const branch of branches) {
      const nested = step[branch];
      if (Array.isArray(nested)) {
        const nestedSteps = nested
          .filter((entry): entry is NormalizedWorkflowStep => isRecord(entry) && typeof entry.id === 'string' && typeof entry.type === 'string')
          .sort((a, b) => a.id.localeCompare(b.id));
        collectStepOrder(nestedSteps, order);
      }
    }
  }
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function compileWorkflowDefinition(workflowValue: unknown): Promise<CompileWorkflowResult> {
  const errors: WorkflowCompileError[] = [];
  if (!isRecord(workflowValue)) {
    return {
      ok: false,
      workflow: null,
      workflowHash: null,
      stepOrder: [],
      errors: [{ message: 'Workflow must be an object', path: 'workflow' }],
    };
  }

  const rootSteps = workflowValue.steps;
  if (!Array.isArray(rootSteps)) {
    return {
      ok: false,
      workflow: null,
      workflowHash: null,
      stepOrder: [],
      errors: [{ message: 'workflow.steps must be an array', path: 'workflow.steps' }],
    };
  }

  const normalizedSteps = rootSteps
    .map((step, index) => normalizeStep(step, `step[${index}]`, errors))
    .filter((step): step is NormalizedWorkflowStep => step !== null);

  if (errors.length > 0) {
    return {
      ok: false,
      workflow: null,
      workflowHash: null,
      stepOrder: [],
      errors,
    };
  }

  const normalizedRoot = {
    ...workflowValue,
    steps: normalizedSteps,
  } satisfies Record<string, unknown>;

  const workflow = deepSort(normalizedRoot) as NormalizedWorkflowDefinition;
  const serialized = JSON.stringify(workflow);
  const digest = await sha256Hex(serialized);
  const stepOrder: string[] = [];
  collectStepOrder(workflow.steps, stepOrder);

  return {
    ok: true,
    workflow,
    workflowHash: `sha256:${digest}`,
    stepOrder,
    errors: [],
  };
}
