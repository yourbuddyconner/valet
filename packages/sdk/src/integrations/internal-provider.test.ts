import { describe, it, expect } from 'vitest';
import type { IntegrationProvider, ActionContext } from './index.js';

describe('internal provider contract', () => {
  it('allows marking a provider internal', () => {
    const p: IntegrationProvider = {
      service: 'workflows',
      displayName: 'Workflows',
      authType: 'none',
      internal: true,
      supportedEntities: [],
      validateCredentials: () => true,
      testConnection: async () => true,
    };
    expect(p.internal).toBe(true);
  });

  it('ActionContext carries an optional internal handle', () => {
    const ctx: ActionContext = {
      credentials: {},
      userId: 'u1',
      internal: { db: {} as unknown, env: {} as unknown },
    };
    expect(ctx.internal).toBeDefined();
  });
});
