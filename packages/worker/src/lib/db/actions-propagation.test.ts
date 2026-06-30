import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { users } from '../schema/users.js';
import { sessions } from '../schema/sessions.js';
import { workflows, workflowExecutions } from '../schema/workflows.js';
import { workflowSpawnedSessions } from '../schema/workflow-spawned-sessions.js';
import { actionInvocations } from '../schema/actions.js';
import {
  listDescendantPendingApprovalsForSession,
  listDescendantPendingApprovalsForExecution,
  isSessionDescendantOfExecution,
} from './actions.js';

const USER_ID = 'u1';

function insertSession(
  db: ReturnType<typeof createTestDb>['db'],
  id: string,
  parentSessionId: string | null = null,
) {
  db.insert(sessions).values({
    id,
    userId: USER_ID,
    workspace: `/tmp/${id}`,
    status: 'running',
    parentSessionId: parentSessionId ?? undefined,
  }).run();
}

function insertPendingInvocation(
  db: ReturnType<typeof createTestDb>['db'],
  data: { id: string; sessionId?: string; workflowExecutionId?: string; service?: string; actionId?: string; status?: string; nodeId?: string },
) {
  db.insert(actionInvocations).values({
    id: data.id,
    sessionId: data.sessionId ?? null,
    workflowExecutionId: data.workflowExecutionId ?? null,
    userId: USER_ID,
    service: data.service ?? 'gmail',
    actionId: data.actionId ?? 'send_email',
    riskLevel: 'medium',
    resolvedMode: 'require_approval',
    status: data.status ?? 'pending',
    nodeId: data.nodeId ?? null,
  }).run();
}

describe('descendant pending-approvals fan-out', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    ({ db } = createTestDb());
    db.insert(users).values([{ id: USER_ID, email: 'u1@example.com' }]).run();
  });

  describe('listDescendantPendingApprovalsForSession', () => {
    it('returns the session’s own pending invocations', async () => {
      insertSession(db, 'sess-a');
      insertPendingInvocation(db, { id: 'inv-1', sessionId: 'sess-a' });

      const rows = await listDescendantPendingApprovalsForSession(db as any, 'sess-a');
      expect(rows.map((r) => r.id)).toEqual(['inv-1']);
    });

    it('walks down the parent_session_id chain (multi-level descendants)', async () => {
      // sess-a → sess-b → sess-c
      insertSession(db, 'sess-a');
      insertSession(db, 'sess-b', 'sess-a');
      insertSession(db, 'sess-c', 'sess-b');
      insertPendingInvocation(db, { id: 'inv-a', sessionId: 'sess-a' });
      insertPendingInvocation(db, { id: 'inv-b', sessionId: 'sess-b' });
      insertPendingInvocation(db, { id: 'inv-c', sessionId: 'sess-c' });

      const rows = await listDescendantPendingApprovalsForSession(db as any, 'sess-a');
      expect(rows.map((r) => r.id).sort()).toEqual(['inv-a', 'inv-b', 'inv-c']);
    });

    it('excludes a sibling subtree outside the lineage', async () => {
      //   sess-root
      //   /        \
      // sess-a    sess-other
      insertSession(db, 'sess-root');
      insertSession(db, 'sess-a', 'sess-root');
      insertSession(db, 'sess-other', 'sess-root');
      insertPendingInvocation(db, { id: 'inv-a', sessionId: 'sess-a' });
      insertPendingInvocation(db, { id: 'inv-other', sessionId: 'sess-other' });

      const rows = await listDescendantPendingApprovalsForSession(db as any, 'sess-a');
      expect(rows.map((r) => r.id)).toEqual(['inv-a']);
    });

    it('excludes non-pending invocations', async () => {
      insertSession(db, 'sess-a');
      insertPendingInvocation(db, { id: 'inv-pending', sessionId: 'sess-a' });
      insertPendingInvocation(db, { id: 'inv-done', sessionId: 'sess-a', status: 'approved' });

      const rows = await listDescendantPendingApprovalsForSession(db as any, 'sess-a');
      expect(rows.map((r) => r.id)).toEqual(['inv-pending']);
    });

    it('excludes expired pending invocations', async () => {
      insertSession(db, 'sess-a');
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      db.insert(actionInvocations).values({
        id: 'inv-stale',
        sessionId: 'sess-a',
        userId: USER_ID,
        service: 'gmail',
        actionId: 'send_email',
        riskLevel: 'medium',
        resolvedMode: 'require_approval',
        status: 'pending',
        expiresAt: pastIso,
      }).run();

      const rows = await listDescendantPendingApprovalsForSession(db as any, 'sess-a');
      expect(rows).toEqual([]);
    });
  });

  describe('listDescendantPendingApprovalsForExecution', () => {
    beforeEach(() => {
      db.insert(workflows).values([{ id: 'wf', userId: USER_ID, name: 'wf', data: JSON.stringify({ version: 'dag/v1' }) }]).run();
      db.insert(workflowExecutions).values([{ id: 'exec-1', workflowId: 'wf', userId: USER_ID, status: 'running', triggerType: 'manual', startedAt: new Date().toISOString() }]).run();
    });

    it('returns workflow-attributed pending invocations', async () => {
      insertPendingInvocation(db, { id: 'inv-direct', workflowExecutionId: 'exec-1', nodeId: 'tool_node' });

      const rows = await listDescendantPendingApprovalsForExecution(db as any, 'exec-1');
      expect(rows.map((r) => r.id)).toEqual(['inv-direct']);
    });

    it('returns spawned-session pending invocations and their descendants', async () => {
      // exec-1 spawned sess-spawned, which spawned sess-child
      insertSession(db, 'sess-spawned');
      insertSession(db, 'sess-child', 'sess-spawned');
      db.insert(workflowSpawnedSessions).values({
        executionId: 'exec-1',
        nodeId: 'spawn_node',
        sessionId: 'sess-spawned',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }).run();
      insertPendingInvocation(db, { id: 'inv-spawned', sessionId: 'sess-spawned' });
      insertPendingInvocation(db, { id: 'inv-child', sessionId: 'sess-child' });

      const rows = await listDescendantPendingApprovalsForExecution(db as any, 'exec-1');
      expect(rows.map((r) => r.id).sort()).toEqual(['inv-child', 'inv-spawned']);
    });

    it('combines workflow-attributed AND spawned-session invocations', async () => {
      insertSession(db, 'sess-spawned');
      db.insert(workflowSpawnedSessions).values({
        executionId: 'exec-1',
        nodeId: 'spawn_node',
        sessionId: 'sess-spawned',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }).run();
      insertPendingInvocation(db, { id: 'inv-direct', workflowExecutionId: 'exec-1', nodeId: 'tool_node' });
      insertPendingInvocation(db, { id: 'inv-spawned', sessionId: 'sess-spawned' });

      const rows = await listDescendantPendingApprovalsForExecution(db as any, 'exec-1');
      expect(rows.map((r) => r.id).sort()).toEqual(['inv-direct', 'inv-spawned']);
    });

    it('isSessionDescendantOfExecution: true for a direct spawn, true for a multi-level child, false for unrelated', async () => {
      insertSession(db, 'sess-spawned');
      insertSession(db, 'sess-child', 'sess-spawned');
      insertSession(db, 'sess-orphan');
      db.insert(workflowSpawnedSessions).values({
        executionId: 'exec-1',
        nodeId: 'spawn_node',
        sessionId: 'sess-spawned',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }).run();

      expect(await isSessionDescendantOfExecution(db as any, 'exec-1', 'sess-spawned')).toBe(true);
      expect(await isSessionDescendantOfExecution(db as any, 'exec-1', 'sess-child')).toBe(true);
      expect(await isSessionDescendantOfExecution(db as any, 'exec-1', 'sess-orphan')).toBe(false);
    });

    it('excludes invocations from a different execution', async () => {
      db.insert(workflowExecutions).values([{ id: 'exec-other', workflowId: 'wf', userId: USER_ID, status: 'running', triggerType: 'manual', startedAt: new Date().toISOString() }]).run();
      insertPendingInvocation(db, { id: 'inv-mine', workflowExecutionId: 'exec-1', nodeId: 'n' });
      insertPendingInvocation(db, { id: 'inv-other', workflowExecutionId: 'exec-other', nodeId: 'n' });

      const rows = await listDescendantPendingApprovalsForExecution(db as any, 'exec-1');
      expect(rows.map((r) => r.id)).toEqual(['inv-mine']);
    });
  });
});
