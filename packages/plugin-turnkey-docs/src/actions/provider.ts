import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const turnkeyDocsProvider: IntegrationProvider = {
  service: 'turnkey-docs',
  displayName: 'Turnkey Docs',
  authType: 'none',
  supportedEntities: ['documentation'],
  oauthScopes: [],

  validateCredentials(_credentials: IntegrationCredentials): boolean {
    return true;
  },

  async testConnection(_credentials: IntegrationCredentials): Promise<boolean> {
    return true;
  },
};
