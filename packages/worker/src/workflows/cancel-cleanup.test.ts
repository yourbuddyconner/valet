import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { workflows, workflowExecutions } from '../lib/schema/workflows.js';
import { workflowApprovals } from '../lib/schema/workflow-approvals.js';
import { workflowSpawnedSessions } from '../lib/schema/workflow-spawned-sessions.js';
import { eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';

let db: AppDb;
let terminateCalls: string[] = [];
let terminateSessionCalls: Array<{ sessionId: string; reason: string }> = [];

// getDb in production wraps a D1 binding; in tests we return the
// per-test drizzle instance directly.
vi.mock('../lib/drizzle.js', () => ({
  getDb: () => db,
}));

vi.mock('../services/sessions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/sessions.js')>();
  return {
    ...original,
    async terminateSessionUnchecked(_env: Env, sessionId: string, reason: string): Promise<void> {
      terminateSessionCalls.push({ sessionId, reason });
    },
  };
});

import { cancelExecution, runCancellationCleanup, sweepStuckApprovals, sweepStuckCancellations } from './cancel-cleanup.js';

function makeEnv(): Env {
  return {
    DB: {
      // Drizzle createTestDb returns the better-sqlite3 instance; the
      // helpers in cancel-cleanup all go through getDb(env.DB) which
      // calls drizzle(env.DB). For these tests we mock getDb instead
      // by passing a sentinel that drizzle won't actually use.
      prepare: () => { throw new Error('mocked away — see vi.mock below'); },
    } as unknown as Env['DB'],
    SESSIONS: {} as Env['SESSIONS'],
    EVENT_BUS: {} as Env['EVENT_BUS'],
    WORKFLOW_INTERPRETER: {
      // Each test resets terminateCalls; this stub records the call so
      // tests can assert cancelExecution calls terminate exactly once.
      // The default status() returns 'running' so the cancel path
      // proceeds to terminate. Tests that need 'terminated' / 'errored'
      // / 'complete' override env.WORKFLOW_INTERPRETER directly.
      get: (id: string) => ({
        async status() { return { status: 'running' }; },
        async terminate() { terminateCalls.push(id); },
        async sendEvent() { /* no-op — defensive abandon-wait event */ },
      }),
    } as unknown as Env['WORKFLOW_INTERPRETER'],
    ENCRYPTION_KEY: 'k',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    MODAL_BACKEND_URL: '',
    FRONTEND_URL: '',
  } as unknown as Env;
}

beforeEach(() => {
  ({ db } = createTestDb() as { db: AppDb });
  terminateCalls = [];
  terminateSessionCalls = [];
  db.insert(users).values([{ id: 'u1', email: 'u1@example.com' }]).run();
  db.insert(workflows).values([{ id: 'wf1', userId: 'u1', name: 'W', version: '1', data: '{}' }]).run();
});

function makeExecution(id: string, status: string, cancelledAt?: string, cleanupCompletedAt?: string) {
  db.insert(workflowExecutions).values({
    id, workflowId: 'wf1', userId: 'u1', status, triggerType: 'manual',
    startedAt: new Date().toISOString(),
    cancelledAt: cancelledAt ?? null,
    cleanupCompletedAt: cleanupCompletedAt ?? null,
  }).run();
}

describe('runCancellationCleanup', () => {
  it('moves an in-flight execution from cancelling → cancelled and clears pending approvals', async () => {
    makeExecution('e1', 'cancelling', new Date().toISOString());
    db.insert(workflowApprovals).values({
      id: 'a1', executionId: 'e1', nodeId: 'gate', kind: 'explicit',
      workflowInstanceId: 'e1', eventType: 'approval_gate',
      prompt: 'p', status: 'pending',
    }).run();

    // Use a getDb that returns our test drizzle instance.
    const env = makeEnv();

    await runCancellationCleanup(env, { executionId: 'e1' });

    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'e1')).get();
    expect(row?.status).toBe('cancelled');
    const approval = await db.select().from(workflowApprovals).where(eq(workflowApprovals.id, 'a1')).get();
    expect(approval?.status).toBe('cancelled');
  });

  it('is a no-op when the execution is already cancelled AND cleanup_completed_at is set', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    makeExecution('e2', 'cancelled', past, past);
    db.insert(workflowApprovals).values({
      id: 'a-noop', executionId: 'e2', nodeId: 'gate', kind: 'explicit',
      workflowInstanceId: 'e2', eventType: 'approval_gate',
      prompt: 'p', status: 'pending',
    }).run();
    const env = makeEnv();
    await runCancellationCleanup(env, { executionId: 'e2' });
    // The cleanup didn't run — the lingering 'pending' approval is
    // proof that the early-return on cleanup_completed_at fired.
    const approval = await db.select().from(workflowApprovals).where(eq(workflowApprovals.id, 'a-noop')).get();
    expect(approval?.status).toBe('pending');
  });

  it('still runs cleanup when status=cancelled but cleanup_completed_at is null (runtime race)', async () => {
    // The bug the reviewer flagged: the runtime can flip the row to
    // 'cancelled' (allowedPrior includes 'cancelling') before the cancel
    // API has run its cleanup. If we returned early on status alone,
    // pending approvals would never be cancelled.
    const past = new Date(Date.now() - 60_000).toISOString();
    makeExecution('e-race', 'cancelled', past);   // cleanup_completed_at intentionally null
    db.insert(workflowApprovals).values({
      id: 'a-race', executionId: 'e-race', nodeId: 'gate', kind: 'explicit',
      workflowInstanceId: 'e-race', eventType: 'approval_gate',
      prompt: 'p', status: 'pending',
    }).run();
    const env = makeEnv();
    await runCancellationCleanup(env, { executionId: 'e-race' });
    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'e-race')).get();
    expect(row?.status).toBe('cancelled');
    expect(row?.cleanupCompletedAt).not.toBeNull();
    const approval = await db.select().from(workflowApprovals).where(eq(workflowApprovals.id, 'a-race')).get();
    expect(approval?.status).toBe('cancelled');
  });

  it('terminates spawned sessions and removes successful tracking rows', async () => {
    makeExecution('e-spawned', 'cancelling', new Date().toISOString());
    db.insert(workflowSpawnedSessions).values({
      executionId: 'e-spawned',
      nodeId: 'run_session',
      sessionId: 'session-spawned',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }).run();

    const env = makeEnv();
    await runCancellationCleanup(env, { executionId: 'e-spawned' });

    expect(terminateSessionCalls).toEqual([
      { sessionId: 'session-spawned', reason: 'workflow_cancelled' },
    ]);
    const remaining = await db.select().from(workflowSpawnedSessions)
      .where(eq(workflowSpawnedSessions.executionId, 'e-spawned'))
      .all();
    expect(remaining).toEqual([]);
    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'e-spawned')).get();
    expect(row?.cleanupCompletedAt).not.toBeNull();
  });
});

describe('cancelExecution', () => {
  it('marks cancelling, calls instance.terminate, runs cleanup → cancelled', async () => {
    makeExecution('e3', 'running');
    const env = makeEnv();
    const result = await cancelExecution(env, { executionId: 'e3', cancelledBy: 'u1' });
    expect(result.status).toBe('cancelled');
    expect(terminateCalls).toEqual(['e3']);
    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'e3')).get();
    expect(row?.cancelledBy).toBe('u1');
  });

  it('reports not_found for an unknown execution', async () => {
    const env = makeEnv();
    const result = await cancelExecution(env, { executionId: 'missing', cancelledBy: 'u1' });
    expect(result.status).toBe('not_found');
  });

  it('reports already_terminal for a completed execution', async () => {
    makeExecution('e4', 'completed');
    const env = makeEnv();
    const result = await cancelExecution(env, { executionId: 'e4', cancelledBy: 'u1' });
    expect(result.status).toBe('already_terminal');
    expect(terminateCalls).toEqual([]);
  });

  it('retries cleanup when called on a cancelled row whose cleanup never finished', async () => {
    // Runtime raced and wrote 'cancelled' before the cancel API ran cleanup.
    // An explicit cancel retry should drive cleanup to completion synchronously
    // rather than deferring to the cron sweep.
    makeExecution('e-retry', 'cancelled', new Date().toISOString());
    db.insert(workflowApprovals).values({
      id: 'a-retry', executionId: 'e-retry', nodeId: 'gate', kind: 'explicit',
      workflowInstanceId: 'e-retry', eventType: 'approval_gate',
      prompt: 'p', status: 'pending',
    }).run();
    const env = makeEnv();
    const result = await cancelExecution(env, { executionId: 'e-retry', cancelledBy: 'u1' });
    expect(result.status).toBe('cancelled');
    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'e-retry')).get();
    expect(row?.cleanupCompletedAt).not.toBeNull();
    const approval = await db.select().from(workflowApprovals).where(eq(workflowApprovals.id, 'a-retry')).get();
    expect(approval?.status).toBe('cancelled');
    // Runtime already finalized — we should NOT have called terminate
    // a second time. Otherwise we'd be calling terminate on an
    // already-terminated instance.
    expect(terminateCalls).toEqual([]);
  });

  it('retries terminate when called on a cancelling row whose first attempt failed', async () => {
    // First cancel attempt CAS'd to 'cancelling' but instance.terminate()
    // threw, leaving the row in 'cancelling'. The retry MUST re-attempt
    // terminate before running cleanup — otherwise we'd set
    // cleanup_completed_at while the CF Workflow instance is still
    // running.
    makeExecution('e-cancelling-retry', 'cancelling', new Date().toISOString());
    db.insert(workflowApprovals).values({
      id: 'a-cancelling-retry', executionId: 'e-cancelling-retry', nodeId: 'gate', kind: 'explicit',
      workflowInstanceId: 'e-cancelling-retry', eventType: 'approval_gate',
      prompt: 'p', status: 'pending',
    }).run();
    const env = makeEnv();
    const result = await cancelExecution(env, { executionId: 'e-cancelling-retry', cancelledBy: 'u1' });
    expect(result.status).toBe('cancelled');
    expect(terminateCalls).toEqual(['e-cancelling-retry']);
    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'e-cancelling-retry')).get();
    expect(row?.cleanupCompletedAt).not.toBeNull();
  });

  it('does not mark cleanup complete when terminate() throws on a cancelling retry', async () => {
    makeExecution('e-cancelling-flaky', 'cancelling', new Date().toISOString());
    const env = makeEnv();
    // Override the WORKFLOW_INTERPRETER binding for this test so terminate()
    // throws. The cancel API should leave the row in 'cancelling' for
    // the cron sweep — NOT silently mark cleanup complete.
    env.WORKFLOW_INTERPRETER = {
      get: () => ({
        async sendEvent() { /* no-op */ },
        async terminate() { throw new Error('cf simulated terminate failure'); },
      }),
    } as unknown as Env['WORKFLOW_INTERPRETER'];
    const result = await cancelExecution(env, { executionId: 'e-cancelling-flaky', cancelledBy: 'u1' });
    expect(result.status).toBe('cancelling');
    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'e-cancelling-flaky')).get();
    expect(row?.status).toBe('cancelling');
    expect(row?.cleanupCompletedAt).toBeNull();
  });

  it('keeps reporting already_terminal for a fully-cleaned cancelled row', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    makeExecution('e-done', 'cancelled', past, past);
    const env = makeEnv();
    const result = await cancelExecution(env, { executionId: 'e-done', cancelledBy: 'u1' });
    expect(result.status).toBe('already_terminal');
    expect(terminateCalls).toEqual([]);
  });
});

describe('sweepStuckCancellations', () => {
  it('recovers a row stuck in cancelling beyond the stale threshold (and re-attempts terminate)', async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    makeExecution('e5', 'cancelling', tenMinAgo);
    const env = makeEnv();
    const { swept } = await sweepStuckCancellations(env);
    expect(swept).toBe(1);
    // For a 'cancelling' row, the sweep MUST re-call terminate before
    // cleanup. Otherwise it would mark cleanup complete while the CF
    // Workflow instance is still running.
    expect(terminateCalls).toEqual(['e5']);
    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'e5')).get();
    expect(row?.status).toBe('cancelled');
    expect(row?.cleanupCompletedAt).not.toBeNull();
  });

  it('skips terminate for a cancelled row whose cleanup never finished (runtime self-finalized)', async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    // Row landed in 'cancelled' (runtime exited via the cancellation
    // path) but cleanup never ran. The CF Workflow instance is already
    // gone — the sweep just needs to run cleanup, NOT call terminate
    // again.
    makeExecution('e5b', 'cancelled', tenMinAgo);
    const env = makeEnv();
    const { swept } = await sweepStuckCancellations(env);
    expect(swept).toBe(1);
    expect(terminateCalls).toEqual([]);
    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'e5b')).get();
    expect(row?.status).toBe('cancelled');
    expect(row?.cleanupCompletedAt).not.toBeNull();
  });

  it('leaves a cancelling row in place when terminate throws (and does not mark cleanup complete)', async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    makeExecution('e5c', 'cancelling', tenMinAgo);
    const env = makeEnv();
    env.WORKFLOW_INTERPRETER = {
      get: () => ({
        async sendEvent() { /* no-op */ },
        async terminate() { throw new Error('cf simulated terminate failure'); },
      }),
    } as unknown as Env['WORKFLOW_INTERPRETER'];
    const { swept } = await sweepStuckCancellations(env);
    expect(swept).toBe(0);
    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'e5c')).get();
    expect(row?.status).toBe('cancelling');
    expect(row?.cleanupCompletedAt).toBeNull();
  });

  it('leaves rows alone whose cancelledAt is recent', async () => {
    const now = new Date().toISOString();
    makeExecution('e6', 'cancelling', now);
    const env = makeEnv();
    const { swept } = await sweepStuckCancellations(env);
    expect(swept).toBe(0);
    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'e6')).get();
    expect(row?.status).toBe('cancelling');
  });

  it('finishes cleanup when terminate would throw because the instance is already terminated', async () => {
    // Pins the "terminate() retry idempotence" assumption: if the first
    // cancel attempt's terminate() succeeded but cleanup crashed, the
    // sweep must NOT loop forever. CF Workflows' terminate() throws
    // when the instance is already terminated / errored / complete —
    // we check status() first and skip terminate when it's terminal.
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    makeExecution('e-already-term', 'cancelling', tenMinAgo);
    const env = makeEnv();
    env.WORKFLOW_INTERPRETER = {
      get: () => ({
        async status() { return { status: 'terminated' }; },
        async sendEvent() { /* would throw on a terminated instance */ },
        async terminate() { throw new Error('cf: instance is already terminated'); },
      }),
    } as unknown as Env['WORKFLOW_INTERPRETER'];
    const { swept } = await sweepStuckCancellations(env);
    expect(swept).toBe(1);
    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'e-already-term')).get();
    expect(row?.status).toBe('cancelled');
    expect(row?.cleanupCompletedAt).not.toBeNull();
  });
});

describe('sweepStuckApprovals', () => {
  it('retries an approval whose execution is in waiting_approval', async () => {
    // Resolved 10 min ago — past the 5-min stale threshold.
    const resolvedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    makeExecution('e-wait', 'waiting_approval');
    db.insert(workflowApprovals).values({
      id: 'a1', executionId: 'e-wait', nodeId: 'n', kind: 'explicit',
      workflowInstanceId: 'wfi-1', eventType: 'approval_n', prompt: '?',
      status: 'approved', resolvedBy: 'u1', resolvedAt,
    }).run();
    const env = makeEnv();
    const sendEventCalls: string[] = [];
    env.WORKFLOW_INTERPRETER = {
      get: () => ({
        async sendEvent(evt: { type: string }) { sendEventCalls.push(evt.type); },
      }),
    } as unknown as Env['WORKFLOW_INTERPRETER'];
    const { retried } = await sweepStuckApprovals(env);
    expect(retried).toBe(1);
    expect(sendEventCalls).toEqual(['approval_n']);
  });

  it('retries an approval whose execution has flipped to running (parallel siblings race)', async () => {
    // The bug the reviewer flagged: when N waiting nodes run in parallel,
    // one sibling resolving moves the execution row to 'running' while
    // others are still pending. If the sweep filtered on
    // waiting_approval, the stuck sibling would never be retried.
    const resolvedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    makeExecution('e-running', 'running');
    db.insert(workflowApprovals).values({
      id: 'a2', executionId: 'e-running', nodeId: 'sibling', kind: 'explicit',
      workflowInstanceId: 'wfi-2', eventType: 'approval_sibling', prompt: '?',
      status: 'denied', resolvedBy: 'u1', resolvedAt,
    }).run();
    const env = makeEnv();
    const sendEventCalls: string[] = [];
    env.WORKFLOW_INTERPRETER = {
      get: () => ({
        async sendEvent(evt: { type: string }) { sendEventCalls.push(evt.type); },
      }),
    } as unknown as Env['WORKFLOW_INTERPRETER'];
    const { retried } = await sweepStuckApprovals(env);
    expect(retried).toBe(1);
    expect(sendEventCalls).toEqual(['approval_sibling']);
  });

  it('skips approvals whose execution is terminal', async () => {
    const resolvedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    makeExecution('e-done', 'completed');
    db.insert(workflowApprovals).values({
      id: 'a3', executionId: 'e-done', nodeId: 'n', kind: 'explicit',
      workflowInstanceId: 'wfi-3', eventType: 'approval_n', prompt: '?',
      status: 'approved', resolvedBy: 'u1', resolvedAt,
    }).run();
    const env = makeEnv();
    const sendEventCalls: string[] = [];
    env.WORKFLOW_INTERPRETER = {
      get: () => ({
        async sendEvent(evt: { type: string }) { sendEventCalls.push(evt.type); },
      }),
    } as unknown as Env['WORKFLOW_INTERPRETER'];
    const { retried } = await sweepStuckApprovals(env);
    expect(retried).toBe(0);
    expect(sendEventCalls).toEqual([]);
  });

  it('skips approvals resolved within the stale window', async () => {
    // Resolved 1 min ago — under the 5-min staleness floor.
    const resolvedAt = new Date(Date.now() - 60_000).toISOString();
    makeExecution('e-fresh', 'waiting_approval');
    db.insert(workflowApprovals).values({
      id: 'a4', executionId: 'e-fresh', nodeId: 'n', kind: 'explicit',
      workflowInstanceId: 'wfi-4', eventType: 'approval_n', prompt: '?',
      status: 'approved', resolvedBy: 'u1', resolvedAt,
    }).run();
    const env = makeEnv();
    const sendEventCalls: string[] = [];
    env.WORKFLOW_INTERPRETER = {
      get: () => ({
        async sendEvent(evt: { type: string }) { sendEventCalls.push(evt.type); },
      }),
    } as unknown as Env['WORKFLOW_INTERPRETER'];
    const { retried } = await sweepStuckApprovals(env);
    expect(retried).toBe(0);
    expect(sendEventCalls).toEqual([]);
  });
});
