import { describe, it, expect } from 'vitest';
import { lintTemplateReferences, TEMPLATE_UNKNOWN_VARIABLE_CODE } from './template-lint.js';
import type { WorkflowDefinition } from '@valet/shared';

function def(nodes: WorkflowDefinition['nodes'], edges: WorkflowDefinition['edges'] = []): WorkflowDefinition {
  return { version: 'dag/v1', nodes, edges };
}

function codesFor(errs: ReturnType<typeof lintTemplateReferences>): string[] {
  return errs.map((e) => `${e.nodeId}:${e.path}:${e.message}`);
}

describe('lintTemplateReferences', () => {
  it('warns on trigger.data.<field> when trigger has no dataSchema', () => {
    const errs = lintTemplateReferences(def([
      { id: 'trigger', type: 'trigger' },
      {
        id: 'today_cal',
        type: 'tool',
        service: 'google_calendar',
        action: 'calendar.list_events',
        params: {
          timeMin: '{{trigger.data.todayStart}}',
          timeMax: '{{trigger.data.todayEnd}}',
        },
      },
    ]));

    expect(errs).toHaveLength(2);
    expect(errs[0]).toMatchObject({
      scope: 'field',
      nodeId: 'today_cal',
      path: 'params',
      code: TEMPLATE_UNKNOWN_VARIABLE_CODE,
    });
    expect(errs[0]!.message).toContain('trigger.data.todayStart');
    expect(errs[0]!.message).toContain('declare one on the trigger node');
  });

  it('accepts trigger.data.<field> when declared in the trigger dataSchema', () => {
    const errs = lintTemplateReferences(def([
      {
        id: 'trigger',
        type: 'trigger',
        dataSchema: {
          todayStart: { type: 'string' },
          todayEnd: { type: 'string' },
        },
      },
      {
        id: 'today_cal',
        type: 'tool',
        service: 'google_calendar',
        action: 'calendar.list_events',
        params: {
          timeMin: '{{trigger.data.todayStart}}',
          timeMax: '{{trigger.data.todayEnd}}',
        },
      },
    ]));

    expect(errs).toEqual([]);
  });

  it('warns on trigger.data.<field> not in dataSchema even when other fields are declared', () => {
    const errs = lintTemplateReferences(def([
      {
        id: 'trigger',
        type: 'trigger',
        dataSchema: { todayStart: { type: 'string' } },
      },
      {
        id: 'today_cal',
        type: 'tool',
        service: 'google_calendar',
        action: 'calendar.list_events',
        params: { timeMin: '{{trigger.data.todayEnd}}' }, // typo, not declared
      },
    ]));

    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain('trigger.data.todayEnd');
    // Hint about declaring the schema should NOT fire when the schema exists.
    expect(errs[0]!.message).not.toContain('declare one on the trigger');
  });

  it('warns on unknown node output references (llm with declared outputSchema)', () => {
    const errs = lintTemplateReferences(def([
      { id: 'trigger', type: 'trigger', dataSchema: { text: { type: 'string' } } },
      {
        id: 'gen',
        type: 'llm',
        model: 'anthropic:claude-sonnet-4-5',
        prompt: 'echo {{trigger.data.text}}',
        outputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      },
      {
        id: 'send',
        type: 'tool',
        service: 'slack',
        action: 'slack.dm_owner',
        params: { text: '{{nodes.gen.data.wrongField}}' },
      },
    ]));

    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ nodeId: 'send', code: TEMPLATE_UNKNOWN_VARIABLE_CODE });
    expect(errs[0]!.message).toContain('nodes.gen.data.wrongField');
  });

  it('accepts references to fields declared in an llm outputSchema', () => {
    const errs = lintTemplateReferences(def([
      { id: 'trigger', type: 'trigger', dataSchema: { text: { type: 'string' } } },
      {
        id: 'gen',
        type: 'llm',
        model: 'anthropic:claude-sonnet-4-5',
        prompt: '{{trigger.data.text}}',
        outputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      },
      {
        id: 'send',
        type: 'tool',
        service: 'slack',
        action: 'slack.dm_owner',
        params: { text: '{{nodes.gen.data.message}}' },
      },
    ]));

    expect(errs).toEqual([]);
  });

  it('tolerates references into tool nodes whose output schema the server does not know', () => {
    // Without tool-catalog wiring the server can't tell if
    // `nodes.today_cal.data.foo` is valid, so it should stay silent
    // rather than false-positive on every real workflow that reads
    // catalog-defined outputs.
    const errs = lintTemplateReferences(def([
      { id: 'trigger', type: 'trigger', dataSchema: { s: { type: 'string' } } },
      {
        id: 'today_cal',
        type: 'tool',
        service: 'google_calendar',
        action: 'calendar.list_events',
        params: { timeMin: '{{trigger.data.s}}' },
      },
      {
        id: 'send',
        type: 'tool',
        service: 'slack',
        action: 'slack.dm_owner',
        params: { text: '{{nodes.today_cal.data.events}}' },
      },
    ]));

    expect(errs).toEqual([]);
  });

  it('checks tool outputs when a schema is supplied via context.toolOutputSchemas', () => {
    const errs = lintTemplateReferences(
      def([
        { id: 'trigger', type: 'trigger', dataSchema: { s: { type: 'string' } } },
        {
          id: 'today_cal',
          type: 'tool',
          service: 'google_calendar',
          action: 'calendar.list_events',
          params: { timeMin: '{{trigger.data.s}}' },
        },
        {
          id: 'send',
          type: 'tool',
          service: 'slack',
          action: 'slack.dm_owner',
          params: { text: '{{nodes.today_cal.data.wrong}}' },
        },
      ]),
      {
        toolOutputSchemas: {
          'google_calendar:calendar.list_events': {
            type: 'object',
            properties: { events: { type: 'array' }, count: { type: 'number' } },
          },
        },
      },
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain('nodes.today_cal.data.wrong');
  });

  it('accepts references to set-node values', () => {
    const errs = lintTemplateReferences(def([
      { id: 'trigger', type: 'trigger' },
      { id: 'consts', type: 'set', values: { channel: 'C123', greeting: 'hi' } },
      {
        id: 'send',
        type: 'tool',
        service: 'slack',
        action: 'slack.send_message',
        params: {
          channel: '{{nodes.consts.data.channel}}',
          text: '{{nodes.consts.data.greeting}}',
        },
      },
    ]));

    expect(errs).toEqual([]);
  });

  it('warns on unknown roots (typos of trigger / nodes)', () => {
    const errs = lintTemplateReferences(def([
      { id: 'trigger', type: 'trigger', dataSchema: { x: { type: 'string' } } },
      {
        id: 'send',
        type: 'tool',
        service: 'slack',
        action: 'slack.send_message',
        params: { text: '{{triggers.data.x}}' }, // triggers, not trigger
      },
    ]));

    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain('root "triggers"');
  });

  it('allows item / index roots (foreach body context)', () => {
    const errs = lintTemplateReferences(def([
      { id: 'trigger', type: 'trigger', dataSchema: { items: { type: 'array' } } },
      {
        id: 'loop',
        type: 'foreach',
        items: '{{trigger.data.items}}',
        body: {
          id: 'send',
          type: 'tool',
          service: 'slack',
          action: 'slack.send_message',
          params: { text: 'item {{index}}: {{item.name}}' },
        },
      },
    ]));

    expect(errs).toEqual([]);
  });

  it('lints template-bearing fields across all node types', () => {
    const errs = lintTemplateReferences(def([
      { id: 'trigger', type: 'trigger' },
      { id: 'llm1', type: 'llm', model: 'anthropic:claude-sonnet-4-5', prompt: '{{trigger.data.a}}' },
      { id: 'appr', type: 'approval', prompt: '{{trigger.data.b}}' },
      { id: 'orch', type: 'orchestrator', prompt: '{{trigger.data.c}}' },
      { id: 'stopnode', type: 'stop', message: '{{trigger.data.d}}' },
    ]));

    const messages = codesFor(errs);
    expect(messages.some((m) => m.includes('trigger.data.a'))).toBe(true);
    expect(messages.some((m) => m.includes('trigger.data.b'))).toBe(true);
    expect(messages.some((m) => m.includes('trigger.data.c'))).toBe(true);
    expect(messages.some((m) => m.includes('trigger.data.d'))).toBe(true);
  });

  it('does not warn on well-known trigger fields', () => {
    const errs = lintTemplateReferences(def([
      { id: 'trigger', type: 'trigger' },
      {
        id: 'send',
        type: 'tool',
        service: 'slack',
        action: 'slack.send_message',
        params: {
          text: 'fired {{trigger.timestamp}} type={{trigger.type}}',
        },
      },
    ]));

    expect(errs).toEqual([]);
  });

  it('skips syntactically-invalid templates (those are parse errors)', () => {
    // parseTemplate throws on `{{ unterminated — the lint should stay
    // silent since the existing validator emits template_parse_error.
    const errs = lintTemplateReferences(def([
      { id: 'trigger', type: 'trigger' },
      {
        id: 'send',
        type: 'tool',
        service: 'slack',
        action: 'slack.send_message',
        params: { text: '{{trigger.data' }, // no closing braces
      },
    ]));

    expect(errs).toEqual([]);
  });
});
