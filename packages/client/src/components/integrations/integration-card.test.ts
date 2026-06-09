import { describe, expect, it } from 'vitest';
import { getIntegrationConnectionLabel } from './integration-card';
import type { IntegrationListItem } from '@/api/integrations';

function integration(overrides: Partial<IntegrationListItem>): IntegrationListItem {
  return {
    id: 'integration-1',
    service: 'salesforce-mcp',
    status: 'active',
    scope: 'user',
    config: { entities: [] },
    createdAt: '2026-06-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('getIntegrationConnectionLabel', () => {
  it('labels custom OAuth connectors as OAuth connections', () => {
    expect(getIntegrationConnectionLabel(integration({
      isCustomConnector: true,
      authType: 'oauth2',
    }))).toBe('OAuth connected');
  });

  it('labels custom API-key connectors as API key connections', () => {
    expect(getIntegrationConnectionLabel(integration({
      isCustomConnector: true,
      authType: 'api_key',
    }))).toBe('API key connected');
  });

  it('labels org-managed custom connectors without implying user OAuth', () => {
    expect(getIntegrationConnectionLabel(integration({
      scope: 'org',
      isOrgManagedConnector: true,
      authType: 'bearer',
    }))).toBe('Org-managed connector');
  });
});
