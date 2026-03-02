import { McpActionSource } from '@agent-ops/sdk';

export const deepwikiActions = new McpActionSource({
  mcpUrl: 'https://mcp.deepwiki.com/mcp',
  serviceName: 'deepwiki',
  defaultRiskLevel: 'low',
  noAuth: true,
});
