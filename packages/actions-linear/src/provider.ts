import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const linearProvider: IntegrationProvider = {
  service: 'linear',
  displayName: 'Linear',
  authType: 'oauth2',
  supportedEntities: ['issues', 'projects', 'teams', 'comments'],
  oauthScopes: ['read', 'write'],
  mcpServerUrl: 'https://mcp.linear.app',

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!credentials.access_token;
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.access_token}`,
        },
        body: JSON.stringify({ query: '{ viewer { id } }' }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { data?: { viewer?: { id: string } } };
      return !!data.data?.viewer?.id;
    } catch {
      return false;
    }
  },
};
