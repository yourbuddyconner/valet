import { McpActionSource } from '@agent-ops/sdk';

export const sentryActions = new McpActionSource({
  mcpUrl: 'https://mcp.sentry.dev/mcp',
  serviceName: 'sentry',
  defaultRiskLevel: 'medium',
});
