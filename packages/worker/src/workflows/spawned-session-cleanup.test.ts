import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { workflows, workflowExecutions } from '../lib/schema/workflows.js';
import { workflowSpawnedSessions } from '../lib/schema/workflow-spawned-sessions.js';

let db: AppDb;
let terminateSessionCalls: Array<{ sessionId: string; reason: string }> = [];
let terminateSessionFailures = new Set<string>();

vi.mock('../lib/drizzle.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/drizzle.js')>();
  return {
    ...original,
    getDb: () => db,
  };
});

vi.mock('../services/sessions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/sessions.js')>();
  return {
    ...original,
    async terminateSessionUnchecked(_env: Env, sessionId: string, reason: string): Promise<void> {
      if (terminateSessionFailures.has(sessionId)) {
        throw new Error('simulated terminate failure');
      }
      terminateSessionCalls.push({ sessionId, reason });
    },
  };
});

import { sweepTerminalSpawnedSessions } from './spawned-session-cleanup.js';

const env = { DB: {} as Env['DB'] } as Env;

beforeEach(() => {
  ({ db } = createTestDb() as { db: AppDb });
  terminateSessionCalls = [];
  terminateSessionFailures = new Set();
  db.insert(users).values([{ id: 'user-1', email: 'user@example.com' }]).run();
  db.insert(workflows).values([{ id: 'wf-1', userId: 'user-1', name: 'Workflow', version: '1', data: '{}' }]).run();
});

function makeExecution(id: string, status: string) {
  db.insert(workflowExecutions).values({
    id,
    workflowId: 'wf-1',
    userId: 'user-1',
    status,
    triggerType: 'manual',
    startedAt: new Date().toISOString(),
  }).run();
}

function makeSpawnedSession(executionId: string, sessionId: string) {
  db.insert(workflowSpawnedSessions).values({
    executionId,
    nodeId: `node-${sessionId}`,
    sessionId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }).run();
}

describe('sweepTerminalSpawnedSessions', () => {
  it('retries spawned-session termination for completed and failed executions', async () => {
    makeExecution('exec-completed', 'completed');
    makeExecution('exec-failed', 'failed');
    makeExecution('exec-running', 'running');
    makeSpawnedSession('exec-completed', 'session-completed');
    makeSpawnedSession('exec-failed', 'session-failed');
    makeSpawnedSession('exec-running', 'session-running');

    const result = await sweepTerminalSpawnedSessions(env);

    expect(result).toMatchObject({ executions: 2, attempted: 2, terminated: 2, failed: [] });
    expect(terminateSessionCalls).toEqual([
      { sessionId: 'session-completed', reason: 'workflow_completed' },
      { sessionId: 'session-failed', reason: 'workflow_failed' },
    ]);
    const remaining = await db.select({ sessionId: workflowSpawnedSessions.sessionId })
      .from(workflowSpawnedSessions)
      .all();
    const remainingSessionIds: string[] = [];
    for (const row of remaining) {
      remainingSessionIds.push(row.sessionId);
    }
    expect(remainingSessionIds).toEqual(['session-running']);
  });

  it('keeps failed termination rows for another retry', async () => {
    makeExecution('exec-completed', 'completed');
    makeSpawnedSession('exec-completed', 'session-will-fail');
    terminateSessionFailures.add('session-will-fail');

    const result = await sweepTerminalSpawnedSessions(env);

    expect(result.failed).toEqual([
      { sessionId: 'session-will-fail', error: 'simulated terminate failure' },
    ]);
    const remaining = await db.select().from(workflowSpawnedSessions)
      .where(eq(workflowSpawnedSessions.sessionId, 'session-will-fail'))
      .all();
    expect(remaining).toHaveLength(1);
  });
});
