import { describe, it, expect, vi } from 'vitest';
import type { WorkflowStep, WorkflowStepConfig, WorkflowSleepDuration, WorkflowTimeoutDuration } from 'cloudflare:workers';
import { runDag } from './runtime.js';
import type { WorkflowRunParams, TraceWriter, TraceTransition } from './types.js';
import type { WorkflowDefinition } from '@valet/shared';
import type { Env } from '../env.js';
import { createTestDb } from '../test-utils/db.js';
import type { AppDb } from '../lib/drizzle.js';
import { users } from '../lib/schema/users.js';
import { workflows, workflowExecutions } from '../lib/schema/workflows.js';
import { workflowSpawnedSessions } from '../lib/schema/workflow-spawned-sessions.js';
import { eq } from 'drizzle-orm';

let db: AppDb;
const terminateSessionCalls: Array<{ sessionId: string; reason: string }> = [];

vi.mock('../lib/drizzle.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/drizzle.js')>();
  return {
    ...original,
    getDb: (binding: Env['DB']) => binding ? db : original.getDb(binding),
  };
});

vi.mock('../services/sessions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/sessions.js')>();
  return {
    ...original,
    async terminateSessionUnchecked(_env: Env, sessionId: string, reason: string): Promise<void> {
      terminateSessionCalls.push({ sessionId, reason });
    },
  };
});

const stubEnv: Env = {} as Env;
const dbEnv = { DB: {} as Env['DB'] } as Env;

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

function makeStepWithFailingCleanup(): WorkflowStep {
  const step = makeStep();
  step.do = async <T>(name: string, configOrFn: WorkflowStepConfig | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> => {
    if (name.startsWith('spawned-session-cleanup:')) {
      throw new Error('simulated cleanup step failure');
    }
    const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn;
    if (!fn) throw new Error(`Missing step callback for ${name}`);
    return fn();
  };
  return step;
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
    mode: 'production',
    ...overrides,
  };
}

function seedWorkflowExecution(executionId: string) {
  ({ db } = createTestDb() as { db: AppDb });
  terminateSessionCalls.length = 0;

  db.insert(users).values([{ id: 'user-1', email: 'user@example.com' }]).run();
  db.insert(workflows).values([{ id: 'wf-1', userId: 'user-1', name: 'Workflow', version: '1', data: '{}' }]).run();
  db.insert(workflowExecutions).values({
    id: executionId,
    workflowId: 'wf-1',
    userId: 'user-1',
    status: 'pending',
    triggerType: 'manual',
    startedAt: new Date().toISOString(),
  }).run();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runDag — set → stop end-to-end', () => {
  it('terminates workflow-spawned sessions when the execution completes', async () => {
    seedWorkflowExecution('exec-cleanup');
    db.insert(workflowSpawnedSessions).values({
      executionId: 'exec-cleanup',
      nodeId: 'spawn_agent',
      sessionId: 'session-cleanup',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }).run();

    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [{ id: 'done', type: 'stop' }],
      edges: [],
    };

    const { writer } = makeTraceWriter();
    const result = await runDag(dbEnv, makeParams(def, { executionId: 'exec-cleanup' }), makeStep(), writer);

    expect(result.status).toBe('completed');
    expect(terminateSessionCalls).toEqual([
      { sessionId: 'session-cleanup', reason: 'workflow_completed' },
    ]);
    const remaining = await db.select().from(workflowSpawnedSessions)
      .where(eq(workflowSpawnedSessions.executionId, 'exec-cleanup'))
      .all();
    expect(remaining).toEqual([]);
  });

  it('keeps the workflow result terminal when spawned-session cleanup throws', async () => {
    seedWorkflowExecution('exec-cleanup-throws');

    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [{ id: 'done', type: 'stop' }],
      edges: [],
    };

    const { writer } = makeTraceWriter();
    const result = await runDag(
      dbEnv,
      makeParams(def, { executionId: 'exec-cleanup-throws' }),
      makeStepWithFailingCleanup(),
      writer,
    );

    expect(result.status).toBe('completed');
    const row = await db.select().from(workflowExecutions)
      .where(eq(workflowExecutions.id, 'exec-cleanup-throws'))
      .get();
    expect(row?.status).toBe('completed');
  });

  it('terminates workflow-spawned sessions when the execution fails', async () => {
    seedWorkflowExecution('exec-failed-cleanup');
    db.insert(workflowSpawnedSessions).values({
      executionId: 'exec-failed-cleanup',
      nodeId: 'spawn_agent',
      sessionId: 'session-failed-cleanup',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }).run();

    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [{ id: 'failed', type: 'stop', outcome: 'failure', message: 'done badly' }],
      edges: [],
    };

    const { writer } = makeTraceWriter();
    const result = await runDag(dbEnv, makeParams(def, { executionId: 'exec-failed-cleanup' }), makeStep(), writer);

    expect(result.status).toBe('failed');
    expect(terminateSessionCalls).toEqual([
      { sessionId: 'session-failed-cleanup', reason: 'workflow_failed' },
    ]);
    const remaining = await db.select().from(workflowSpawnedSessions)
      .where(eq(workflowSpawnedSessions.executionId, 'exec-failed-cleanup'))
      .all();
    expect(remaining).toEqual([]);
  });

  it('runs a trigger source node before downstream workflow steps', async () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'build', type: 'set', values: { greeting: 'hello {{nodes.trigger.data.data.email}}' } },
      ],
      edges: [{ from: 'trigger', to: 'build' }],
    };

    const { writer, rows } = makeTraceWriter();
    const result = await runDag(stubEnv, makeParams(def), makeStep(), writer);

    expect(result.status).toBe('completed');
    expect(result.state.nodes.trigger).toMatchObject({
      status: 'completed',
      data: {
        type: 'manual',
        data: { email: 'a@b.com' },
      },
    });
    expect(result.state.nodes.build).toMatchObject({
      status: 'completed',
      data: { greeting: 'hello a@b.com' },
    });
    expect(rows.map((row) => ({ nodeId: row.nodeId, status: row.status }))).toEqual([
      { nodeId: 'trigger', status: 'running' },
      { nodeId: 'trigger', status: 'completed' },
      { nodeId: 'build', status: 'running' },
      { nodeId: 'build', status: 'completed' },
    ]);
  });

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
