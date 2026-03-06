import { McpActionSource } from '@valet/sdk';

export const notionActions = new McpActionSource({
  mcpUrl: 'https://mcp.notion.com/mcp',
  serviceName: 'notion',
  defaultRiskLevel: 'medium',
});
