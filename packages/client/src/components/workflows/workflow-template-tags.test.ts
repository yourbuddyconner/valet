import { describe, expect, it } from 'vitest';
import type { WorkflowOutputSource } from './workflow-editor-model';
import {
  filterTemplateSuggestions,
  getTemplateCompletionContext,
  insertTemplateExpression,
  validateTemplateTags,
} from './workflow-template-tags';

const sources: WorkflowOutputSource[] = [
  {
    nodeId: 'trigger',
    nodeLabel: 'Trigger',
    actionName: 'Invocation payload',
    path: ['trigger', 'data'],
    expression: '{{trigger.data}}',
    label: 'Trigger data',
    valueType: 'object',
  },
  {
    nodeId: 'lookup',
    nodeLabel: 'Tool',
    actionName: 'List Issues',
    path: ['nodes', 'lookup', 'data', 'issues'],
    expression: '{{nodes.lookup.data.issues}}',
    label: 'lookup issues',
    valueType: 'array',
  },
];

describe('workflow template tags', () => {
  it('detects the active tag query at the cursor', () => {
    expect(getTemplateCompletionContext('Hello {{tri', 11)).toEqual({
      start: 6,
      end: 11,
      query: 'tri',
    });
  });

  it('replaces the active tag with the selected expression', () => {
    const result = insertTemplateExpression({
      value: 'Hello {{tri',
      selectionStart: 11,
      selectionEnd: 11,
      expression: '{{trigger.data}}',
    });

    expect(result.value).toBe('Hello {{trigger.data}}');
    expect(result.cursor).toBe(22);
  });

  it('filters suggestions by label or expression text', () => {
    expect(filterTemplateSuggestions(sources, 'issues').map((source) => source.expression)).toEqual([
      '{{nodes.lookup.data.issues}}',
    ]);
    expect(filterTemplateSuggestions(sources, 'trigger').map((source) => source.expression)).toEqual([
      '{{trigger.data}}',
    ]);
  });

  it('validates unresolved and unclosed template tags', () => {
    expect(validateTemplateTags('Hello {{missing.value}}', sources)).toEqual([
      {
        code: 'unknown_template',
        message: 'Unknown template variable: missing.value',
        expression: 'missing.value',
      },
    ]);

    expect(validateTemplateTags('Hello {{trigger.data', sources)).toEqual([
      {
        code: 'unclosed_template',
        message: 'Template tag is missing closing braces.',
      },
    ]);
  });
});
