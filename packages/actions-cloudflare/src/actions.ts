import { McpActionSource } from '@agent-ops/sdk';

export const cloudflareActions = new McpActionSource({
  mcpUrl: 'https://mcp.cloudflare.com/mcp',
  serviceName: 'cloudflare',
  defaultRiskLevel: 'medium',
});
