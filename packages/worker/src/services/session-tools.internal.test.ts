import { describe, it, expect, vi } from 'vitest';
import { executeAction, resolveActionPolicy, type CredentialCache } from './session-tools.js';
import { integrationRegistry } from '../integrations/registry.js';

vi.mock('../services/actions.js', () => ({
  invokeAction: vi.fn().mockResolvedValue({ id: 'inv1', credentialId: null, outcome: 'allowed', invocationId: 'inv1' }),
  markExecuted: vi.fn().mockResolvedValue(undefined),
  markFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/db/disabled-actions.js', () => ({
  isActionDisabled: vi.fn().mockResolvedValue(false),
}));

vi.mock('../lib/db/plugins.js', () => ({
  getDisabledPluginServices: vi.fn().mockResolvedValue(new Set()),
  getAutoEnabledServices: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/db/integrations.js', () => ({
  getUserIntegrations: vi.fn().mockResolvedValue([]),
  getOrgIntegrations: vi.fn().mockResolvedValue([]),
}));

vi.mock('./custom-mcp-connectors.js', () => ({
  loadCustomMcpConnectorContext: vi.fn().mockResolvedValue({
    orgId: 'default',
    connectors: new Map(),
    fetch,
  }),
}));

describe('resolveActionPolicy — internal provider bypass', () => {
  it('does not throw the activation gate error for an internal provider with no active integration', async () => {
    // Mock getProvider to return an internal provider
    vi.spyOn(integrationRegistry, 'getProvider').mockReturnValue({
      service: 'workflows',
      authType: 'none',
      internal: true,
    } as unknown as ReturnType<typeof integrationRegistry.getProvider>);

    // Mock getActions to return a fake source (needed after the gate check)
    vi.spyOn(integrationRegistry, 'getActions').mockReturnValue({
      listActions: () => Promise.resolve([{ id: 'list_workflows', name: 'List', description: 'desc', riskLevel: 'low' }]),
      execute: async () => ({ success: true }),
    } as unknown as ReturnType<typeof integrationRegistry.getActions>);

    const appDb = {} as Parameters<typeof resolveActionPolicy>[0];
    const envDB = {} as Parameters<typeof resolveActionPolicy>[1];
    const env = {} as Parameters<typeof resolveActionPolicy>[2];

    const stubCredentialCache: CredentialCache = {
      get: () => null,
      set: () => undefined,
      invalidate: () => undefined,
    };

    // getUserIntegrations and getOrgIntegrations are mocked to return [] (no active integration)
    // getAutoEnabledServices is mocked to return [] (not in auto-enabled list)
    // Without the fix, this would throw: Integration "workflows" is not active.
    await expect(
      resolveActionPolicy(appDb, envDB, env, 'u1', 'workflows:list_workflows', {}, {
        sessionId: 'sess1',
        discoveredToolRiskLevels: new Map(),
        credentialCache: stubCredentialCache,
        disabledPluginServicesCache: null,
      }),
    ).resolves.not.toThrow();
  });
});

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
