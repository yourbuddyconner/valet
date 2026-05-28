import { describe, it, expect } from 'vitest';
import { internalIntegrations, registerInternalIntegrations } from './internal/index.js';
import { IntegrationRegistry } from './registry.js';
import { integrationRegistry } from './registry.js';

describe('internal integrations registration', () => {
  it('exports an internalIntegrations array', () => {
    expect(Array.isArray(internalIntegrations)).toBe(true);
  });

  it('registers internal packages in the registry after registerInternalIntegrations', () => {
    // Build a fresh registry and register internal packages via the composition-root helper.
    const reg = new IntegrationRegistry();
    reg.init();
    registerInternalIntegrations(reg);
    for (const pkg of internalIntegrations) {
      expect(reg.getPackage(pkg.service)?.service).toBe(pkg.service);
    }
  });
});

describe('workflows internal package registration', () => {
  it('registers the workflows service as an internal provider with actions', async () => {
    integrationRegistry.init();
    registerInternalIntegrations(integrationRegistry);
    const provider = integrationRegistry.getProvider('workflows');
    expect(provider?.internal).toBe(true);
    expect(provider?.authType).toBe('none');
    const actions = integrationRegistry.getActions('workflows');
    expect(actions).toBeDefined();
    const actionList = await actions!.listActions();
    expect(actionList.length).toBe(22);
  });
});
