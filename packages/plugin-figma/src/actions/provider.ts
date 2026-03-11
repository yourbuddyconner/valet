import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const figmaProvider: IntegrationProvider = {
  service: 'figma',
  displayName: 'Figma',
  authType: 'oauth2',
  supportedEntities: ['files', 'projects', 'components'],
  oauthScopes: [],
  mcpServerUrl: 'https://mcp.figma.com',

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!credentials.access_token;
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const res = await fetch('https://api.figma.com/v1/me', {
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
