import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const socketProvider: IntegrationProvider = {
  service: 'socket',
  displayName: 'Socket.dev',
  authType: 'none',
  supportedEntities: ['packages', 'vulnerabilities'],
  oauthScopes: [],

  validateCredentials(_credentials: IntegrationCredentials): boolean {
    return true;
  },

  async testConnection(_credentials: IntegrationCredentials): Promise<boolean> {
    return true;
  },
};
