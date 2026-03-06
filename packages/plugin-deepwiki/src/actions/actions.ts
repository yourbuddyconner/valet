import { McpActionSource } from '@valet/sdk';

export const deepwikiActions = new McpActionSource({
  mcpUrl: 'https://mcp.deepwiki.com/mcp',
  serviceName: 'deepwiki',
  defaultRiskLevel: 'low',
  noAuth: true,
});
