import { describe, expect, it, beforeEach } from 'vitest';
import { ValidationError } from '@valet/shared';
import { createTestDb } from '../test-utils/db.js';
import { users, workflows } from '../lib/schema/index.js';
import { syncWorkflow, syncAllWorkflows } from './workflows.js';
import { isWorkflowPublished } from '../lib/db/workflows.js';
import { saveDraft, publishDraft } from './workflow-versions.js';
import type { WorkflowDefinition } from '@valet/shared';

const USER_ID = 'wf-user';
const WORKFLOW_ID = 'wf-id';

function validDef(): WorkflowDefinition {
  return {
    version: 'dag/v1',
    inputs: {},
    nodes: [
      { id: 'start', type: 'set', values: { x: 1 } },
      { id: 'stop', type: 'stop' },
    ],
    edges: [{ from: 'start', to: 'stop' }],
  } as WorkflowDefinition;
}

describe('workflows service — post-publish write guards', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    ({ db } = createTestDb());
    db.insert(users).values({ id: USER_ID, email: 'wf@e.io' }).run();
    db.insert(workflows).values({
      id: WORKFLOW_ID,
      userId: USER_ID,
      name: 'demo',
      version: '0',
      data: JSON.stringify(validDef()),
    }).run();
  });

  it('syncWorkflow rejects when the workflow already has a published version', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, validDef());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await publishDraft(db as any, WORKFLOW_ID, { userId: USER_ID });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      syncWorkflow(db as any, USER_ID, {
        id: WORKFLOW_ID,
        name: 'demo',
        version: '1',
        data: validDef() as unknown as Record<string, unknown>,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('syncAllWorkflows rejects the whole batch when any incoming id has a published version', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, validDef());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await publishDraft(db as any, WORKFLOW_ID, { userId: USER_ID });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      syncAllWorkflows(db as any, USER_ID, [
        { id: 'fresh', name: 'fresh', version: '1', data: validDef() as unknown as Record<string, unknown> },
        { id: WORKFLOW_ID, name: 'demo', version: '1', data: validDef() as unknown as Record<string, unknown> },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
    // Pre-flight rejection: the 'fresh' upsert MUST NOT have been written.
    const after = db.select().from(workflows).all();
    expect(after.find((r) => r.id === 'fresh')).toBeUndefined();
  });

  it('isWorkflowPublished helper reports true after publish, false otherwise', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await isWorkflowPublished(db as any, WORKFLOW_ID)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, validDef());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await publishDraft(db as any, WORKFLOW_ID, { userId: USER_ID });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await isWorkflowPublished(db as any, WORKFLOW_ID)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await isWorkflowPublished(db as any, 'missing')).toBe(false);
  });
});
