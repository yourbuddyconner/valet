import { McpActionSource } from '@valet/sdk';

export const linearActions = new McpActionSource({
  mcpUrl: 'https://mcp.linear.app/mcp',
  serviceName: 'linear',
  defaultRiskLevel: 'medium',
});
