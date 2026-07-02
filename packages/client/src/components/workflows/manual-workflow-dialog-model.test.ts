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
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        dataSchema: {
          name: { type: 'string', required: true, default: 'Conner' },
          priority: { type: 'number', default: 3 },
          approved: { type: 'boolean', default: true },
          config: { type: 'object', default: { region: 'us-east-1' } },
          tags: { type: 'array', default: ['vip'] },
          optional: { type: 'string' },
        },
      },
    ],
    edges: [],
  };
  const triggerSchema = definition.nodes[0]?.type === 'trigger' ? definition.nodes[0].dataSchema : undefined;

  it('creates form values from declared trigger parameter defaults', () => {
    const form = createManualWorkflowForm(definition);

    expect(form.triggerDataText).toBe('{\n  \n}');
    expect(form.triggerDataFields).toMatchObject({
      name: { value: 'Conner' },
      priority: { value: '3' },
      approved: { value: true },
      config: { value: '{\n  "region": "us-east-1"\n}' },
      tags: { value: '[\n  "vip"\n]' },
      optional: { value: '' },
    });
  });

  it('creates trigger parameter fields from existing scheduled trigger values', () => {
    const fields = createWorkflowInputFields(triggerSchema, {
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

  it('parses trigger parameter fields for scheduled runs', () => {
    const fields = createWorkflowInputFields(triggerSchema);
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
    const form = createManualWorkflowForm(definition);
    form.triggerDataFields.priority.value = '5';
    form.triggerDataFields.config.value = '{ "region": "eu-west-1" }';
    form.triggerDataFields.tags.value = '["enterprise", "trial"]';
    const parsed = parseManualWorkflowSubmission(form);

    expect(parsed).toEqual({
      ok: true,
      triggerData: {
        name: 'Conner',
        priority: 5,
        approved: true,
        config: { region: 'eu-west-1' },
        tags: ['enterprise', 'trial'],
      },
    });
  });

  it('parses raw trigger data when no trigger schema is declared', () => {
    const form = createManualWorkflowForm({ version: 'dag/v1', nodes: [], edges: [] });
    form.triggerDataText = '{ "email": "conner@example.com" }';

    const parsed = parseManualWorkflowSubmission(form);

    expect(parsed).toEqual({
      ok: true,
      triggerData: { email: 'conner@example.com' },
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

  it('omits blank optional trigger parameters', () => {
    const form = createManualWorkflowForm(definition);
    form.triggerDataFields.optional.value = '';

    const parsed = parseManualWorkflowSubmission(form);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.triggerData).not.toHaveProperty('optional');
    }
  });

  it('reports invalid trigger JSON when no trigger schema is declared', () => {
    const form = createManualWorkflowForm({ version: 'dag/v1', nodes: [], edges: [] });
    form.triggerDataText = '[';

    const parsed = parseManualWorkflowSubmission(form);

    expect(parsed).toEqual({
      ok: false,
      fieldErrors: {
        triggerData: 'Trigger payload must be valid JSON.',
      },
    });
  });
});
