import { describe, it, expect } from 'vitest';
import type { ActionContext } from '@valet/sdk';
import { workflowsActions } from './actions.js';

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
});
