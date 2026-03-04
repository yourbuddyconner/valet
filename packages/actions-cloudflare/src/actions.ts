import { McpActionSource } from '@valet/sdk';

export const cloudflareActions = new McpActionSource({
  mcpUrl: 'https://mcp.cloudflare.com/mcp',
  serviceName: 'cloudflare',
  defaultRiskLevel: 'medium',
});
