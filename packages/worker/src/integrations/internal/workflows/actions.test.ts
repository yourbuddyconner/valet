import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActionContext } from '@valet/sdk';
import { workflowsActions } from './actions.js';

// Module mock for session-workflows — must be declared at top level
vi.mock('../../../services/session-workflows.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../services/session-workflows.js')>();
  return {
    ...original,
    workflowExecutions: vi.fn(),
    handleExecutionAction: vi.fn(),
  };
});

describe('workflowsActions', () => {
  it('lists all 22 actions with correct risk tiers', async () => {
    const defs = await Promise.resolve(workflowsActions.listActions());
    expect(defs.length).toBe(22);
    const byId = Object.fromEntries(defs.map((d) => [d.id, d]));
    for (const id of ['delete_workflow', 'rollback_workflow', 'delete_trigger']) {
      expect(byId[id].riskLevel, `expected ${id} to be medium`).toBe('medium');
    }
    for (const id of ['list_workflows', 'sync_workflow', 'run_workflow', 'sync_trigger']) {
      expect(byId[id].riskLevel, `expected ${id} to be low`).toBe('low');
    }
    expect(byId['sync_trigger']).toBeDefined();
    expect(byId['get_execution_steps']).toBeDefined();
  });

  it('rejects an unknown actionId', async () => {
    const res = await workflowsActions.execute(
      'nope',
      {},
      { credentials: {}, userId: 'u', internal: { db: {}, env: {} } } as unknown as ActionContext,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unknown/i);
  });

  describe('list_workflow_executions', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('routes to workflowExecutions (not handleExecutionAction) and returns its data', async () => {
      const { workflowExecutions, handleExecutionAction } = await import(
        '../../../services/session-workflows.js'
      );
      const sentinelData = { executions: [{ id: 'exec-1' }] };
      vi.mocked(workflowExecutions).mockResolvedValue({ data: sentinelData });

      const ctx = {
        credentials: {},
        userId: 'u1',
        internal: { db: {}, env: { DB: {} } },
      } as unknown as ActionContext;

      const res = await workflowsActions.execute(
        'list_workflow_executions',
        { workflow_id: 'wf1', limit: 10 },
        ctx,
      );

      // Must succeed and return the sentinel data from workflowExecutions
      expect(res.success).toBe(true);
      expect(res.data).toEqual(sentinelData);

      // workflowExecutions must have been called with the right args
      expect(vi.mocked(workflowExecutions)).toHaveBeenCalledWith(
        {},        // db
        {},        // env.DB
        'u1',      // userId
        'wf1',     // workflowId
        10,        // limit
      );

      // handleExecutionAction must NOT have been called (it would fail with 'executionId is required')
      expect(vi.mocked(handleExecutionAction)).not.toHaveBeenCalled();

      // Confirm the result does not contain the 'executionId is required' error
      expect(res.error ?? '').not.toMatch(/executionId is required/i);
    });
  });
});
