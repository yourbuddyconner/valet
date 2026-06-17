import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/index.js';
import { createWorkflow } from '../services/workflows.js';
import { saveDraft } from '../services/workflow-versions.js';
import { workflowActions } from './workflows-actions.js';
import type { Env } from '../env.js';

const USER_ID = 'workflow-actions-user';

describe('workflowActions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists workflow lifecycle actions', async () => {
    const actions = await workflowActions.listActions();

    expect(actions.map((action) => action.id)).toEqual([
      'workflows.list',
      'workflows.get',
      'workflows.create',
      'workflows.save_draft',
      'workflows.validate',
      'workflows.publish',
      'workflows.test_run',
    ]);
    expect(actions.find((action) => action.id === 'workflows.publish')?.riskLevel).toBe('high');
  });

  it('lists workflows owned by the calling user', async () => {
    const { db } = createTestDb();
    db.insert(users).values({ id: USER_ID, email: 'workflow-actions@example.com' }).run();
    db.insert(users).values({ id: 'other-user', email: 'other-workflow-actions@example.com' }).run();
    const own = await createWorkflow(db as any, USER_ID, { name: 'Daily triage', slug: 'daily-triage' });
    await createWorkflow(db as any, 'other-user', { name: 'Private workflow' });

    const result = await workflowActions.execute('workflows.list', {}, {
      credentials: {},
      userId: USER_ID,
      appDb: db,
      env: {} as Env,
    } as any);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      workflows: [{
        id: own.workflow.id,
        slug: 'daily-triage',
        name: 'Daily triage',
      }],
    });
  });

  it('validates the current draft', async () => {
    const { db } = createTestDb();
    db.insert(users).values({ id: USER_ID, email: 'workflow-actions@example.com' }).run();
    const created = await createWorkflow(db as any, USER_ID, { name: 'Validate me' });
    await saveDraft(db as any, created.workflow.id, {
      version: 'dag/v1',
      nodes: [
        { id: 'start', type: 'trigger' },
        { id: 'finish', type: 'stop', output: { ok: true } },
      ],
      edges: [{ from: 'start', to: 'finish' }],
    } as any);

    const result = await workflowActions.execute('workflows.validate', {
      workflowId: created.workflow.id,
    }, {
      credentials: {},
      userId: USER_ID,
      appDb: db,
      env: {} as Env,
    } as any);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ errors: [] });
  });

  it('requires worker context at execution time', async () => {
    const result = await workflowActions.execute('workflows.list', {}, {
      credentials: {},
      userId: USER_ID,
    } as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain('worker context');
  });
});
