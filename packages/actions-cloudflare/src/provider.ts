import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const cloudflareProvider: IntegrationProvider = {
  service: 'cloudflare',
  displayName: 'Cloudflare',
  authType: 'oauth2',
  supportedEntities: ['zones', 'dns', 'workers', 'pages'],
  oauthScopes: [],
  mcpServerUrl: 'https://mcp.cloudflare.com',

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!credentials.access_token;
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
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
