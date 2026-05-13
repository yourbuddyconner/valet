import { McpActionSource } from '@valet/sdk';

export const granolaActions = new McpActionSource({
  mcpUrl: 'https://mcp.granola.ai/mcp',
  serviceName: 'granola',
  defaultRiskLevel: 'low',
});
