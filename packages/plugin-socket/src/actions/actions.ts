import { McpActionSource } from '@valet/sdk';

export const socketActions = new McpActionSource({
  mcpUrl: 'https://mcp.socket.dev/',
  serviceName: 'socket',
  defaultRiskLevel: 'low',
  noAuth: true,
});
