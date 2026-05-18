export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const ALLOWED_OUTPUT_SCHEMA_TYPES = ['string', 'number', 'boolean', 'array', 'object'] as const;
const FIELD_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateOutputSchema(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }

  for (const [fieldName, fieldDef] of Object.entries(value)) {
    const fieldPath = `${path}.${fieldName}`;
    if (!FIELD_NAME_REGEX.test(fieldName)) {
      errors.push(
        `${fieldPath} field name must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`,
      );
    }
    if (!isRecord(fieldDef)) {
      errors.push(`${fieldPath} must be an object`);
      continue;
    }
    const fieldType = fieldDef.type;
    if (typeof fieldType !== 'string') {
      errors.push(`${fieldPath}.type is required`);
    } else if (!ALLOWED_OUTPUT_SCHEMA_TYPES.includes(fieldType as typeof ALLOWED_OUTPUT_SCHEMA_TYPES[number])) {
      errors.push(
        `${fieldPath}.type must be one of: ${ALLOWED_OUTPUT_SCHEMA_TYPES.join(', ')}`,
      );
    }
    if (fieldDef.description !== undefined && typeof fieldDef.description !== 'string') {
      errors.push(`${fieldPath}.description must be a string`);
    }
  }
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

  if (normalizedType === 'agent' || normalizedType === 'subworkflow') {
    errors.push(
      `${path}.type "${normalizedType}" is no longer supported. Use agent_prompt instead of agent; inline child steps instead of subworkflow.`,
    );
  }

  if (normalizedType === 'agent_message') {
    errors.push(
      `${path}.type "agent_message" is no longer supported. Use 'agent_prompt' to capture an agent's reply, or 'notify' to send a prompt to the orchestrator.`,
    );
  }

  if (normalizedType === 'loop') {
    if (typeof step.over !== 'string' || !step.over.trim()) {
      errors.push(`${path}.over is required (string path to an array, e.g. "outputs.list")`);
    }
    if (
      step.itemVar !== undefined &&
      (typeof step.itemVar !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(step.itemVar))
    ) {
      errors.push(`${path}.itemVar must be a valid identifier`);
    }
    if (
      step.indexVar !== undefined &&
      (typeof step.indexVar !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(step.indexVar))
    ) {
      errors.push(`${path}.indexVar must be a valid identifier`);
    }
    const childSteps = step.steps;
    if (!Array.isArray(childSteps) || childSteps.length === 0) {
      errors.push(`${path}.steps must be a non-empty array (loop body)`);
    }
  }

  if (normalizedType === 'agent_prompt') {
    const content =
      (typeof step.content === 'string' ? step.content : '') ||
      (typeof step.message === 'string' ? step.message : '') ||
      (typeof step.goal === 'string' ? step.goal : '') ||
      (typeof step.prompt === 'string' ? step.prompt : '');
    if (!content.trim()) {
      errors.push(
        `${path} requires content (content, message, goal, or prompt) for ${normalizedType} steps`,
      );
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

    if (step.thread !== undefined && typeof step.thread !== 'string') {
      errors.push(`${path}.thread must be a string`);
    }

    if (step.outputSchema !== undefined) {
      validateOutputSchema(step.outputSchema, `${path}.outputSchema`, errors);
    }
  }

  if (normalizedType === 'notify') {
    if (typeof step.content !== 'string' || !step.content.trim()) {
      errors.push(`${path}.content is required for notify steps`);
    }
    if (step.target !== undefined && step.target !== 'orchestrator') {
      errors.push(`${path}.target must be 'orchestrator' (only supported target in v1)`);
    }
  }

  if (normalizedType === 'conditional') {
    const condition = step.condition;
    // Shape-only check here — the runner's compiler does full expression-syntax validation
    // (see packages/runner/src/workflow-condition.ts). We just require a usable shape.
    if (condition === undefined || condition === null) {
      errors.push(`${path}.condition is required for conditional steps (string expression or boolean)`);
    } else if (typeof condition === 'string') {
      if (!condition.trim()) {
        errors.push(`${path}.condition string must not be empty`);
      }
    } else if (typeof condition !== 'boolean' && !isRecord(condition)) {
      errors.push(
        `${path}.condition must be a string expression, boolean, or legacy { variable, equals } object`,
      );
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

  // Top-level optional `failureNotify` — controls auto-notification of the user's
  // orchestrator agent when a non-manual execution fails. Defaults to 'orchestrator'
  // when absent. Only accept the documented values to avoid silent typos.
  if (value.failureNotify !== undefined) {
    if (value.failureNotify !== 'orchestrator' && value.failureNotify !== 'none') {
      errors.push(`workflow.failureNotify must be 'orchestrator' or 'none'`);
    }
  }

  for (let i = 0; i < steps.length; i += 1) {
    validateStep(steps[i], `workflow.steps[${i}]`, errors);
  }

  return { valid: errors.length === 0, errors };
}
