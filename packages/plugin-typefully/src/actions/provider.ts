import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';
import { McpClient } from '@valet/sdk';

export const typefullyProvider: IntegrationProvider = {
  service: 'typefully',
  displayName: 'Typefully',
  authType: 'api_key',
  supportedEntities: ['posts', 'drafts', 'accounts'],

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!credentials.access_token;
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const client = new McpClient({
        url: 'https://mcp.typefully.com/mcp',
        serviceName: 'typefully',
        authQueryParam: 'TYPEFULLY_API_KEY',
      });
      const tools = await client.listTools(credentials.access_token);
      return tools.length > 0;
    } catch {
      return false;
    }
  },
};
