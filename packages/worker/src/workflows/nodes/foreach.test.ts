import { describe, it, expect } from 'vitest';
import { runDag } from '../runtime.js';
import type { WorkflowDefinition } from '@valet/shared';
import type { WorkflowRunParams, TraceWriter, TraceTransition } from '../types.js';
import type { Env } from '../../env.js';
import type { WorkflowStep, WorkflowStepConfig, WorkflowSleepDuration, WorkflowTimeoutDuration } from 'cloudflare:workers';

const stubEnv: Env = {} as Env;

function makeStep(): WorkflowStep {
  return {
    async do<T>(_name: string, configOrFn: WorkflowStepConfig | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> {
      const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn!;
      return fn();
    },
    async sleep(_name: string, _duration: WorkflowSleepDuration): Promise<void> {},
    async sleepUntil(_name: string, _timestamp: Date | number): Promise<void> {},
    async waitForEvent<T>(_name: string, _options: { type: string; timeout?: WorkflowTimeoutDuration | number }): Promise<{ payload: T; timestamp: Date; type: string }> {
      throw new Error('not used');
    },
  } as unknown as WorkflowStep;
}

function makeTraceWriter(): { writer: TraceWriter; rows: TraceTransition[] } {
  const rows: TraceTransition[] = [];
  return { writer: { async recordTransition(row) { rows.push(row); } }, rows };
}

function makeParams(definition: WorkflowDefinition, overrides: Partial<WorkflowRunParams> = {}): WorkflowRunParams {
  return {
    executionId: 'exec-1',
    workflowId: 'wf-1',
    userId: 'user-1',
    trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: {}, metadata: {} },
    definition,
    mode: 'production',
    ...overrides,
  };
}

describe('foreach — sequential', () => {
  it('iterates over a static array and exposes item/index aliases', async () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          body: { id: 'render', type: 'set', values: { line: 'item={{item}} idx={{index}}' } },
          maxOutputTokens: 100,
        } as unknown as WorkflowDefinition['nodes'][number],
        { id: 'done', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'done' }],
    };

    const { writer } = makeTraceWriter();
    const result = await runDag(
      stubEnv,
      makeParams(def, { trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: { items: ['a', 'b', 'c'] }, metadata: {} } }),
      makeStep(),
      writer,
    );

    expect(result.status).toBe('completed');
    const loopOut = result.state.nodes.loop?.data as { items: Array<{ status: string; data: unknown }>; count: number };
    expect(loopOut.count).toBe(3);
    expect(loopOut.items.map((r) => (r.data as { line: string }).line)).toEqual([
      'item=a idx=0',
      'item=b idx=1',
      'item=c idx=2',
    ]);
  });

  it('honors a custom itemAlias and indexAlias', async () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          itemAlias: 'pr',
          indexAlias: 'pos',
          body: { id: 'render', type: 'set', values: { who: '#{{pos}} {{pr.title}}' } },
        },
        { id: 'done', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'done' }],
    };

    const { writer } = makeTraceWriter();
    const result = await runDag(
      stubEnv,
      makeParams(def, { trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: { items: [{ title: 'fix tests' }, { title: 'add docs' }] }, metadata: {} } }),
      makeStep(),
      writer,
    );

    const loopOut = result.state.nodes.loop?.data as { items: Array<{ data: { who: string } }> };
    expect(loopOut.items.map((r) => r.data.who)).toEqual(['#0 fix tests', '#1 add docs']);
  });
});

describe('foreach — error handling', () => {
  it('default fail mode rejects on first item failure', async () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          body: { id: 'bad', type: 'stop', outcome: 'failure', message: 'always fails' },
        },
        { id: 'done', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'done' }],
    };

    const { writer } = makeTraceWriter();
    const result = await runDag(
      stubEnv,
      makeParams(def, { trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: { items: [1, 2, 3] }, metadata: {} } }),
      makeStep(),
      writer,
    );

    expect(result.status).toBe('failed');
  });

  it('collect mode records failures per item but completes the foreach', async () => {
    // Body is a `stop` with outcome:failure → every iteration throws,
    // and collect-mode captures each per-item error without halting.
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          onItemError: 'collect',
          body: { id: 'always_fails', type: 'stop', outcome: 'failure', message: 'item {{item}} broke' },
        },
        { id: 'done', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'done' }],
    };

    const { writer } = makeTraceWriter();
    const result = await runDag(
      stubEnv,
      makeParams(def, { trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: { items: ['a', 'b', 'c'] }, metadata: {} } }),
      makeStep(),
      writer,
    );

    expect(result.status).toBe('completed');
    const loopOut = result.state.nodes.loop?.data as {
      items: Array<{ status: string; error?: string }>;
      count: number;
      failedCount: number;
      completedCount: number;
      skippedCount: number;
    };
    expect(loopOut.count).toBe(3);
    expect(loopOut.failedCount).toBe(3);
    expect(loopOut.completedCount).toBe(0);
    expect(loopOut.items.every((r) => r.status === 'failed')).toBe(true);
    expect(loopOut.items.every((r) => typeof r.error === 'string')).toBe(true);
  });

  it('skip mode marks failures as skipped and surfaces no failedCount', async () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          onItemError: 'skip',
          body: { id: 'always_fails', type: 'stop', outcome: 'failure' },
        },
        { id: 'done', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'done' }],
    };

    const { writer } = makeTraceWriter();
    const result = await runDag(
      stubEnv,
      makeParams(def, { trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: { items: ['a', 'b'] }, metadata: {} } }),
      makeStep(),
      writer,
    );

    const loopOut = result.state.nodes.loop?.data as { skippedCount: number; failedCount: number };
    expect(loopOut.skippedCount).toBe(2);
    expect(loopOut.failedCount).toBe(0);
  });
});

describe('foreach — validation', () => {
  it('fails when items expression resolves to a non-array', async () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.notAnArray}}',
          body: { id: 'render', type: 'set', values: {} },
        },
        { id: 'done', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'done' }],
    };

    const { writer } = makeTraceWriter();
    const result = await runDag(
      stubEnv,
      makeParams(def, { trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: { notAnArray: 'sorry' }, metadata: {} } }),
      makeStep(),
      writer,
    );

    expect(result.status).toBe('failed');
    expect(result.failures?.[0]?.message).toMatch(/did not resolve to an array/);
  });

  it('truncates items to maxItems instead of failing', async () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          maxItems: 2,
          body: { id: 'render', type: 'set', values: {} },
        },
        { id: 'done', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'done' }],
    };

    const { writer } = makeTraceWriter();
    const result = await runDag(
      stubEnv,
      makeParams(def, { trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: { items: [1, 2, 3] }, metadata: {} } }),
      makeStep(),
      writer,
    );

    expect(result.status).toBe('completed');
    const loopOut = result.state.nodes.loop?.data as {
      items: Array<{ status: string }>;
      count: number;
      inputCount: number;
      truncatedCount: number;
    };
    expect(loopOut.count).toBe(2);
    expect(loopOut.inputCount).toBe(3);
    expect(loopOut.truncatedCount).toBe(1);
    expect(loopOut.items).toHaveLength(2);
  });
});
