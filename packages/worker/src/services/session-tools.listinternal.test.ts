import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { listTools } from './session-tools.js';
import { integrationRegistry } from '../integrations/registry.js';

// Stub all DB-reading helpers so the empty fake appDb/d1 don't error
vi.mock('../lib/db/integrations.js', () => ({
  getUserIntegrations: vi.fn().mockResolvedValue([]),
  getOrgIntegrations: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/db/disabled-actions.js', () => ({
  getDisabledActionsIndex: vi.fn().mockResolvedValue({ disabledActions: new Set(), disabledServices: new Set() }),
  isActionDisabled: vi.fn().mockResolvedValue(false),
}));

vi.mock('../lib/db/plugins.js', () => ({
  getAutoEnabledServices: vi.fn().mockResolvedValue([]),
  getDisabledPluginServices: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock('../lib/db/mcp-tool-cache.js', () => ({
  upsertMcpToolCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/db.js', () => ({
  getUserIdentityLinks: vi.fn().mockResolvedValue([]),
  getOrchestratorIdentity: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/actions.js', () => ({
  invokeAction: vi.fn().mockResolvedValue({ id: 'inv1', credentialId: null }),
  markExecuted: vi.fn().mockResolvedValue(undefined),
  markFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./custom-mcp-connectors.js', () => ({
  loadCustomMcpConnectorContext: vi.fn().mockResolvedValue({
    orgId: 'default',
    connectors: new Map(),
    fetch,
  }),
}));

describe('listTools internal providers', () => {
  it('lists an internal service with no connected integration', async () => {
    vi.spyOn(integrationRegistry, 'listServices').mockReturnValue(['workflows']);
    vi.spyOn(integrationRegistry, 'getProvider').mockImplementation((s: string) =>
      s === 'workflows'
        ? ({ service: 'workflows', authType: 'none', internal: true } as ReturnType<typeof integrationRegistry.getProvider>)
        : undefined,
    );
    vi.spyOn(integrationRegistry, 'getActions').mockImplementation((s: string) =>
      s === 'workflows'
        ? ({
            listActions: () => Promise.resolve([{ id: 'list_workflows', name: 'List', description: 'List workflows', riskLevel: 'low', params: z.object({}) }]),
            execute: async () => ({ success: true }),
          } as ReturnType<typeof integrationRegistry.getActions>)
        : undefined,
    );

    const appDb = {} as Parameters<typeof listTools>[0];
    const env = {} as Parameters<typeof listTools>[2];
    const d1 = {} as Parameters<typeof listTools>[1];

    const result = await listTools(appDb, d1, env, 'u1', { service: 'workflows' } as Parameters<typeof listTools>[4]);
    expect(result.tools.some((t) => t.id === 'workflows:list_workflows')).toBe(true);
  });
});
