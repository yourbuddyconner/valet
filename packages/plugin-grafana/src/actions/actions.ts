import { McpActionSource } from '@valet/sdk';

export const grafanaActions = new McpActionSource({
  mcpUrl: 'https://mcp.grafana.com/mcp',
  serviceName: 'grafana',
  defaultRiskLevel: 'low',
});
