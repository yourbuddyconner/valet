import { McpActionSource } from '@valet/sdk';

export const typefullyActions = new McpActionSource({
  mcpUrl: 'https://mcp.typefully.com/mcp',
  serviceName: 'typefully',
  defaultRiskLevel: 'medium',
  authQueryParam: 'TYPEFULLY_API_KEY',
});
