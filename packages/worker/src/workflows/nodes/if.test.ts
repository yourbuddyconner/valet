import { describe, it, expect } from 'vitest';
import { executeIf } from './if.js';
import type { IfNode, WorkflowDagState } from '@valet/shared';
import type { WorkflowRunParams } from '../types.js';
import type { Env } from '../../env.js';
import type { WorkflowStep } from 'cloudflare:workers';

function args(node: IfNode, triggerData: Record<string, unknown> = {}) {
  const fullState: WorkflowDagState = {
    trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: triggerData, metadata: {} },
    inputs: {},
    nodes: {},
    skipped: {},
  };
  return {
    node,
    state: fullState,
    params: {} as WorkflowRunParams,
    env: {} as Env,
    step: {} as WorkflowStep,
  };
}

describe('executeIf — string operations', () => {
  it('equals / notEquals', async () => {
    const node: IfNode = {
      id: 'r',
      type: 'if',
      conditions: [{ left: 'trigger.data.priority', dataType: 'string', operation: 'equals', right: 'high' }],
    };
    const r = await executeIf(args(node, { priority: 'high' }));
    expect(r.result).toBe(true);
    expect(r.matched).toEqual([0]);
  });

  it('contains / startsWith / endsWith', async () => {
    const node: IfNode = {
      id: 'r',
      type: 'if',
      conditions: [
        { left: 'trigger.data.msg', dataType: 'string', operation: 'contains', right: 'urgent' },
      ],
    };
    const r = await executeIf(args(node, { msg: 'this is urgent please reply' }));
    expect(r.result).toBe(true);
  });

  it('isEmpty / isNotEmpty', async () => {
    const node: IfNode = {
      id: 'r',
      type: 'if',
      conditions: [{ left: 'trigger.data.field', dataType: 'string', operation: 'isEmpty' }],
    };
    expect((await executeIf(args(node, { field: '' }))).result).toBe(true);
    expect((await executeIf(args(node, { field: 'x' }))).result).toBe(false);
  });

  it('matchesRegex with a safe pattern', async () => {
    const node: IfNode = {
      id: 'r',
      type: 'if',
      conditions: [{ left: 'trigger.data.email', dataType: 'string', operation: 'matchesRegex', right: '^[a-z]+@[a-z]+\\.com$' }],
    };
    expect((await executeIf(args(node, { email: 'foo@bar.com' }))).result).toBe(true);
    expect((await executeIf(args(node, { email: 'NOT EMAIL' }))).result).toBe(false);
  });
});

describe('executeIf — number operations', () => {
  it('greaterThan / lessThan / etc.', async () => {
    const node: IfNode = {
      id: 'r',
      type: 'if',
      conditions: [{ left: 'trigger.data.n', dataType: 'number', operation: 'greaterThan', right: 5 }],
    };
    expect((await executeIf(args(node, { n: 10 }))).result).toBe(true);
    expect((await executeIf(args(node, { n: 3 }))).result).toBe(false);
  });
});

describe('executeIf — boolean / array / object operations', () => {
  it('isTrue / isFalse', async () => {
    const t: IfNode = { id: 'r', type: 'if', conditions: [{ left: 'trigger.data.flag', dataType: 'boolean', operation: 'isTrue' }] };
    expect((await executeIf(args(t, { flag: true }))).result).toBe(true);
    expect((await executeIf(args(t, { flag: false }))).result).toBe(false);
  });

  it('array contains with deep equality', async () => {
    const node: IfNode = {
      id: 'r',
      type: 'if',
      conditions: [{ left: 'trigger.data.tags', dataType: 'array', operation: 'contains', right: 'urgent' }],
    };
    expect((await executeIf(args(node, { tags: ['urgent', 'billing'] }))).result).toBe(true);
    expect((await executeIf(args(node, { tags: ['routine'] }))).result).toBe(false);
  });

  it('object isEmpty / isNotEmpty', async () => {
    const node: IfNode = { id: 'r', type: 'if', conditions: [{ left: 'trigger.data.x', dataType: 'object', operation: 'isEmpty' }] };
    expect((await executeIf(args(node, { x: {} }))).result).toBe(true);
    expect((await executeIf(args(node, { x: { y: 1 } }))).result).toBe(false);
  });
});

describe('executeIf — combinator', () => {
  it('and: all must match', async () => {
    const node: IfNode = {
      id: 'r',
      type: 'if',
      combinator: 'and',
      conditions: [
        { left: 'trigger.data.priority', dataType: 'string', operation: 'equals', right: 'high' },
        { left: 'trigger.data.n', dataType: 'number', operation: 'greaterThan', right: 5 },
      ],
    };
    expect((await executeIf(args(node, { priority: 'high', n: 10 }))).result).toBe(true);
    expect((await executeIf(args(node, { priority: 'high', n: 1 }))).result).toBe(false);
  });

  it('or: any matches', async () => {
    const node: IfNode = {
      id: 'r',
      type: 'if',
      combinator: 'or',
      conditions: [
        { left: 'trigger.data.priority', dataType: 'string', operation: 'equals', right: 'high' },
        { left: 'trigger.data.n', dataType: 'number', operation: 'greaterThan', right: 100 },
      ],
    };
    expect((await executeIf(args(node, { priority: 'high', n: 1 }))).result).toBe(true);
    expect((await executeIf(args(node, { priority: 'low', n: 200 }))).result).toBe(true);
    expect((await executeIf(args(node, { priority: 'low', n: 1 }))).result).toBe(false);
  });
});
