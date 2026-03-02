import { McpActionSource } from '@agent-ops/sdk';

export const linearActions = new McpActionSource({
  mcpUrl: 'https://mcp.linear.app/mcp',
  serviceName: 'linear',
  defaultRiskLevel: 'medium',
});
