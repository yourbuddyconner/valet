import { McpActionSource } from '@valet/sdk';

export const pylonActions = new McpActionSource({
  mcpUrl: 'https://mcp.usepylon.com',
  serviceName: 'pylon',
  defaultRiskLevel: 'low',
});
