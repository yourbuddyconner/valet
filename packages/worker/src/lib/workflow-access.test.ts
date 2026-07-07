import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { users } from './schema/users.js';
import { workflows } from './schema/workflows.js';
import { assertWorkflowAccess } from './workflow-access.js';
import { NotFoundError } from '@valet/shared';
import type { AppDb } from './drizzle.js';

let db: AppDb;

beforeEach(() => {
  ({ db } = createTestDb() as { db: AppDb; sqlite: unknown });
  db.insert(users).values([
    { id: 'user-1', email: 'one@example.com' },
    { id: 'user-2', email: 'two@example.com' },
  ]).run();
  db.insert(workflows).values([
    {
      id: 'wf-owned',
      slug: 'owned',
      userId: 'user-1',
      name: 'Owned Workflow',
      version: 'dag/v1',
      data: '{}',
      enabled: true,
    },
    {
      id: 'wf-other',
      slug: 'other',
      userId: 'user-2',
      name: 'Someone Else',
      version: 'dag/v1',
      data: '{}',
      enabled: true,
    },
  ]).run();
});

describe('assertWorkflowAccess', () => {
  it('returns the workflow when the user is the owner (viewer role)', async () => {
    const result = await assertWorkflowAccess(db, { id: 'user-1' }, 'wf-owned', 'viewer');
    expect(result).toEqual({ id: 'wf-owned', userId: 'user-1' });
  });

  it('returns the workflow when the user is the owner (editor role)', async () => {
    const result = await assertWorkflowAccess(db, { id: 'user-1' }, 'wf-owned', 'editor');
    expect(result.id).toBe('wf-owned');
  });

  it('returns the workflow when the user is the owner (publisher role)', async () => {
    const result = await assertWorkflowAccess(db, { id: 'user-1' }, 'wf-owned', 'publisher');
    expect(result.id).toBe('wf-owned');
  });

  it('accepts the slug as well as the id', async () => {
    const result = await assertWorkflowAccess(db, { id: 'user-1' }, 'owned', 'viewer');
    expect(result.id).toBe('wf-owned');
  });

  it('rejects when the user is not the owner', async () => {
    await expect(assertWorkflowAccess(db, { id: 'user-1' }, 'wf-other', 'viewer')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when the workflow does not exist', async () => {
    await expect(assertWorkflowAccess(db, { id: 'user-1' }, 'wf-missing', 'viewer')).rejects.toBeInstanceOf(NotFoundError);
  });
});
