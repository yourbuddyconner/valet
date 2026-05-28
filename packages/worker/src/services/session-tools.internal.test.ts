import { describe, it, expect, vi } from 'vitest';
import { executeAction } from './session-tools.js';
import { integrationRegistry } from '../integrations/registry.js';

vi.mock('../services/actions.js', () => ({
  invokeAction: vi.fn().mockResolvedValue({ id: 'inv1', credentialId: null }),
  markExecuted: vi.fn().mockResolvedValue(undefined),
  markFailed: vi.fn().mockResolvedValue(undefined),
}));

describe('executeAction internal provider', () => {
  it('passes internal { db, env } and skips credential resolution', async () => {
    const captured: { ctx?: unknown } = {};
    const fakeSource = {
      listActions: () => [],
      execute: async (_id: string, _p: unknown, ctx: unknown) => {
        captured.ctx = ctx;
        return { success: true, data: 'ok' };
      },
    };
    vi.spyOn(integrationRegistry, 'getProvider').mockReturnValue({
      service: 'workflows',
      authType: 'none',
      internal: true,
    } as unknown as ReturnType<typeof integrationRegistry.getProvider>);
    const resolveSpy = vi.spyOn(integrationRegistry, 'resolveCredentials');

    const appDb = { __db: true } as unknown as Parameters<typeof executeAction>[0];
    const env = { __env: true } as unknown as Parameters<typeof executeAction>[1];
    const res = await executeAction(
      appDb,
      env,
      'u1',
      'workflows:list_workflows',
      'workflows',
      'list_workflows',
      {},
      fakeSource as ReturnType<typeof integrationRegistry.getActions>,
      'inv1',
      {} as Parameters<typeof executeAction>[9],
    );

    expect(res.success).toBe(true);
    expect(resolveSpy).not.toHaveBeenCalled();
    const ctx = captured.ctx as Record<string, unknown>;
    expect(ctx.internal).toEqual({ db: appDb, env });
    expect(ctx.credentials).toEqual({});
  });
});
