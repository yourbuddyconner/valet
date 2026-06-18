import type { WorkflowDefinition, WorkflowInputDefinition } from '@valet/shared';

export interface ManualWorkflowInputField {
  name: string;
  spec: WorkflowInputDefinition;
  value: string | boolean;
}

export interface ManualWorkflowForm {
  triggerDataText: string;
  inputs: Record<string, ManualWorkflowInputField>;
}

export type ManualWorkflowSubmission =
  | {
      ok: true;
      triggerData: Record<string, unknown>;
      inputs: Record<string, unknown>;
    }
  | {
      ok: false;
      fieldErrors: Record<string, string>;
    };

export function createManualWorkflowForm(definition: WorkflowDefinition | null): ManualWorkflowForm {
  const fields: Record<string, ManualWorkflowInputField> = {};
  for (const [name, spec] of Object.entries(definition?.inputs ?? {})) {
    fields[name] = {
      name,
      spec,
      value: createInitialInputValue(spec),
    };
  }

  return {
    triggerDataText: '{\n  \n}',
    inputs: fields,
  };
}

export function parseManualWorkflowSubmission(form: ManualWorkflowForm): ManualWorkflowSubmission {
  const fieldErrors: Record<string, string> = {};
  const triggerData = parseTriggerData(form.triggerDataText);
  if (!triggerData.ok) {
    fieldErrors.triggerData = triggerData.message;
  }

  const inputs: Record<string, unknown> = {};
  for (const field of Object.values(form.inputs)) {
    const parsed = parseInputField(field);
    if (!parsed.ok) {
      fieldErrors[field.name] = parsed.message;
      continue;
    }
    if (parsed.include) {
      inputs[field.name] = parsed.value;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    triggerData: triggerData.ok ? triggerData.value : {},
    inputs,
  };
}

function createInitialInputValue(spec: WorkflowInputDefinition): string | boolean {
  if (spec.type === 'boolean') {
    return typeof spec.default === 'boolean' ? spec.default : false;
  }

  if (spec.default === undefined || spec.default === null) {
    return '';
  }

  if (spec.type === 'object' || spec.type === 'array') {
    return JSON.stringify(spec.default, null, 2);
  }

  return String(spec.default);
}

function parseTriggerData(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: {} };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) {
      return { ok: false, message: 'Trigger payload must be a JSON object.' };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, message: 'Trigger payload must be valid JSON.' };
  }
}

function parseInputField(
  field: ManualWorkflowInputField,
): { ok: true; include: boolean; value?: unknown } | { ok: false; message: string } {
  if (field.spec.type === 'boolean') {
    return { ok: true, include: true, value: Boolean(field.value) };
  }

  const value = typeof field.value === 'string' ? field.value : String(field.value);
  const trimmed = value.trim();
  if (!trimmed) {
    if (field.spec.required) return { ok: false, message: 'Required input is missing.' };
    return { ok: true, include: false };
  }

  if (field.spec.type === 'string') {
    return enumResult(field, value);
  }

  if (field.spec.type === 'number') {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return { ok: false, message: 'Enter a valid number.' };
    return enumResult(field, numeric);
  }

  const parsed = parseJsonInput(trimmed);
  if (!parsed.ok) return parsed;

  if (field.spec.type === 'object' && !isRecord(parsed.value)) {
    return { ok: false, message: 'Enter a JSON object.' };
  }

  if (field.spec.type === 'array' && !Array.isArray(parsed.value)) {
    return { ok: false, message: 'Enter a JSON array.' };
  }

  return enumResult(field, parsed.value);
}

function parseJsonInput(text: string): { ok: true; include: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, include: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: 'Enter valid JSON.' };
  }
}

function enumResult(
  field: ManualWorkflowInputField,
  value: unknown,
): { ok: true; include: true; value: unknown } | { ok: false; message: string } {
  if (field.spec.enum && !field.spec.enum.some((allowed) => deepEqual(allowed, value))) {
    return { ok: false, message: 'Value is not in the allowed options.' };
  }
  return { ok: true, include: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
