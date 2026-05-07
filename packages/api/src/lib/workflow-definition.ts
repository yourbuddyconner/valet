export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateStep(step: unknown, path: string, errors: string[]): void {
  if (!isRecord(step)) {
    errors.push(`${path} must be an object`);
    return;
  }

  const type = step.type;
  if (typeof type !== 'string' || !type.trim()) {
    errors.push(`${path}.type is required`);
  }
  const normalizedType = typeof type === 'string' ? type.trim() : '';

  if (normalizedType === 'agent_message') {
    const content =
      (typeof step.content === 'string' ? step.content : '') ||
      (typeof step.message === 'string' ? step.message : '') ||
      (typeof step.goal === 'string' ? step.goal : '');
    if (!content.trim()) {
      errors.push(`${path} requires content (content, message, or goal) for agent_message steps`);
    }
    if (step.interrupt !== undefined && typeof step.interrupt !== 'boolean') {
      errors.push(`${path}.interrupt must be a boolean`);
    }

    const awaitResponseValue =
      step.await_response !== undefined
        ? step.await_response
        : step.awaitResponse;
    if (awaitResponseValue !== undefined && typeof awaitResponseValue !== 'boolean') {
      errors.push(`${path}.await_response must be a boolean`);
    }

    const awaitTimeoutValue =
      step.await_timeout_ms !== undefined
        ? step.await_timeout_ms
        : step.awaitTimeoutMs;
    if (
      awaitTimeoutValue !== undefined &&
      (typeof awaitTimeoutValue !== 'number' || !Number.isFinite(awaitTimeoutValue) || awaitTimeoutValue < 1000)
    ) {
      errors.push(`${path}.await_timeout_ms must be a number >= 1000`);
    }
  }

  const nestedKeys = ['then', 'else', 'steps'] as const;
  for (const key of nestedKeys) {
    if (!(key in step)) continue;
    const value = step[key];
    if (value == null) continue;
    if (!Array.isArray(value)) {
      errors.push(`${path}.${key} must be an array`);
      continue;
    }

    for (let i = 0; i < value.length; i += 1) {
      validateStep(value[i], `${path}.${key}[${i}]`, errors);
    }
  }
}

export function validateWorkflowDefinition(value: unknown): WorkflowValidationResult {
  if (!isRecord(value)) {
    return { valid: false, errors: ['Workflow definition must be an object'] };
  }

  const steps = value.steps;
  if (!Array.isArray(steps)) {
    return { valid: false, errors: ['workflow.steps must be an array'] };
  }

  if (steps.length === 0) {
    return { valid: false, errors: ['workflow.steps must not be empty'] };
  }

  const errors: string[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    validateStep(steps[i], `workflow.steps[${i}]`, errors);
  }

  return { valid: errors.length === 0, errors };
}
