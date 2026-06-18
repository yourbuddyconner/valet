import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { workflows, workflowExecutions } from '../lib/schema/workflows.js';
import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import type { WorkflowDefinition } from '@valet/shared';
import type { TraceTransition, TraceWriter, WorkflowRunParams } from './types.js';

let db: AppDb;

// getDb in production wraps a D1 binding; tests intercept it.
vi.mock('../lib/drizzle.js', () => ({
  getDb: () => db,
}));

import { runDag } from './runtime.js';

function makeEnv(): Env {
  return {
    DB: {
      prepare: () => { throw new Error('mocked — see vi.mock'); },
    } as unknown as Env['DB'],
  } as unknown as Env;
}

function makeTraceWriter(): { writer: TraceWriter; rows: TraceTransition[] } {
  const rows: TraceTransition[] = [];
  return {
    writer: { async recordTransition(row) { rows.push(row); } },
    rows,
  };
}

function makeStep(onDo?: (name: string) => void): WorkflowStep {
  return {
    async do<T>(name: string, configOrFn: WorkflowStepConfig | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> {
      const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn!;
      onDo?.(name);
      return fn();
    },
  } as unknown as WorkflowStep;
}

function makeParams(definition: WorkflowDefinition, overrides: Partial<WorkflowRunParams> = {}): WorkflowRunParams {
  return {
    executionId: 'exec-race',
    workflowId: 'wf1',
    userId: 'u1',
    trigger: { type: 'manual', timestamp: '2026-06-15T00:00:00Z', data: {}, metadata: {} },
    definition,
    mode: 'production',
    ...overrides,
  };
}

beforeEach(() => {
  ({ db } = createTestDb() as { db: AppDb });
  db.insert(users).values([{ id: 'u1', email: 'u1@example.com' }]).run();
  db.insert(workflows).values([{ id: 'wf1', userId: 'u1', name: 'W', version: '1', data: '{}' }]).run();
});

describe('runDag — fail-closed cancel race', () => {
  it('exits with status=cancelled and runs zero nodes when the row was cancelled before the wave loop', async () => {
    // The cancel API marks the row 'cancelling' (CAS from any active
    // status including 'pending'). If the workflow instance starts up
    // just after that, the pending→running CAS at the top of runDag
    // no-ops. Without the post-CAS check, the wave loop would still
    // execute every reachable node — including side-effectful tool
    // calls — for a workflow the user already cancelled.
    db.insert(workflowExecutions).values({
      id: 'exec-race',
      workflowId: 'wf1',
      userId: 'u1',
      status: 'cancelling',
      triggerType: 'manual',
      startedAt: '2026-06-15T00:00:00Z',
      cancelledAt: '2026-06-15T00:00:00Z',
    }).run();

    const stepNames: string[] = [];
    const step = makeStep((name) => stepNames.push(name));
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'side_effect', type: 'set', values: { ran: 'YES' } },
      ],
      edges: [],
    };
    const env = makeEnv();
    const { writer, rows } = makeTraceWriter();
    const result = await runDag(env, makeParams(def), step, writer);

    expect(result.status).toBe('cancelled');
    // Critical: no node step.do should have fired. The only step.do
    // call should be the CAS attempt itself ("execution-status:...").
    const nodeSteps = stepNames.filter((n) => n.startsWith('node:'));
    expect(nodeSteps).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('proceeds normally when the pending row is not cancelled', async () => {
    db.insert(workflowExecutions).values({
      id: 'exec-race',
      workflowId: 'wf1',
      userId: 'u1',
      status: 'pending',
      triggerType: 'manual',
      startedAt: '2026-06-15T00:00:00Z',
    }).run();

    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'side_effect', type: 'set', values: { ran: 'YES' } },
        { id: 'done', type: 'stop' },
      ],
      edges: [{ from: 'side_effect', to: 'done' }],
    };
    const env = makeEnv();
    const { writer } = makeTraceWriter();
    const result = await runDag(env, makeParams(def), makeStep(), writer);
    expect(result.status).toBe('completed');
  });

  it('stops dispatching new nodes when cancel races the wave loop mid-flight', async () => {
    // The wave loop has already entered 'running' (the pending→running
    // CAS succeeded). After it executes the first batch, a parallel
    // cancel API call flips the row to 'cancelling'. The next wave
    // iteration's cancel probe MUST see that and exit without
    // dispatching the second batch — otherwise side-effectful nodes
    // would run for a workflow the user already cancelled and whose
    // CF terminate() call is in flight.
    db.insert(workflowExecutions).values({
      id: 'exec-race',
      workflowId: 'wf1',
      userId: 'u1',
      status: 'pending',
      triggerType: 'manual',
      startedAt: '2026-06-15T00:00:00Z',
    }).run();

    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'first', type: 'set', values: { phase: 1 } },
        { id: 'second', type: 'set', values: { phase: 2 } },
      ],
      // First → second so the wave loop runs them in two iterations.
      edges: [{ from: 'first', to: 'second' }],
    };

    const stepNames: string[] = [];
    const step: WorkflowStep = {
      async do<T>(name: string, configOrFn: WorkflowStepConfig | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> {
        const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn!;
        // After the first node body runs, simulate a cancel API call
        // marking the row 'cancelling'. The next wave-iter cancel
        // probe should see this.
        if (name === 'node:first') {
          stepNames.push(name);
          const result = await fn();
          db.update(workflowExecutions)
            .set({ status: 'cancelling', cancelledAt: '2026-06-15T00:00:01Z' })
            .where(eq(workflowExecutions.id, 'exec-race'))
            .run();
          return result;
        }
        if (name.startsWith('node:')) stepNames.push(name);
        return fn();
      },
    } as unknown as WorkflowStep;

    const env = makeEnv();
    const { writer } = makeTraceWriter();
    const result = await runDag(env, makeParams(def), step, writer);

    expect(result.status).toBe('cancelled');
    // first ran; second must NOT have dispatched.
    const nodeSteps = stepNames.filter((n) => n.startsWith('node:'));
    expect(nodeSteps).toContain('node:first');
    expect(nodeSteps).not.toContain('node:second');
  });
});
