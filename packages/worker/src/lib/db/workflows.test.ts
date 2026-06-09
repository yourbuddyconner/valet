import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { users } from '../schema/users.js';
import { workflows, workflowExecutions } from '../schema/workflows.js';
import { getWorkflowNameByExecutionId } from './workflows.js';

const USER_ID = 'user-workflow-name-test';
const WORKFLOW_ID = 'workflow-weekly-report';
const EXECUTION_ID = 'execution-abc123';

describe('getWorkflowNameByExecutionId', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    ({ db } = createTestDb());

    db.insert(users).values([
      { id: USER_ID, email: 'workflow-test@example.com' },
    ]).run();

    db.insert(workflows).values([
      {
        id: WORKFLOW_ID,
        userId: USER_ID,
        name: 'Weekly Report',
        data: '{}',
        version: '1.0.0',
      },
    ]).run();

    db.insert(workflowExecutions).values([
      {
        id: EXECUTION_ID,
        workflowId: WORKFLOW_ID,
        userId: USER_ID,
        status: 'completed',
        triggerType: 'schedule',
        startedAt: new Date().toISOString(),
      },
    ]).run();
  });

  it('returns the workflow name for a known execution ID', async () => {
    const name = await getWorkflowNameByExecutionId(db as any, EXECUTION_ID);
    expect(name).toBe('Weekly Report');
  });

  it('returns null for an unknown execution ID', async () => {
    const name = await getWorkflowNameByExecutionId(db as any, 'does-not-exist');
    expect(name).toBeNull();
  });
});
