import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const granolaProvider: IntegrationProvider = {
  service: 'granola',
  displayName: 'Granola',
  authType: 'oauth2',
  supportedEntities: ['meetings', 'notes'],
  oauthScopes: ['openid', 'profile', 'email', 'offline_access'],
  mcpServerUrl: 'https://mcp.granola.ai',

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!credentials.access_token;
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const res = await fetch('https://mcp.granola.ai/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'valet', version: '0.0.1' },
          },
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
