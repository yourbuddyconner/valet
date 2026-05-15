import { McpActionSource } from '@valet/sdk';

export const turnkeyDocsActions = new McpActionSource({
  mcpUrl: 'https://docs.turnkey.com/mcp',
  serviceName: 'turnkey-docs',
  defaultRiskLevel: 'low',
  noAuth: true,
});
