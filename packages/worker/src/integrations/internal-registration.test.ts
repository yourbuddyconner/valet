import { describe, it, expect } from 'vitest';
import { internalIntegrations } from './internal/index.js';
import { IntegrationRegistry } from './registry.js';
import { integrationRegistry } from './registry.js';

describe('internal integrations registration', () => {
  it('exports an internalIntegrations array', () => {
    expect(Array.isArray(internalIntegrations)).toBe(true);
  });

  it('registers internal packages in the registry on init', () => {
    // Build a fresh registry and init it; every internal package should be resolvable.
    const reg = new IntegrationRegistry();
    reg.init();
    for (const pkg of internalIntegrations) {
      expect(reg.getPackage(pkg.service)?.service).toBe(pkg.service);
    }
  });
});

describe('workflows internal package registration', () => {
  it('registers the workflows service as an internal provider with actions', async () => {
    integrationRegistry.init();
    const provider = integrationRegistry.getProvider('workflows');
    expect(provider?.internal).toBe(true);
    expect(provider?.authType).toBe('none');
    const actions = integrationRegistry.getActions('workflows');
    expect(actions).toBeDefined();
    const actionList = await actions!.listActions();
    expect(actionList.length).toBe(22);
  });
});
