import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const workflowsProvider: IntegrationProvider = {
  service: 'workflows',
  displayName: 'Workflows',
  authType: 'none',
  internal: true,
  supportedEntities: ['workflows', 'triggers', 'executions'],
  oauthScopes: [],
  validateCredentials(_c: IntegrationCredentials): boolean {
    return true;
  },
  async testConnection(_c: IntegrationCredentials): Promise<boolean> {
    return true;
  },
};
