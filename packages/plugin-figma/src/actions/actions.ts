import { McpActionSource } from '@valet/sdk';

export const figmaActions = new McpActionSource({
  mcpUrl: 'https://mcp.figma.com/mcp',
  serviceName: 'figma',
  defaultRiskLevel: 'medium',
});
