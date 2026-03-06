import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const sentryProvider: IntegrationProvider = {
  service: 'sentry',
  displayName: 'Sentry',
  authType: 'oauth2',
  supportedEntities: ['issues', 'projects', 'events'],
  oauthScopes: [],
  mcpServerUrl: 'https://mcp.sentry.dev',

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!credentials.access_token;
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    // MCP OAuth tokens are MCP-scoped; just validate the token is present.
    return !!credentials.access_token;
  },
};
