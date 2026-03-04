import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const deepwikiProvider: IntegrationProvider = {
  service: 'deepwiki',
  displayName: 'DeepWiki',
  authType: 'none',
  supportedEntities: ['repositories', 'documentation'],
  oauthScopes: [],

  validateCredentials(_credentials: IntegrationCredentials): boolean {
    return true;
  },

  async testConnection(_credentials: IntegrationCredentials): Promise<boolean> {
    return true;
  },
};
