import { describe, it, expect } from 'vitest';
import type { WorkflowStep, WorkflowStepConfig, WorkflowSleepDuration, WorkflowTimeoutDuration } from 'cloudflare:workers';
import { runDag } from './runtime.js';
import type { WorkflowRunParams, TraceWriter, TraceTransition } from './types.js';
import type { WorkflowDefinition } from '@valet/shared';
import type { Env } from '../env.js';

const stubEnv: Env = {} as Env;

// ─── Mock WorkflowStep ──────────────────────────────────────────────────────

/**
 * Minimal WorkflowStep mock that invokes the callback once per name and
 * memoizes its return. Mimics the deterministic-replay semantic — calling
 * `do` with the same name on a fresh instance always invokes the
 * callback; the persistence layer is the platform's, not ours.
 */
function makeStep(): WorkflowStep {
  return {
    async do<T>(_name: string, configOrFn: WorkflowStepConfig | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> {
      const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn!;
      return fn();
    },
    async sleep(_name: string, _duration: WorkflowSleepDuration): Promise<void> {
      // No-op in tests.
    },
    async sleepUntil(_name: string, _timestamp: Date | number): Promise<void> {
      // No-op in tests.
    },
    async waitForEvent<T>(_name: string, _options: { type: string; timeout?: WorkflowTimeoutDuration | number }): Promise<{ payload: T; timestamp: Date; type: string }> {
      throw new Error('waitForEvent not used in Phase 2 tests');
    },
  } as unknown as WorkflowStep;
}

function makeTraceWriter(): { writer: TraceWriter; rows: TraceTransition[] } {
  const rows: TraceTransition[] = [];
  return {
    writer: { async recordTransition(row) { rows.push(row); } },
    rows,
  };
}

function makeParams(definition: WorkflowDefinition, overrides: Partial<WorkflowRunParams> = {}): WorkflowRunParams {
  return {
    executionId: 'exec-1',
    workflowId: 'wf-1',
    userId: 'user-1',
    trigger: {
      type: 'manual',
      timestamp: '2026-06-12T00:00:00.000Z',
      data: { email: 'a@b.com' },
      metadata: {},
    },
    definition,
    inputs: {},
    mode: 'production',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runDag — set → stop end-to-end', () => {
  it('runs a single set node and stops successfully', async () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'build', type: 'set', values: { greeting: 'hello {{trigger.data.email}}' } },
        { id: 'done', type: 'stop' },
      ],
      edges: [{ from: 'build', to: 'done' }],
    };

    const { writer, rows } = makeTraceWriter();
    const result = await runDag(stubEnv, makeParams(def), makeStep(), writer);

    expect(result.status).toBe('completed');
    expect(result.state.nodes.build).toMatchObject({
      status: 'completed',
      data: { greeting: 'hello a@b.com' },
    });
    expect(result.state.nodes.done).toMatchObject({
      status: 'completed',
      data: { outcome: 'success' },
    });

    // Trace rows: both nodes ran → expect a `running` then `completed` per node.
    const events = rows.map((r) => ({ nodeId: r.nodeId, status: r.status }));
    expect(events).toEqual([
      { nodeId: 'build', status: 'running' },
      { nodeId: 'build', status: 'completed' },
      { nodeId: 'done', status: 'running' },
      { nodeId: 'done', status: 'completed' },
    ]);
  });

  it('propagates set node output via templates to a downstream set', async () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'extract', type: 'set', values: { name: '{{trigger.data.name}}' } },
        { id: 'shape', type: 'set', values: { who: 'hi {{nodes.extract.data.name}}' } },
        { id: 'done', type: 'stop' },
      ],
      edges: [
        { from: 'extract', to: 'shape' },
        { from: 'shape', to: 'done' },
      ],
    };

    const { writer } = makeTraceWriter();
    const result = await runDag(
      stubEnv,
      makeParams(def, {
        trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: { name: 'world' }, metadata: {} },
      }),
      makeStep(),
      writer,
    );

    expect(result.status).toBe('completed');
    expect(result.state.nodes.shape).toMatchObject({
      status: 'completed',
      data: { who: 'hi world' },
    });
  });

  it('fails the workflow when a stop node has outcome: failure', async () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'noop', type: 'set', values: {} },
        { id: 'bad', type: 'stop', outcome: 'failure', message: 'nope: {{trigger.data.reason}}' },
      ],
      edges: [{ from: 'noop', to: 'bad' }],
    };

    const { writer, rows } = makeTraceWriter();
    const result = await runDag(
      stubEnv,
      makeParams(def, {
        trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: { reason: 'broken' }, metadata: {} },
      }),
      makeStep(),
      writer,
    );

    expect(result.status).toBe('failed');
    expect(result.stopOutputs).toMatchObject({
      bad: { outcome: 'failure', message: 'nope: broken' },
    });
    expect(rows.some((r) => r.nodeId === 'bad' && r.status === 'failed')).toBe(true);
  });

  it('records a failed trace row when a node throws', async () => {
    // tool node referencing a service with no integration package
    // throws cleanly at executor entry — exercises the failure path
    // without needing a DB / external mock.
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'oops', type: 'tool', service: 'no-such-service', action: 'no-such-action', params: {} },
        { id: 'done', type: 'stop' },
      ],
      edges: [{ from: 'oops', to: 'done' }],
    };

    const { writer, rows } = makeTraceWriter();
    const env = { DB: undefined as unknown } as Env;
    const result = await runDag(env, makeParams(def), makeStep(), writer);

    expect(result.status).toBe('failed');
    expect(result.state.nodes.oops).toMatchObject({ status: 'failed' });
    expect(rows.some((r) => r.nodeId === 'oops' && r.status === 'failed')).toBe(true);
  });

  it('skips nodes whose inbound edges are all unsatisfied (if-routed branch)', async () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'a', type: 'set', values: {} },
        { id: 'b', type: 'if', conditions: [{ left: 'trigger.x', dataType: 'string', operation: 'equals', right: 'never' }] },
        { id: 'truthBranch', type: 'set', values: { ran: true } },
        { id: 'done', type: 'stop' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'truthBranch', fromOutput: 'true' },
        { from: 'b', to: 'done', fromOutput: 'false' },
      ],
    };

    const { writer, rows } = makeTraceWriter();
    const result = await runDag(
      stubEnv,
      makeParams(def, {
        trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: {}, metadata: {} },
      }),
      makeStep(),
      writer,
    );

    expect(result.status).toBe('completed');
    expect(result.state.skipped.truthBranch).toBeDefined();
    expect(rows.some((r) => r.nodeId === 'truthBranch' && r.status === 'skipped')).toBe(true);
  });
});

describe('runDag — failure aggregation', () => {
  it('keeps running independent branches when one branch fails and reports both failures', async () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'bad1', type: 'tool', service: 'no-such', action: 'no-such.x', params: {} },
        { id: 'bad2', type: 'tool', service: 'no-such', action: 'no-such.y', params: {} },
        { id: 'good', type: 'set', values: { ok: true } },
      ],
      edges: [],
    };

    const { writer } = makeTraceWriter();
    const env = { DB: undefined as unknown } as Env;
    const result = await runDag(env, makeParams(def), makeStep(), writer);

    expect(result.status).toBe('failed');
    expect(result.failures).toBeDefined();
    expect(result.failures!.length).toBe(2);
    expect(result.failures!.map((f) => f.nodeId).sort()).toEqual(['bad1', 'bad2']);
    expect(result.state.nodes.good).toMatchObject({ status: 'completed', data: { ok: true } });
  });
});

describe('runDag — wave loop fundamentals', () => {
  it('executes parallel root nodes concurrently', async () => {
    let activeCount = 0;
    let peakActive = 0;
    const step = makeStep();
    const wrappedStep: WorkflowStep = {
      ...step,
      async do<T>(name: string, configOrFn: WorkflowStepConfig | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> {
        const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn!;
        activeCount++;
        peakActive = Math.max(peakActive, activeCount);
        try {
          // Small delay to let concurrent steps overlap.
          await new Promise((r) => setTimeout(r, 5));
          return await fn();
        } finally {
          activeCount--;
        }
      },
    } as unknown as WorkflowStep;

    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'a', type: 'set', values: { v: 1 } },
        { id: 'b', type: 'set', values: { v: 2 } },
        { id: 'c', type: 'set', values: { v: 3 } },
      ],
      edges: [],
    };

    const { writer } = makeTraceWriter();
    await runDag(stubEnv, makeParams(def), wrappedStep, writer);
    expect(peakActive).toBeGreaterThan(1);
  });
});
