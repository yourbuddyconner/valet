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
    'agent', 'agent_message', 'agent_prompt', 'tool', 'bash', 'conditional', 'loop', 'parallel', 'subworkflow', 'approval',
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
  }

  if (normalizedType === 'agent_message') {
    const content =
      (typeof stepValue.content === 'string' ? stepValue.content : '') ||
      (typeof stepValue.message === 'string' ? stepValue.message : '') ||
      (typeof stepValue.goal === 'string' ? stepValue.goal : '');
    if (!content.trim()) {
      errors.push({ message: 'agent_message step requires content (content, message, or goal)', path });
    }

    if (stepValue.interrupt !== undefined && typeof stepValue.interrupt !== 'boolean') {
      errors.push({ message: 'agent_message.interrupt must be a boolean', path: `${path}.interrupt` });
    }

    if (stepValue.thread !== undefined && typeof stepValue.thread !== 'string') {
      errors.push({ message: 'agent_message.thread must be a string', path: `${path}.thread` });
    }

    const awaitResponseValue =
      stepValue.await_response !== undefined
        ? stepValue.await_response
        : stepValue.awaitResponse;
    if (awaitResponseValue !== undefined && typeof awaitResponseValue !== 'boolean') {
      errors.push({ message: 'agent_message.await_response must be a boolean', path: `${path}.await_response` });
    }

    const awaitTimeoutValue =
      stepValue.await_timeout_ms !== undefined
        ? stepValue.await_timeout_ms
        : stepValue.awaitTimeoutMs;
    if (
      awaitTimeoutValue !== undefined &&
      (typeof awaitTimeoutValue !== 'number' || !Number.isFinite(awaitTimeoutValue) || awaitTimeoutValue < 1_000)
    ) {
      errors.push({ message: 'agent_message.await_timeout_ms must be a number >= 1000', path: `${path}.await_timeout_ms` });
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
