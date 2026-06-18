import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@valet/shared';
import {
  createManualWorkflowForm,
  parseManualWorkflowSubmission,
} from './manual-workflow-dialog-model';

describe('manual workflow dialog model', () => {
  const definition: WorkflowDefinition = {
    version: 'dag/v1',
    inputs: {
      name: { type: 'string', required: true, default: 'Conner' },
      priority: { type: 'number', default: 3 },
      approved: { type: 'boolean', default: true },
      config: { type: 'object', default: { region: 'us-east-1' } },
      tags: { type: 'array', default: ['vip'] },
      optional: { type: 'string' },
    },
    nodes: [{ id: 'trigger', type: 'trigger' }],
    edges: [],
  };

  it('creates form values from declared input defaults', () => {
    const form = createManualWorkflowForm(definition);

    expect(form.triggerDataText).toBe('{\n  \n}');
    expect(form.inputs).toMatchObject({
      name: { value: 'Conner' },
      priority: { value: '3' },
      approved: { value: true },
      config: { value: '{\n  "region": "us-east-1"\n}' },
      tags: { value: '[\n  "vip"\n]' },
      optional: { value: '' },
    });
  });

  it('parses trigger data and typed workflow inputs for submission', () => {
    const form = createManualWorkflowForm(definition);
    form.triggerDataText = '{ "email": "conner@example.com" }';
    form.inputs.priority.value = '5';
    form.inputs.config.value = '{ "region": "eu-west-1" }';
    form.inputs.tags.value = '["enterprise", "trial"]';

    const parsed = parseManualWorkflowSubmission(form);

    expect(parsed).toEqual({
      ok: true,
      triggerData: { email: 'conner@example.com' },
      inputs: {
        name: 'Conner',
        priority: 5,
        approved: true,
        config: { region: 'eu-west-1' },
        tags: ['enterprise', 'trial'],
      },
    });
  });

  it('omits blank optional inputs', () => {
    const form = createManualWorkflowForm(definition);
    form.triggerDataText = '{}';
    form.inputs.optional.value = '';

    const parsed = parseManualWorkflowSubmission(form);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.inputs).not.toHaveProperty('optional');
    }
  });

  it('reports invalid trigger JSON and input type errors', () => {
    const form = createManualWorkflowForm(definition);
    form.triggerDataText = '[';
    form.inputs.name.value = '';
    form.inputs.priority.value = 'high';
    form.inputs.config.value = '[]';
    form.inputs.tags.value = '{}';

    const parsed = parseManualWorkflowSubmission(form);

    expect(parsed).toEqual({
      ok: false,
      fieldErrors: {
        triggerData: 'Trigger payload must be valid JSON.',
        name: 'Required input is missing.',
        priority: 'Enter a valid number.',
        config: 'Enter a JSON object.',
        tags: 'Enter a JSON array.',
      },
    });
  });
});
