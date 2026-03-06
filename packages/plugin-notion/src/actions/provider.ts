import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const notionProvider: IntegrationProvider = {
  service: 'notion',
  displayName: 'Notion',
  authType: 'oauth2',
  supportedEntities: ['pages', 'databases', 'blocks'],
  oauthScopes: [],
  mcpServerUrl: 'https://mcp.notion.com',

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!credentials.access_token;
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const res = await fetch('https://api.notion.com/v1/users/me', {
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
          'Notion-Version': '2022-06-28',
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
