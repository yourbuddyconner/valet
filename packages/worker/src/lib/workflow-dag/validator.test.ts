import { describe, it, expect } from 'vitest';
import { validateDefinition, validateInputs, validateAgainstEnvironment } from './validator.js';
import type { WorkflowDefinition } from '@valet/shared';
import type { Env } from '../../env.js';

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 'start', type: 'set', values: { hello: 'world' } },
      { id: 'finish', type: 'stop' },
    ],
    edges: [{ from: 'start', to: 'finish' }],
    ...overrides,
  };
}

// Filter out the non-blocking llm_maxoutput_warning (it's an advisory).
function blockingErrors(errs: ReturnType<typeof validateDefinition>) {
  return errs.filter((e) => e.code !== 'llm_maxoutput_warning');
}

describe('validateDefinition', () => {
  it('accepts a simple valid definition', () => {
    expect(blockingErrors(validateDefinition(definition()))).toEqual([]);
  });

  it('is total — returns malformed_definition for non-object input', () => {
    const errs = validateDefinition(null);
    expect(errs.some((e) => e.code === 'malformed_definition')).toBe(true);
    expect(validateDefinition('not-an-object').some((e) => e.code === 'malformed_definition')).toBe(true);
  });

  it('returns malformed_definition when nodes is not an array', () => {
    const errs = validateDefinition({ version: 'dag/v1', edges: [] });
    expect(errs.some((e) => e.code === 'malformed_definition')).toBe(true);
  });

  it('returns malformed_definition when edges is not an array', () => {
    const errs = validateDefinition({ version: 'dag/v1', nodes: [] });
    expect(errs.some((e) => e.code === 'malformed_definition')).toBe(true);
  });

  it('returns malformed_definition for the wrong version', () => {
    const errs = validateDefinition({ version: 'steps/v1', nodes: [], edges: [] });
    expect(errs.some((e) => e.code === 'malformed_definition')).toBe(true);
  });

  it('adds node id and type context to malformed node field messages', () => {
    const errs = validateDefinition({
      version: 'dag/v1',
      nodes: [
        { id: 'start', type: 'trigger' },
        {
          id: 'route',
          type: 'if',
          conditions: [{ left: 'trigger.data.ok', dataType: 'boolean', op: 'equals', right: true }],
        },
      ],
      edges: [],
    });

    expect(errs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'malformed_definition',
        message: expect.stringContaining('nodes.1 (id: "route", type: "if")'),
      }),
    ]));
    expect(errs.map((e) => e.message).join('\n')).toContain('conditions.0.operation');
  });

  it('returns a helpful unknown node type error before node-specific discriminator errors', () => {
    const errs = validateDefinition({
      version: 'dag/v1',
      nodes: [
        { id: 'start', type: 'trigger' },
        { id: 'run_script', type: 'bash', command: 'echo hello', mode: 'start' },
      ],
      edges: [],
    });

    expect(errs).toEqual([
      expect.objectContaining({
        code: 'unknown_node_type',
        path: 'nodes.1.type',
        nodeId: 'run_script',
        message: expect.stringContaining('Unknown node type "bash"'),
      }),
    ]);
    expect(errs[0]!.message).toContain('trigger, llm, tool, set, if, wait, approval, foreach, orchestrator, session, stop');
    expect(errs[0]!.message).not.toContain('mode');
  });

  it('suggests current node type names for legacy aliases', () => {
    const errs = validateDefinition({
      version: 'dag/v1',
      nodes: [{ id: 'ask_agent', type: 'agent_prompt', prompt: 'hello' }],
      edges: [],
    });

    expect(errs).toEqual([
      expect.objectContaining({
        code: 'unknown_node_type',
        message: expect.stringContaining('Did you mean "llm"?'),
      }),
    ]);
  });

  it('returns a helpful unknown foreach body type error', () => {
    const errs = validateDefinition({
      version: 'dag/v1',
      nodes: [
        {
          id: 'each_item',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          body: { id: 'route_item', type: 'if', conditions: [] },
        },
      ],
      edges: [],
    });

    expect(errs).toEqual([
      expect.objectContaining({
        code: 'unknown_foreach_body_type',
        path: 'nodes.0.body.type',
        nodeId: 'route_item',
        message: expect.stringContaining('foreach body type "if" is not allowed'),
      }),
    ]);
    expect(errs[0]!.message).toContain('llm, tool, set, stop, orchestrator, session');
  });

  it('rejects duplicate node IDs', () => {
    const def = definition({
      nodes: [
        { id: 'dup', type: 'set', values: {} },
        { id: 'dup', type: 'stop' },
      ],
      edges: [],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'duplicate_id')).toBe(true);
  });

  it('rejects edges referencing unknown nodes', () => {
    const def = definition({ edges: [{ from: 'start', to: 'missing' }] });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'edge_to_unknown')).toBe(true);
  });

  it('rejects self-loop edges', () => {
    const def = definition({ edges: [{ from: 'start', to: 'start' }] });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'edge_self_loop')).toBe(true);
  });

  it('rejects edges leaving a stop node', () => {
    const def = definition({
      nodes: [
        { id: 'a', type: 'stop' },
        { id: 'b', type: 'set', values: {} },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'edge_from_stop')).toBe(true);
  });

  it('detects cycles', () => {
    const def = definition({
      nodes: [
        { id: 'a', type: 'set', values: {} },
        { id: 'b', type: 'set', values: {} },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'cycle')).toBe(true);
  });

  it('requires fromOutput on edges leaving an if node', () => {
    const def = definition({
      nodes: [
        { id: 'route', type: 'if', conditions: [{ left: 'trigger.data.x', dataType: 'string', operation: 'equals', right: 'a' }] },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'route', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'if_edge_missing_fromOutput')).toBe(true);
  });

  it('rejects fromOutput on edges from non-if nodes', () => {
    const def = definition({
      edges: [{ from: 'start', to: 'finish', fromOutput: 'true' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'fromOutput_on_non_if')).toBe(true);
  });

  it('rejects an unparseable edge when predicate', () => {
    const def = definition({
      edges: [{ from: 'start', to: 'finish', when: 'trigger.data ==' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'edge_when_unparseable')).toBe(true);
  });

  it('flags llm nodes without maxOutputTokens as a non-blocking warning', () => {
    const def = definition({
      nodes: [
        { id: 'extract', type: 'llm', prompt: 'do it' },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'extract', to: 'finish' }],
    });
    const errs = validateDefinition(def);
    expect(errs.some((e) => e.code === 'llm_maxoutput_warning')).toBe(true);
    expect(blockingErrors(errs)).toEqual([]);
  });

  it('rejects wait nodes with unparseable duration', () => {
    const def = definition({
      nodes: [
        { id: 'pause', type: 'wait', mode: 'duration', duration: 'banana' },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'pause', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'wait_duration_unparseable')).toBe(true);
  });

  it('rejects wait durations exceeding the policy ceiling', () => {
    const def = definition({
      nodes: [
        { id: 'pause', type: 'wait', mode: 'duration', duration: '30d' },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'pause', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'wait_duration_exceeds_policy')).toBe(true);
  });

  it('rejects foreach itemAlias shadowing reserved context names', () => {
    const def = definition({
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          itemAlias: 'trigger',
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'foreach_alias_shadows_reserved')).toBe(true);
  });

  it('rejects foreach aliases that collide', () => {
    const def = definition({
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          itemAlias: 'x',
          indexAlias: 'x',
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'foreach_aliases_collide')).toBe(true);
  });

  it('rejects two foreach nodes that share a body id (step.do cache key collision)', () => {
    const def = definition({
      nodes: [
        {
          id: 'loop_a',
          type: 'foreach',
          items: '{{trigger.data.a}}',
          body: { id: 'send', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} },
        },
        {
          id: 'loop_b',
          type: 'foreach',
          items: '{{trigger.data.b}}',
          body: { id: 'send', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'loop_a', to: 'loop_b' },
        { from: 'loop_b', to: 'finish' },
      ],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'duplicate_id')).toBe(true);
  });

  it('rejects an edge that targets a foreach body id (runtime cannot execute body nodes as graph nodes)', () => {
    const def = definition({
      nodes: [
        { id: 'start', type: 'set', values: { x: 1 } },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          body: { id: 'inner_send', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'start', to: 'loop' },
        // illegal: edge points into a foreach body — runtime's compile()
        // only registers def.nodes, so this would silently orphan finish.
        { from: 'inner_send', to: 'finish' },
      ],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'edge_from_unknown')).toBe(true);
  });

  it('rejects an edge that starts from a foreach body id', () => {
    const def = definition({
      nodes: [
        { id: 'start', type: 'set', values: { x: 1 } },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          body: { id: 'inner_send', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'start', to: 'loop' },
        { from: 'loop', to: 'inner_send' },
        { from: 'inner_send', to: 'finish' },
      ],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'edge_to_unknown')).toBe(true);
    expect(errs.some((e) => e.code === 'edge_from_unknown')).toBe(true);
  });

  it('rejects a foreach body id that collides with a top-level node id', () => {
    const def = definition({
      nodes: [
        { id: 'send', type: 'set', values: { x: 1 } },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          body: { id: 'send', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'send', to: 'loop' },
        { from: 'loop', to: 'finish' },
      ],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'duplicate_id')).toBe(true);
  });

  it('rejects session.prompt with both threadId and forceNewThread', () => {
    const def = definition({
      nodes: [
        {
          id: 's',
          type: 'session',
          mode: 'prompt',
          sessionId: '{{nodes.a.data.sessionId}}',
          prompt: 'hello',
          threadId: 't1',
          forceNewThread: true,
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 's', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'session_thread_targeting_xor')).toBe(true);
  });

  it('rejects malformed template at validation time', () => {
    const def = definition({
      nodes: [
        { id: 'notify', type: 'orchestrator', prompt: 'hello {{broken' },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'notify', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'template_parse_error')).toBe(true);
  });

  it('suggests bracket notation when dot notation references a hyphenated node id', () => {
    const def = definition({
      nodes: [
        { id: 'normalize-input', type: 'set', values: { email: 'a@example.com' } },
        { id: 'finish', type: 'stop', output: '{{nodes.normalize-input.data.email}}' },
      ],
      edges: [{ from: 'normalize-input', to: 'finish' }],
    });

    const errs = blockingErrors(validateDefinition(def));
    expect(errs).toEqual([
      expect.objectContaining({
        code: 'template_parse_error',
        nodeId: 'finish',
        message: expect.stringContaining('nodes["normalize-input"]'),
      }),
    ]);
  });

  it('accepts bracket notation references to hyphenated node ids', () => {
    const def = definition({
      nodes: [
        { id: 'normalize-input', type: 'set', values: { email: 'a@example.com' } },
        { id: 'finish', type: 'stop', output: '{{nodes["normalize-input"].data.email}}' },
      ],
      edges: [{ from: 'normalize-input', to: 'finish' }],
    });

    expect(blockingErrors(validateDefinition(def))).toEqual([]);
  });
});

describe('validateInputs', () => {
  it('accepts when all required inputs are present with correct types', () => {
    const def = definition({
      inputs: {
        target: { type: 'string', required: true },
        priority: { type: 'number' },
      },
    });
    const result = validateInputs(def, { target: 'urgent', priority: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.inputs).toEqual({ target: 'urgent', priority: 5 });
  });

  it('applies defaults for missing optional inputs', () => {
    const def = definition({
      inputs: { tag: { type: 'string', default: 'free' } },
    });
    const result = validateInputs(def, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.inputs.tag).toBe('free');
  });

  it('rejects missing required input', () => {
    const def = definition({
      inputs: { target: { type: 'string', required: true } },
    });
    const result = validateInputs(def, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.code).toBe('input_required_missing');
    }
  });

  it('rejects type mismatch', () => {
    const def = definition({
      inputs: { count: { type: 'number' } },
    });
    const result = validateInputs(def, { count: 'not-a-number' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.code).toBe('input_type_mismatch');
    }
  });

  it('rejects values not in declared enum', () => {
    const def = definition({
      inputs: { priority: { type: 'string', enum: ['low', 'high'] } },
    });
    const result = validateInputs(def, { priority: 'medium' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.code).toBe('input_not_in_enum');
    }
  });

  it('rejects inputs not declared in the schema (catches typos in trigger payload)', () => {
    const def = definition({ inputs: { target: { type: 'string' } } });
    const result = validateInputs(def, { target: 'x', prioirty: 'high' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'input_unknown' && e.inputName === 'prioirty')).toBe(true);
    }
  });

  it('rejects enum members with deep object equality (not reference equality)', () => {
    const def = definition({
      inputs: { config: { type: 'object', enum: [{ a: 1, nested: { b: 2 } }] } },
    });
    const okResult = validateInputs(def, { config: { a: 1, nested: { b: 2 } } });
    expect(okResult.ok).toBe(true);
    const failResult = validateInputs(def, { config: { a: 1, nested: { b: 3 } } });
    expect(failResult.ok).toBe(false);
  });
});

describe('validateDefinition — if matchesRegex compiles', () => {
  it('rejects an if node whose matchesRegex pattern is not a valid regex', () => {
    const def = definition({
      nodes: [
        { id: 'route', type: 'if', conditions: [{ left: 'trigger.x', dataType: 'string', operation: 'matchesRegex', right: '(unclosed' }] },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'route', to: 'finish', fromOutput: 'true' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'invalid_regex')).toBe(true);
  });
});

describe('validateAgainstEnvironment', () => {
  it('is total — returns empty array for malformed shapes', () => {
    expect(validateAgainstEnvironment(null, {} as Env)).toEqual([]);
    expect(validateAgainstEnvironment({ version: 'dag/v1' }, {} as Env)).toEqual([]);
  });

  it('rejects llm nodes whose provider has no configured API key', () => {
    const def = definition({
      nodes: [
        { id: 'extract', type: 'llm', model: 'anthropic:claude-3-5-sonnet', prompt: 'do it', maxOutputTokens: 100 },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'extract', to: 'finish' }],
    });
    const errs = validateAgainstEnvironment(def, {} as Env);
    expect(errs.some((e) => e.code === 'llm_provider_key_missing')).toBe(true);
  });

  it('passes when the right env key is set', () => {
    const def = definition({
      nodes: [
        { id: 'extract', type: 'llm', model: 'openai:gpt-4o', prompt: 'do it', maxOutputTokens: 100 },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'extract', to: 'finish' }],
    });
    const errs = validateAgainstEnvironment(def, { OPENAI_API_KEY: 'sk-...' } as Env);
    expect(errs).toEqual([]);
  });

  it('rejects llm nodes whose model id is malformed', () => {
    const def = definition({
      nodes: [
        { id: 'extract', type: 'llm', model: 'no-prefix', prompt: 'do it', maxOutputTokens: 100 },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'extract', to: 'finish' }],
    });
    const errs = validateAgainstEnvironment(def, {} as Env);
    expect(errs.some((e) => e.code === 'llm_model_id_invalid')).toBe(true);
  });

  it('descends into foreach bodies for env checks', () => {
    const def = definition({
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.items}}',
          body: { id: 'inner', type: 'llm', model: 'anthropic:claude-3-5-sonnet', prompt: 'x', maxOutputTokens: 50 },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'finish' }],
    });
    const errs = validateAgainstEnvironment(def, {} as Env);
    expect(errs.some((e) => e.code === 'llm_provider_key_missing' && e.nodeId === 'inner')).toBe(true);
  });
});

describe('validateDefinition — body-level templates and per-node baseline', () => {
  it('surfaces a foreach body llm template parse error', () => {
    const def = definition({
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          body: { id: 'inner', type: 'llm', prompt: 'tell me about {{broken', maxOutputTokens: 100 },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'template_parse_error' && e.nodeId === 'inner')).toBe(true);
  });

  it('rejects expressions with empty bracket subscript like nodes.x[]', () => {
    const def = definition({
      nodes: [
        { id: 'route', type: 'if', conditions: [{ left: 'nodes.x[]', dataType: 'string', operation: 'equals', right: 'a' }] },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'route', to: 'finish', fromOutput: 'true' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'expression_parse_error')).toBe(true);
  });
});
