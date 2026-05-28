import { describe, it, expect } from 'vitest';
import { internalIntegrations } from './internal/index.js';
import { IntegrationRegistry } from './registry.js';

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
