import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@valet/shared';
import {
  createManualWorkflowForm,
  createWorkflowInputFields,
  parseManualWorkflowSubmission,
  parseWorkflowInputFields,
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
    expect(form.triggerDataFields).toEqual({});
    expect(form.inputs).toMatchObject({
      name: { value: 'Conner' },
      priority: { value: '3' },
      approved: { value: true },
      config: { value: '{\n  "region": "us-east-1"\n}' },
      tags: { value: '[\n  "vip"\n]' },
      optional: { value: '' },
    });
  });

  it('creates workflow input fields from existing scheduled trigger values', () => {
    const fields = createWorkflowInputFields(definition.inputs, {
      name: 'Scheduled run',
      priority: 8,
      approved: false,
      config: { region: 'eu-west-1' },
      tags: ['nightly', 'ops'],
    });

    expect(fields).toMatchObject({
      name: { value: 'Scheduled run' },
      priority: { value: '8' },
      approved: { value: false },
      config: { value: '{\n  "region": "eu-west-1"\n}' },
      tags: { value: '[\n  "nightly",\n  "ops"\n]' },
      optional: { value: '' },
    });
  });

  it('parses workflow input fields without trigger data', () => {
    const fields = createWorkflowInputFields(definition.inputs);
    fields.name.value = 'Scheduled run';
    fields.priority.value = '8';
    fields.approved.value = false;
    fields.config.value = '{ "region": "eu-west-1" }';
    fields.tags.value = '["nightly", "ops"]';

    const parsed = parseWorkflowInputFields(fields);

    expect(parsed).toEqual({
      ok: true,
      inputs: {
        name: 'Scheduled run',
        priority: 8,
        approved: false,
        config: { region: 'eu-west-1' },
        tags: ['nightly', 'ops'],
      },
    });
  });

  it('creates typed trigger data fields from the trigger data schema', () => {
    const form = createManualWorkflowForm({
      version: 'dag/v1',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          dataSchema: {
            email: { type: 'string', required: true, description: 'Customer email' },
            plan: { type: 'string', default: 'free', enum: ['free', 'enterprise'] },
            retries: { type: 'number', default: 2 },
            metadata: { type: 'object', default: { source: 'website' } },
          },
        },
      ],
      edges: [],
    });

    expect(form.triggerDataText).toBe('{\n  \n}');
    expect(form.triggerDataFields).toMatchObject({
      email: { value: '' },
      plan: { value: 'free' },
      retries: { value: '2' },
      metadata: { value: '{\n  "source": "website"\n}' },
    });
  });

  it('parses typed trigger data fields into triggerData', () => {
    const form = createManualWorkflowForm({
      version: 'dag/v1',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          dataSchema: {
            email: { type: 'string', required: true },
            plan: { type: 'string', default: 'free' },
            seats: { type: 'number' },
            approved: { type: 'boolean', default: true },
          },
        },
      ],
      edges: [],
    });
    form.triggerDataFields.email.value = 'conner@example.com';
    form.triggerDataFields.seats.value = '12';

    const parsed = parseManualWorkflowSubmission(form);

    expect(parsed).toEqual({
      ok: true,
      triggerData: {
        email: 'conner@example.com',
        plan: 'free',
        seats: 12,
        approved: true,
      },
      inputs: {},
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

  it('reports typed trigger data field errors', () => {
    const form = createManualWorkflowForm({
      version: 'dag/v1',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          dataSchema: {
            email: { type: 'string', required: true },
            count: { type: 'number' },
            profile: { type: 'object' },
          },
        },
      ],
      edges: [],
    });
    form.triggerDataFields.email.value = '';
    form.triggerDataFields.count.value = 'lots';
    form.triggerDataFields.profile.value = '[]';

    const parsed = parseManualWorkflowSubmission(form);

    expect(parsed).toEqual({
      ok: false,
      fieldErrors: {
        'triggerData.email': 'Required input is missing.',
        'triggerData.count': 'Enter a valid number.',
        'triggerData.profile': 'Enter a JSON object.',
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
