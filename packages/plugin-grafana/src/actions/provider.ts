import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const grafanaProvider: IntegrationProvider = {
  service: 'grafana',
  displayName: 'Grafana Cloud',
  authType: 'oauth2',
  supportedEntities: ['dashboards', 'prometheus', 'loki', 'alerts', 'incidents', 'oncall'],
  oauthScopes: [],
  mcpServerUrl: 'https://mcp.grafana.com',

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!credentials.access_token;
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    return !!credentials.access_token;
  },
};
