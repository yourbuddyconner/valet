import { describe, it, expect } from 'vitest';

import { validateWorkflowDefinition } from './validate.js';
import type { WorkflowDefinition } from './shape.js';
import type { ToolNode } from './nodes.js';

/** Deliberately-malformed node for linter-behavior tests. The validator's
 * real-world input is LLM-authored JSON, so tests must hand it shapes the
 * WorkflowNode union can't type — same unknown-then-single-cast seam as
 * the api layer's validateDefinitionInput. */
function rawNode(node: unknown): WorkflowDefinition['nodes'][number] {
  return node as WorkflowDefinition['nodes'][number];
}

function definition(overrides: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 'trigger', type: 'trigger' },
      { id: 'set-a', type: 'set', values: { hello: 'world' } },
      { id: 'stop', type: 'stop' },
    ],
    edges: [
      { from: 'trigger', to: 'set-a' },
      { from: 'set-a', to: 'stop' },
    ],
    ...overrides,
  };
}

describe('validateWorkflowDefinition', () => {
  it('accepts a valid fixture', () => {
    const result = validateWorkflowDefinition(definition({}));
    expect(result).toEqual({ ok: true });
  });

  it('rejects duplicate node ids', () => {
    const result = validateWorkflowDefinition(
      definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'set-a', type: 'set', values: {} },
          { id: 'set-a', type: 'set', values: {} },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('duplicate node id'))).toBe(true);
    }
  });

  it('rejects two trigger nodes', () => {
    const result = validateWorkflowDefinition(
      definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'trigger-2', type: 'trigger' },
          { id: 'stop', type: 'stop' },
        ],
        edges: [],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('exactly one trigger node'))).toBe(true);
    }
  });

  it('rejects an edge targeting an unknown node', () => {
    const result = validateWorkflowDefinition(
      definition({
        edges: [
          { from: 'trigger', to: 'set-a' },
          { from: 'set-a', to: 'does-not-exist' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('unknown target node'))).toBe(true);
    }
  });

  it('rejects a cycle', () => {
    const result = validateWorkflowDefinition(
      definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'set-a', type: 'set', values: {} },
          { id: 'set-b', type: 'set', values: {} },
        ],
        edges: [
          { from: 'trigger', to: 'set-a' },
          { from: 'set-a', to: 'set-b' },
          { from: 'set-b', to: 'set-a' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('cycle detected'))).toBe(true);
    }
  });

  it('rejects fromOutput on an edge leaving a non-if/approval node', () => {
    const result = validateWorkflowDefinition(
      definition({
        edges: [
          { from: 'trigger', to: 'set-a' },
          { from: 'set-a', to: 'stop', fromOutput: 'true' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('fromOutput is only valid'))).toBe(true);
    }
  });

  it('allows fromOutput on an edge leaving an if node', () => {
    const result = validateWorkflowDefinition(
      definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          {
            id: 'check',
            type: 'if',
            conditions: [{ left: 'trigger.data.count', dataType: 'number', operation: 'greaterThan', right: 0 }],
          },
          { id: 'stop', type: 'stop' },
        ],
        edges: [
          { from: 'trigger', to: 'check' },
          { from: 'check', to: 'stop', fromOutput: 'true' },
        ],
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects an unparseable wait.duration', () => {
    const result = validateWorkflowDefinition(
      definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'pause', type: 'wait', mode: 'duration', duration: 'not-a-duration' },
          { id: 'stop', type: 'stop' },
        ],
        edges: [
          { from: 'trigger', to: 'pause' },
          { from: 'pause', to: 'stop' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('unparseable wait.duration'))).toBe(true);
    }
  });

  it('rejects an unsupported node type', () => {
    // Definitions the validator sees at runtime come from storage/JSON, not
    // the type checker, so a definition containing a legacy/unsupported
    // node type is exactly what the runtime guard exists to catch. Round-trip
    // through JSON (as real callers would) and narrow with a single
    // assertion rather than fighting the literal union at the call site.
    const raw: WorkflowDefinition = JSON.parse(
      JSON.stringify({
        version: 'dag/v1',
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'legacy', type: 'legacy-node-type' },
          { id: 'stop', type: 'stop' },
        ],
        edges: [
          { from: 'trigger', to: 'legacy' },
          { from: 'legacy', to: 'stop' },
        ],
      }),
    ) as WorkflowDefinition;

    const result = validateWorkflowDefinition(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('unsupported node type'))).toBe(true);
    }
  });

  it('accepts a valid fixture including a `ui` field', () => {
    const result = validateWorkflowDefinition(
      definition({
        ui: {
          nodes: {
            trigger: { position: { x: 0, y: 0 } },
            'set-a': { position: { x: 260, y: 0 } },
            stop: { position: { x: 520, y: 0 } },
          },
          viewport: { x: 0, y: 0, zoom: 1 },
        },
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects session wait.timeout', () => {
    const result = validateWorkflowDefinition(
      definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          {
            id: 'sess',
            type: 'session',
            mode: 'start',
            prompt: 'do it',
            wait: { mode: 'until_idle', timeout: '5m' },
          },
          { id: 'stop', type: 'stop' },
        ],
        edges: [
          { from: 'trigger', to: 'sess' },
          { from: 'sess', to: 'stop' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('session wait.timeout is not implemented — omit it'))).toBe(true);
    }
  });

  describe('trigger node dataSchema', () => {
    function triggerDefinition(trigger: Record<string, unknown>): WorkflowDefinition {
      return definition({
        nodes: [
          rawNode(trigger),
          { id: 'set-a', type: 'set', values: { hello: 'world' } },
          { id: 'stop', type: 'stop' },
        ],
      });
    }

    it('accepts a valid dataSchema', () => {
      const result = validateWorkflowDefinition(
        triggerDefinition({
          id: 'trigger',
          type: 'trigger',
          dataSchema: {
            owner: { type: 'string', required: true, description: 'GitHub org or user' },
            number: { type: 'number', required: true, label: 'PR number' },
            draft: { type: 'boolean', default: false },
          },
        }),
      );
      expect(result).toEqual({ ok: true });
    });

    it('points "inputSchema" at "dataSchema" (beyond edit-distance hints)', () => {
      const result = validateWorkflowDefinition(
        triggerDefinition({
          id: 'trigger',
          type: 'trigger',
          inputSchema: { owner: { type: 'string' } },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) =>
            e.includes('unknown field "inputSchema" on a "trigger" node — did you mean "dataSchema"?'),
          ),
        ).toBe(true);
      }
    });

    it('rejects a non-object field definition', () => {
      const result = validateWorkflowDefinition(
        triggerDefinition({ id: 'trigger', type: 'trigger', dataSchema: { owner: 'string' } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('trigger.dataSchema.owner must be an object'))).toBe(true);
      }
    });

    it('accepts "integer" as an alias for "number"', () => {
      const result = validateWorkflowDefinition(
        triggerDefinition({
          id: 'trigger',
          type: 'trigger',
          dataSchema: { count: { type: 'integer', required: true } },
        }),
      );
      expect(result).toEqual({ ok: true });
    });

    it('rejects an unknown input type and names the accepted ones', () => {
      const result = validateWorkflowDefinition(
        triggerDefinition({
          id: 'trigger',
          type: 'trigger',
          dataSchema: { count: { type: 'int' } },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) =>
            e.includes(
              'trigger.dataSchema.count.type must be one of: "string", "number", "integer", "boolean", "object", "array"',
            ),
          ),
        ).toBe(true);
      }
    });

    it('rejects a non-boolean required and a non-array enum', () => {
      const result = validateWorkflowDefinition(
        triggerDefinition({
          id: 'trigger',
          type: 'trigger',
          dataSchema: {
            owner: { type: 'string', required: 'yes' },
            env: { type: 'string', enum: 'prod' },
          },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('trigger.dataSchema.owner.required must be a boolean'))).toBe(true);
        expect(result.errors.some((e) => e.includes('trigger.dataSchema.env.enum must be an array'))).toBe(true);
      }
    });

    it('hints near-miss keys inside an input definition', () => {
      const result = validateWorkflowDefinition(
        triggerDefinition({
          id: 'trigger',
          type: 'trigger',
          dataSchema: { owner: { type: 'string', requird: true } },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) =>
            e.includes('trigger.dataSchema.owner: unknown field "requird" in an input definition — did you mean "required"?'),
          ),
        ).toBe(true);
      }
    });
  });

  describe('llm node', () => {
    function llmDefinition(overrides: Partial<{ model: string; prompt: string }>): WorkflowDefinition {
      return definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'ask', type: 'llm', model: 'anthropic/claude-sonnet', prompt: 'summarize', ...overrides },
          { id: 'stop', type: 'stop' },
        ],
        edges: [
          { from: 'trigger', to: 'ask' },
          { from: 'ask', to: 'stop' },
        ],
      });
    }

    it('accepts a valid llm node', () => {
      expect(validateWorkflowDefinition(llmDefinition({}))).toEqual({ ok: true });
    });

    it('rejects an empty model', () => {
      const result = validateWorkflowDefinition(llmDefinition({ model: '' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('llm.model must be a non-empty string'))).toBe(true);
      }
    });

    it('rejects an empty prompt', () => {
      const result = validateWorkflowDefinition(llmDefinition({ prompt: '   ' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('llm.prompt must be a non-empty string'))).toBe(true);
      }
    });

    it('reports missing if.conditions / set.values / wait.duration as errors instead of throwing', () => {
      // Regression: an LLM-authored `if` node with a `condition` string
      // (not the `conditions` array) crashed the interpreter's drive loop
      // AND the web canvas with `undefined.length`. Same class of bug for
      // set.values and wait.duration (`.trim()` on undefined).
      const result = validateWorkflowDefinition({
        version: 'dag/v1',
        nodes: [
          { id: 'trigger', type: 'trigger' },
          rawNode({ id: 'branch', type: 'if' }),
          rawNode({ id: 'vals', type: 'set' }),
          rawNode({ id: 'pause', type: 'wait', mode: 'duration' }),
          { id: 'stop', type: 'stop' },
        ],
        edges: [
          { from: 'trigger', to: 'branch' },
          { from: 'branch', to: 'vals', fromOutput: 'true' },
          { from: 'branch', to: 'stop', fromOutput: 'false' },
          { from: 'vals', to: 'pause' },
          { from: 'pause', to: 'stop' },
        ],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('if.conditions must be an array'))).toBe(true);
        expect(result.errors.some((e) => e.includes('set.values must be an object'))).toBe(true);
        expect(result.errors.some((e) => e.includes('unparseable wait.duration'))).toBe(true);
      }
    });

    it('reports missing model/prompt as errors instead of throwing', () => {
      // Regression: `.trim()` used to be called unconditionally, so an LLM
      // node without `model`/`prompt` threw a TypeError before any error
      // could accumulate. Callers now see a validation error instead.
      const result = validateWorkflowDefinition(
        llmDefinition({}) && {
          version: 'dag/v1',
          nodes: [
            { id: 'trigger', type: 'trigger' },
            rawNode({ id: 'ask', type: 'llm' }),
            { id: 'stop', type: 'stop' },
          ],
          edges: [
            { from: 'trigger', to: 'ask' },
            { from: 'ask', to: 'stop' },
          ],
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('llm.model must be a non-empty string'))).toBe(true);
        expect(result.errors.some((e) => e.includes('llm.prompt must be a non-empty string'))).toBe(true);
      }
    });
  });

  describe('thread node', () => {
    it('accepts a valid thread node', () => {
      const result = validateWorkflowDefinition(
        definition({
          nodes: [
            { id: 'trigger', type: 'trigger' },
            { id: 'ask', type: 'thread', prompt: 'do the thing' },
            { id: 'stop', type: 'stop' },
          ],
          edges: [
            { from: 'trigger', to: 'ask' },
            { from: 'ask', to: 'stop' },
          ],
        }),
      );
      expect(result).toEqual({ ok: true });
    });

    it('rejects an empty prompt', () => {
      const result = validateWorkflowDefinition(
        definition({
          nodes: [
            { id: 'trigger', type: 'trigger' },
            { id: 'ask', type: 'thread', prompt: '' },
            { id: 'stop', type: 'stop' },
          ],
          edges: [
            { from: 'trigger', to: 'ask' },
            { from: 'ask', to: 'stop' },
          ],
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('thread.prompt must be a non-empty string'))).toBe(true);
      }
    });
  });

  describe('tool node', () => {
    function toolDefinition(
      overrides: Partial<Pick<ToolNode, 'service' | 'action' | 'credential' | 'onDeny' | 'approvalTimeout'>>,
    ): WorkflowDefinition {
      return definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'call', type: 'tool', service: 'slack', action: 'send_message', params: {}, ...overrides },
          { id: 'stop', type: 'stop' },
        ],
        edges: [
          { from: 'trigger', to: 'call' },
          { from: 'call', to: 'stop' },
        ],
      });
    }

    it('accepts a valid tool node', () => {
      expect(validateWorkflowDefinition(toolDefinition({}))).toEqual({ ok: true });
    });

    it('rejects an empty service', () => {
      const result = validateWorkflowDefinition(toolDefinition({ service: '' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('tool.service must be a non-empty string'))).toBe(true);
      }
    });

    it('rejects an empty action', () => {
      const result = validateWorkflowDefinition(toolDefinition({ action: '' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('tool.action must be a non-empty string'))).toBe(true);
      }
    });

    it('accepts every credential selection, and a node that omits it', () => {
      expect(validateWorkflowDefinition(toolDefinition({ credential: 'auto' }))).toEqual({ ok: true });
      expect(validateWorkflowDefinition(toolDefinition({ credential: 'app' }))).toEqual({ ok: true });
      expect(validateWorkflowDefinition(toolDefinition({ credential: 'user' }))).toEqual({ ok: true });
      expect(validateWorkflowDefinition(toolDefinition({}))).toEqual({ ok: true });
    });

    it('rejects an unknown credential selection', () => {
      const result = validateWorkflowDefinition(
        definition({
          nodes: [
            { id: 'trigger', type: 'trigger' },
            rawNode({ id: 'call', type: 'tool', service: 'github', action: 'create_comment', params: {}, credential: 'bot' }),
            { id: 'stop', type: 'stop' },
          ],
          edges: [
            { from: 'trigger', to: 'call' },
            { from: 'call', to: 'stop' },
          ],
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) => e.includes('tool.credential must be "auto", "app" or "user"')),
        ).toBe(true);
      }
    });

    // A policy gate parks the run on a tool node, so a definition has to be
    // able to say what a denial or a timeout does. The executor implements
    // both fields; the key list used to omit them, which made every such
    // definition unsavable.
    it('accepts the gate-behavior fields the executor implements', () => {
      expect(validateWorkflowDefinition(toolDefinition({ onDeny: 'skip' }))).toEqual({ ok: true });
      expect(validateWorkflowDefinition(toolDefinition({ onDeny: 'fail', approvalTimeout: '24h' }))).toEqual({ ok: true });
    });

    it('rejects an unknown onDeny value', () => {
      const result = validateWorkflowDefinition(
        definition({
          nodes: [
            { id: 'trigger', type: 'trigger' },
            rawNode({ id: 'call', type: 'tool', service: 'github', action: 'create_comment', params: {}, onDeny: 'retry' }),
            { id: 'stop', type: 'stop' },
          ],
          edges: [
            { from: 'trigger', to: 'call' },
            { from: 'call', to: 'stop' },
          ],
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('tool.onDeny must be "fail" or "skip"'))).toBe(true);
      }
    });

    it('rejects an unparseable approvalTimeout, and names the form to use', () => {
      const result = validateWorkflowDefinition(
        definition({
          nodes: [
            { id: 'trigger', type: 'trigger' },
            rawNode({ id: 'call', type: 'tool', service: 'github', action: 'create_comment', params: {}, approvalTimeout: 'soon' }),
            { id: 'stop', type: 'stop' },
          ],
          edges: [
            { from: 'trigger', to: 'call' },
            { from: 'call', to: 'stop' },
          ],
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('unparseable tool.approvalTimeout'))).toBe(true);
      }
    });
  });

  describe('onError policy', () => {
    /** One-node fixture per type that carries `onError`, so the policy is the only variable. */
    function withNode(node: Record<string, unknown>): WorkflowDefinition {
      return JSON.parse(
        JSON.stringify({
          version: 'dag/v1',
          nodes: [
            { id: 'trigger', type: 'trigger' },
            node,
            { id: 'stop', type: 'stop' },
          ],
          edges: [
            { from: 'trigger', to: 'step' },
            { from: 'step', to: 'stop' },
          ],
        }),
      ) as WorkflowDefinition;
    }

    const toolNode = { id: 'step', type: 'tool', service: 'slack', action: 'send_message', params: {} };
    const llmNode = { id: 'step', type: 'llm', model: 'anthropic/claude-sonnet', prompt: 'summarize' };
    const workflowNode = { id: 'step', type: 'workflow', workflowId: 'wf-child' };

    it('accepts "fail", "continue", and omission on tool, llm and workflow nodes', () => {
      for (const base of [toolNode, llmNode, workflowNode]) {
        expect(validateWorkflowDefinition(withNode(base))).toEqual({ ok: true });
        expect(validateWorkflowDefinition(withNode({ ...base, onError: 'fail' }))).toEqual({ ok: true });
        expect(validateWorkflowDefinition(withNode({ ...base, onError: 'continue' }))).toEqual({ ok: true });
      }
    });

    it('rejects an unknown policy and names both accepted values', () => {
      for (const [base, type] of [
        [toolNode, 'tool'],
        [llmNode, 'llm'],
        [workflowNode, 'workflow'],
      ] as const) {
        const result = validateWorkflowDefinition(withNode({ ...base, onError: 'ignore' }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.errors.some((e) => e.includes(`${type}.onError must be "fail" or "continue"`))).toBe(true);
        }
      }
    });

    it('rejects onError on a node type that has no error policy', () => {
      const result = validateWorkflowDefinition(
        withNode({ id: 'step', type: 'set', values: {}, onError: 'continue' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('unknown field "onError"'))).toBe(true);
      }
    });

    it('rejects onError on a foreach body and points at foreach.onItemError', () => {
      const result = validateWorkflowDefinition(
        JSON.parse(
          JSON.stringify({
            version: 'dag/v1',
            nodes: [
              { id: 'trigger', type: 'trigger' },
              {
                id: 'loop',
                type: 'foreach',
                items: '{{trigger.data.items}}',
                body: { id: 'loop-body', type: 'tool', service: 'slack', action: 'send_message', params: {}, onError: 'continue' },
              },
              { id: 'stop', type: 'stop' },
            ],
            edges: [
              { from: 'trigger', to: 'loop' },
              { from: 'loop', to: 'stop' },
            ],
          }),
        ) as WorkflowDefinition,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('foreach.body must not set onError') && e.includes('onItemError'))).toBe(
          true,
        );
      }
    });
  });

  describe('foreach node', () => {
    // Several of these cases construct deliberately invalid foreach shapes
    // (disallowed body types, malformed maxItems/concurrency) that don't fit
    // the `ForeachNode` interface — the whole point is exercising the
    // runtime guard on data the type checker would otherwise reject. Build
    // the raw JSON (as real callers' stored definitions would look) and
    // narrow with a single assertion, mirroring the "unsupported node type"
    // fixture above.
    function foreachDefinition(node: Record<string, unknown>): WorkflowDefinition {
      return JSON.parse(
        JSON.stringify({
          version: 'dag/v1',
          nodes: [
            { id: 'trigger', type: 'trigger' },
            {
              id: 'loop',
              type: 'foreach',
              items: '${trigger.data.items}',
              body: { id: 'loop-body', type: 'set', values: {} },
              ...node,
            },
            { id: 'stop', type: 'stop' },
          ],
          edges: [
            { from: 'trigger', to: 'loop' },
            { from: 'loop', to: 'stop' },
          ],
        }),
      ) as WorkflowDefinition;
    }

    it('accepts a valid foreach node', () => {
      expect(validateWorkflowDefinition(foreachDefinition({}))).toEqual({ ok: true });
    });

    it('rejects session wait.timeout inside a foreach body', () => {
      const result = validateWorkflowDefinition(
        foreachDefinition({
          body: {
            id: 'loop-body',
            type: 'session',
            mode: 'start',
            prompt: 'do the thing for ${item}',
            wait: { mode: 'until_idle', timeout: '5m' },
          },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) => e.includes('loop.body (loop-body)') && e.includes('session wait.timeout is not implemented'),
          ),
        ).toBe(true);
      }
    });

    it('rejects an empty items expression', () => {
      const result = validateWorkflowDefinition(foreachDefinition({ items: '' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('foreach.items must be a non-empty template string'))).toBe(true);
      }
    });

    it.each(['foreach', 'if', 'approval', 'stop'])('rejects a %s body type', (bodyType) => {
      const result = validateWorkflowDefinition(
        foreachDefinition({ body: { id: 'loop-body', type: bodyType } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('is not allowed'))).toBe(true);
      }
    });

    // A body id reaches the runtime as a session-id part and as a workspace
    // path segment (`wf:{runId}:{nodeId}[:{iteration}]` ->
    // `~/.valet/workflows/{runId}/{nodeId}/{iteration}`). The per-node loop
    // in `validateWorkflowDefinition` only sees `definition.nodes`, so a body
    // id gets no id-pattern check unless `validateForeachNode` applies one.
    it.each(['bad:id', 'bad/id', '..', 'bad id'])('rejects a foreach body id %s', (bodyId) => {
      const result = validateWorkflowDefinition(foreachDefinition({ body: { id: bodyId, type: 'set', values: {} } }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('foreach.body id') && e.includes('must match'))).toBe(true);
      }
    });

    it('rejects a foreach body with no id', () => {
      const result = validateWorkflowDefinition(foreachDefinition({ body: { type: 'set', values: {} } }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('foreach.body is missing its "id"'))).toBe(true);
      }
    });

    it('rejects a body id that collides with a definition node id', () => {
      const result = validateWorkflowDefinition(foreachDefinition({ body: { id: 'stop', type: 'set', values: {} } }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('collides with a definition node id'))).toBe(true);
      }
    });

    it('rejects two foreach nodes sharing the same body id, naming both foreach nodes', () => {
      const definition: WorkflowDefinition = JSON.parse(
        JSON.stringify({
          version: 'dag/v1',
          nodes: [
            { id: 'trigger', type: 'trigger' },
            { id: 'loop-a', type: 'foreach', items: '${trigger.data.items}', body: { id: 'body', type: 'set', values: {} } },
            { id: 'loop-b', type: 'foreach', items: '${trigger.data.items}', body: { id: 'body', type: 'set', values: {} } },
            { id: 'stop', type: 'stop' },
          ],
          edges: [
            { from: 'trigger', to: 'loop-a' },
            { from: 'loop-a', to: 'loop-b' },
            { from: 'loop-b', to: 'stop' },
          ],
        }),
      );
      const result = validateWorkflowDefinition(definition);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) => e.includes(JSON.stringify('body')) && e.includes('loop-a') && e.includes('loop-b'),
          ),
        ).toBe(true);
      }
    });

    it('validates the body node\'s own type-specific rules, naming the foreach and body', () => {
      const result = validateWorkflowDefinition(
        foreachDefinition({ body: { id: 'loop-body', type: 'llm', model: '', prompt: 'x' } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) => e.includes('loop.body (loop-body)') && e.includes('llm.model must be a non-empty string')),
        ).toBe(true);
      }
    });

    it.each([0, -1, 1.5])('rejects a non-positive-integer maxItems (%s)', (maxItems) => {
      const result = validateWorkflowDefinition(foreachDefinition({ maxItems }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('foreach.maxItems must be a positive integer'))).toBe(true);
      }
    });

    it.each([0, -1, 1.5])('rejects a non-positive-integer concurrency (%s)', (concurrency) => {
      const result = validateWorkflowDefinition(foreachDefinition({ concurrency }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('foreach.concurrency must be a positive integer'))).toBe(true);
      }
    });

    it('rejects concurrency above 10', () => {
      const result = validateWorkflowDefinition(foreachDefinition({ concurrency: 11 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('foreach.concurrency must be <= 10'))).toBe(true);
      }
    });

    it('accepts concurrency of exactly 10', () => {
      expect(validateWorkflowDefinition(foreachDefinition({ concurrency: 10 }))).toEqual({ ok: true });
    });
  });
});

// ─── Linter-grade checks (V1-validator port) ────────────────────────────────

describe('validateWorkflowDefinition — linter checks', () => {
  function linear(nodes: WorkflowDefinition['nodes'], edges?: WorkflowDefinition['edges']): WorkflowDefinition {
    return {
      version: 'dag/v1',
      nodes,
      edges:
        edges ??
        nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1]!.id })),
    };
  }

  it('flags fields nested under "config" with a move-them-up hint', () => {
    const result = validateWorkflowDefinition(
      linear([
        { id: 'trigger', type: 'trigger' },
        rawNode({
          id: 'gen',
          type: 'llm',
          model: 'claude-haiku-4-5',
          prompt: 'x',
          config: { model: 'claude-haiku-4-5', prompt: 'write a haiku' },
        }),
        { id: 'stop', type: 'stop' },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('not under "config"') && e.includes('move { model, prompt } up'))).toBe(true);
    }
  });

  it('suggests near-miss field names (condition → conditions)', () => {
    const result = validateWorkflowDefinition(
      linear(
        [
          { id: 'trigger', type: 'trigger' },
          rawNode({
            id: 'branch',
            type: 'if',
            condition: 'x > 1',
          }),
          { id: 'stop', type: 'stop' },
        ],
        [
          { from: 'trigger', to: 'branch' },
          { from: 'branch', to: 'stop', fromOutput: 'true' },
        ],
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('unknown field "condition"') && e.includes('did you mean "conditions"'))).toBe(true);
      expect(result.errors.some((e) => e.includes('you wrote "condition"; the field is "conditions"'))).toBe(true);
    }
  });

  it('rejects unparseable templates with the parse error', () => {
    const result = validateWorkflowDefinition(
      linear([
        { id: 'trigger', type: 'trigger' },
        { id: 'gen', type: 'llm', model: 'm', prompt: 'hello {{trigger.data.name' },
        { id: 'stop', type: 'stop' },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('prompt template does not parse'))).toBe(true);
    }
  });

  it('rejects references to unknown nodes with a did-you-mean', () => {
    const result = validateWorkflowDefinition(
      linear([
        { id: 'trigger', type: 'trigger' },
        { id: 'classify', type: 'llm', model: 'm', prompt: 'p' },
        { id: 'gen', type: 'llm', model: 'm', prompt: 'severity: {{nodes.clasify.result}}' },
        { id: 'stop', type: 'stop' },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.includes('references unknown node "clasify"') && e.includes('did you mean "classify"')),
      ).toBe(true);
    }
  });

  it('hints nodes.<id> when a bare node id is used as a template root', () => {
    const result = validateWorkflowDefinition(
      linear([
        { id: 'trigger', type: 'trigger' },
        { id: 'classify', type: 'llm', model: 'm', prompt: 'p' },
        { id: 'gen', type: 'llm', model: 'm', prompt: '{{classify.result}}' },
        { id: 'stop', type: 'stop' },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('unknown root "classify"') && e.includes('nodes.classify'))).toBe(true);
    }
  });

  it('rejects a nodes.<id> path whose next segment is not result/output', () => {
    const result = validateWorkflowDefinition(
      linear([
        { id: 'trigger', type: 'trigger' },
        { id: 'extract', type: 'set', values: { owner: 'tkhq' } },
        { id: 'gen', type: 'llm', model: 'm', prompt: 'owner: {{nodes.extract.values.owner}}' },
        { id: 'stop', type: 'stop' },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.includes('"values"') && e.includes('nodes.extract.result.owner')),
      ).toBe(true);
    }
  });

  it('accepts nodes.<id>.result and nodes.<id>.output paths', () => {
    const result = validateWorkflowDefinition(
      linear([
        { id: 'trigger', type: 'trigger' },
        { id: 'extract', type: 'set', values: { owner: 'tkhq' } },
        { id: 'gen', type: 'llm', model: 'm', prompt: '{{nodes.extract.result.owner}} {{nodes.extract.output.owner}}' },
        { id: 'stop', type: 'stop' },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a trigger path that names a field instead of trigger.data.<field>', () => {
    const result = validateWorkflowDefinition(
      linear([
        { id: 'trigger', type: 'trigger' },
        { id: 'gen', type: 'llm', model: 'm', prompt: 'mail {{trigger.email}}' },
        { id: 'stop', type: 'stop' },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('"trigger.data.email"'))).toBe(true);
    }
  });

  it('accepts every key a trigger payload actually carries', () => {
    const result = validateWorkflowDefinition(
      linear([
        { id: 'trigger', type: 'trigger' },
        {
          id: 'gen',
          type: 'llm',
          model: 'm',
          prompt: '{{trigger.type}} {{trigger.triggerId}} {{trigger.timestamp}} {{trigger.data.x}} {{trigger.metadata.y}}',
        },
        { id: 'stop', type: 'stop' },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown policy.onUnresolvedPath value and names both accepted ones', () => {
    const definition = linear([
      { id: 'trigger', type: 'trigger' },
      { id: 'stop', type: 'stop' },
    ]);
    // Stored definitions are unchecked JSON, so the guard must reject a
    // value the type cannot hold — same single-cast seam as `rawNode`.
    const stored: unknown = { onUnresolvedPath: 'strict' };
    const result = validateWorkflowDefinition({ ...definition, policy: stored as WorkflowDefinition['policy'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('"empty"') && e.includes('"fail"'))).toBe(true);
    }
  });

  it('accepts policy.onUnresolvedPath: "fail"', () => {
    const definition = linear([
      { id: 'trigger', type: 'trigger' },
      { id: 'stop', type: 'stop' },
    ]);
    expect(validateWorkflowDefinition({ ...definition, policy: { onUnresolvedPath: 'fail' } }).ok).toBe(true);
  });

  it('requires fromOutput on edges leaving an if node', () => {
    const result = validateWorkflowDefinition(
      linear(
        [
          { id: 'trigger', type: 'trigger' },
          {
            id: 'branch',
            type: 'if',
            conditions: [{ left: 'trigger.data.x', dataType: 'number', operation: 'greaterThan', right: 1 }],
          },
          { id: 'stop', type: 'stop' },
        ],
        [
          { from: 'trigger', to: 'branch' },
          { from: 'branch', to: 'stop' },
        ],
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('must declare fromOutput'))).toBe(true);
    }
  });

  it('rejects unsupported if operations with the allowed list', () => {
    const result = validateWorkflowDefinition(
      linear(
        [
          { id: 'trigger', type: 'trigger' },
          {
            id: 'branch',
            type: 'if',
            conditions: [{ left: 'trigger.data.x', dataType: 'number', operation: 'contains', right: 1 }],
          },
          { id: 'stop', type: 'stop' },
        ],
        [
          { from: 'trigger', to: 'branch' },
          { from: 'branch', to: 'stop', fromOutput: 'true' },
        ],
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('unsupported number operation "contains"') && e.includes('allowed:'))).toBe(true);
    }
  });

  it('rejects unreachable nodes', () => {
    const result = validateWorkflowDefinition({
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'a', type: 'set', values: {} },
        { id: 'orphan', type: 'set', values: {} },
        { id: 'stop', type: 'stop' },
      ],
      edges: [
        { from: 'trigger', to: 'a' },
        { from: 'a', to: 'stop' },
        { from: 'orphan', to: 'stop' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('"orphan" is unreachable'))).toBe(true);
    }
  });

  it('rejects edges out of a stop node and duplicate edges', () => {
    const result = validateWorkflowDefinition({
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'a', type: 'set', values: {} },
        { id: 'stop', type: 'stop' },
      ],
      edges: [
        { from: 'trigger', to: 'a' },
        { from: 'a', to: 'stop' },
        { from: 'a', to: 'stop' },
        { from: 'stop', to: 'a' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('duplicate edge'))).toBe(true);
      expect(result.errors.some((e) => e.includes('stop node "stop" cannot have outgoing edges'))).toBe(true);
    }
  });

  it('checks edge.when expressions parse and reference known nodes', () => {
    const result = validateWorkflowDefinition({
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'a', type: 'set', values: {} },
        { id: 'stop', type: 'stop' },
      ],
      edges: [
        { from: 'trigger', to: 'a' },
        { from: 'a', to: 'stop', when: 'nodes.missing.result == true' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('when references unknown node "missing"'))).toBe(true);
    }
  });

  it('applies the environment model hook', () => {
    const result = validateWorkflowDefinition(
      linear([
        { id: 'trigger', type: 'trigger' },
        { id: 'gen', type: 'llm', model: 'claude-42-mega', prompt: 'p' },
        { id: 'stop', type: 'stop' },
      ]),
      { isKnownModel: (spec) => spec === 'claude-haiku-4-5' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('unknown llm.model "claude-42-mega"'))).toBe(true);
    }
  });

  it('applies the environment action hook', () => {
    const result = validateWorkflowDefinition(
      linear([
        { id: 'trigger', type: 'trigger' },
        { id: 'call', type: 'tool', service: 'githib', action: 'create_issue', params: {} },
        { id: 'stop', type: 'stop' },
      ]),
      { isKnownAction: (service) => (service === 'github' ? 'ok' : 'unknown-service') },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('unknown tool.service "githib"'))).toBe(true);
    }
  });

  describe('environment params hook', () => {
    /** The schema shape `getActionParams` returns — the production case
     * this lint exists for: `pull_number` instead of `pullNumber` saved
     * fine and failed at run time. */
    const GET_PR_PARAMS: Record<string, unknown> = {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pullNumber: { type: 'number' },
      },
      required: ['owner', 'repo', 'pullNumber'],
    };

    const env = {
      getActionParams: (service: string, action: string) =>
        service === 'github' && action === 'get_pull_request' ? GET_PR_PARAMS : undefined,
    };

    function toolWithParams(params: Record<string, unknown>): WorkflowDefinition {
      return linear([
        { id: 'trigger', type: 'trigger' },
        { id: 'fetch_pr', type: 'tool', service: 'github', action: 'get_pull_request', params },
        { id: 'stop', type: 'stop' },
      ]);
    }

    it('accepts params that satisfy the schema', () => {
      const result = validateWorkflowDefinition(
        toolWithParams({ owner: 'acme', repo: 'widgets', pullNumber: 42 }),
        env,
      );
      expect(result).toEqual({ ok: true });
    });

    it('rejects params missing a required key', () => {
      const result = validateWorkflowDefinition(toolWithParams({ owner: 'acme', repo: 'widgets' }), env);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) =>
            e.includes('node "fetch_pr": params is missing required parameter "pullNumber"'),
          ),
        ).toBe(true);
      }
    });

    it('rejects an unknown key with a did-you-mean hint', () => {
      const result = validateWorkflowDefinition(
        toolWithParams({ owner: 'acme', repo: 'widgets', pull_number: 42 }),
        env,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) =>
              e.includes('params.pull_number is not a parameter of github.get_pull_request') &&
              e.includes('did you mean "pullNumber"'),
          ),
        ).toBe(true);
      }
    });

    it('never type-checks a templated value', () => {
      // pullNumber is declared a number; the template only resolves at run
      // time, so a string carrying `{{...}}` must pass.
      const result = validateWorkflowDefinition(
        toolWithParams({ owner: 'acme', repo: 'widgets', pullNumber: '{{trigger.data.pr}}' }),
        env,
      );
      expect(result).toEqual({ ok: true });
    });

    it('rejects a plain value of the wrong type', () => {
      const result = validateWorkflowDefinition(
        toolWithParams({ owner: 'acme', repo: 'widgets', pullNumber: 'forty-two' }),
        env,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) => e.includes('params.pullNumber has the wrong type') && e.includes('declares it as number')),
        ).toBe(true);
      }
    });

    it('rejects an explicit null against a primitive-typed property', () => {
      const result = validateWorkflowDefinition(
        toolWithParams({ owner: 'acme', repo: 'widgets', pullNumber: null }),
        env,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) =>
              e.includes('params.pullNumber is null') &&
              e.includes('declares it as number; set a number value or remove the key'),
          ),
        ).toBe(true);
      }
    });

    it('leaves params unchecked when the hook returns no schema', () => {
      const result = validateWorkflowDefinition(
        linear([
          { id: 'trigger', type: 'trigger' },
          { id: 'call', type: 'tool', service: 'linear', action: 'create_issue', params: { anything: 'goes' } },
          { id: 'stop', type: 'stop' },
        ]),
        env,
      );
      expect(result).toEqual({ ok: true });
    });

    it('leaves params unchecked without the hook (env unchanged)', () => {
      const result = validateWorkflowDefinition(toolWithParams({ owner: 'acme', repo: 'widgets' }), {});
      expect(result).toEqual({ ok: true });
    });
  });

  it('accepts a fully-featured valid workflow (kitchen sink)', () => {
    const result = validateWorkflowDefinition({
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'seed', type: 'set', values: { threshold: 3, repo: '{{trigger.data.repo}}' } },
        {
          id: 'classify',
          type: 'llm',
          model: 'claude-haiku-4-5',
          prompt: 'Classify {{nodes.seed.result.repo}}',
          maxOutputTokens: 500,
        },
        {
          id: 'branch',
          type: 'if',
          conditions: [{ left: 'nodes.classify.result.severity', dataType: 'string', operation: 'equals', right: 'high' }],
        },
        { id: 'pause', type: 'wait', mode: 'duration', duration: '30s' },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{nodes.classify.result.failures}}',
          body: { id: 'loop-body', type: 'set', values: { current: '{{item}}' } },
          maxItems: 10,
        },
        { id: 'gate', type: 'approval', prompt: 'Proceed with {{nodes.classify.result.count}} fixes?' },
        { id: 'done', type: 'stop', outcome: 'success', message: 'Handled {{nodes.classify.result.count}}' },
      ],
      edges: [
        { from: 'trigger', to: 'seed' },
        { from: 'seed', to: 'classify' },
        { from: 'classify', to: 'branch' },
        { from: 'branch', to: 'pause', fromOutput: 'true' },
        { from: 'branch', to: 'gate', fromOutput: 'false' },
        { from: 'pause', to: 'loop' },
        { from: 'loop', to: 'gate' },
        { from: 'gate', to: 'done' },
      ],
    });
    expect(result).toEqual({ ok: true });
  });
});
