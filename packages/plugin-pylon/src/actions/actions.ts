import { McpActionSource } from '@valet/sdk';

export const pylonActions = new McpActionSource({
  mcpUrl: 'https://mcp.usepylon.com/mcp',
  serviceName: 'pylon',
  defaultRiskLevel: 'low',
});
