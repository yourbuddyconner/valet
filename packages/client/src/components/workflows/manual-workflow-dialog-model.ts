import type { WorkflowDefinition, WorkflowInputDefinition } from '@valet/shared';

export interface ManualWorkflowInputField {
  name: string;
  spec: WorkflowInputDefinition;
  value: string | boolean;
}

export interface ManualWorkflowForm {
  triggerDataText: string;
  triggerDataFields: Record<string, ManualWorkflowInputField>;
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

export type WorkflowInputDefinitions = Record<string, WorkflowInputDefinition>;

export function createManualWorkflowForm(definition: WorkflowDefinition | null): ManualWorkflowForm {
  const triggerDataFields: Record<string, ManualWorkflowInputField> = {};
  const triggerNode = definition?.nodes.find((node) => node.type === 'trigger');
  for (const [name, spec] of Object.entries(triggerNode?.dataSchema ?? {})) {
    triggerDataFields[name] = {
      name,
      spec,
      value: createInitialInputValue(spec),
    };
  }

  return {
    triggerDataText: '{\n  \n}',
    triggerDataFields,
    inputs: createWorkflowInputFields(definition?.inputs),
  };
}

export function parseManualWorkflowSubmission(form: ManualWorkflowForm): ManualWorkflowSubmission {
  const fieldErrors: Record<string, string> = {};
  const triggerDataFields = Object.values(form.triggerDataFields);
  const triggerData = triggerDataFields.length > 0
    ? parseTriggerDataFields(triggerDataFields, fieldErrors)
    : parseRawTriggerData(form.triggerDataText, fieldErrors);

  const inputResult = parseWorkflowInputFields(form.inputs);
  let inputs: Record<string, unknown> = {};
  if (!inputResult.ok) {
    Object.assign(fieldErrors, inputResult.fieldErrors);
  } else {
    inputs = inputResult.inputs;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    triggerData,
    inputs,
  };
}

export function createWorkflowInputFields(
  definitions: WorkflowInputDefinitions | undefined,
  values: Record<string, unknown> = {},
): Record<string, ManualWorkflowInputField> {
  const fields: Record<string, ManualWorkflowInputField> = {};
  for (const [name, spec] of Object.entries(definitions ?? {})) {
    fields[name] = {
      name,
      spec,
      value: createInitialInputValue(spec, values[name]),
    };
  }
  return fields;
}

export type WorkflowInputParseResult =
  | {
      ok: true;
      inputs: Record<string, unknown>;
    }
  | {
      ok: false;
      fieldErrors: Record<string, string>;
    };

export function parseWorkflowInputFields(
  fields: Record<string, ManualWorkflowInputField>,
): WorkflowInputParseResult {
  const fieldErrors: Record<string, string> = {};
  const inputs: Record<string, unknown> = {};
  for (const field of Object.values(fields)) {
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

  return { ok: true, inputs };
}

function createInitialInputValue(spec: WorkflowInputDefinition, override?: unknown): string | boolean {
  if (spec.type === 'boolean') {
    if (typeof override === 'boolean') return override;
    return typeof spec.default === 'boolean' ? spec.default : false;
  }

  const value = override ?? spec.default;
  if (value === undefined || value === null) {
    return '';
  }

  if (spec.type === 'object' || spec.type === 'array') {
    return JSON.stringify(value, null, 2);
  }

  return String(value);
}

function parseRawTriggerData(text: string, fieldErrors: Record<string, string>): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) {
      fieldErrors.triggerData = 'Trigger payload must be a JSON object.';
      return {};
    }
    return parsed;
  } catch {
    fieldErrors.triggerData = 'Trigger payload must be valid JSON.';
    return {};
  }
}

function parseTriggerDataFields(
  fields: ManualWorkflowInputField[],
  fieldErrors: Record<string, string>,
): Record<string, unknown> {
  const triggerData: Record<string, unknown> = {};
  for (const field of fields) {
    const parsed = parseInputField(field);
    if (!parsed.ok) {
      fieldErrors[`triggerData.${field.name}`] = parsed.message;
      continue;
    }
    if (parsed.include) {
      triggerData[field.name] = parsed.value;
    }
  }
  return triggerData;
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
