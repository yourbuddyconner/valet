import { McpActionSource } from '@agent-ops/sdk';

export const stripeActions = new McpActionSource({
  mcpUrl: 'https://mcp.stripe.com/mcp',
  serviceName: 'stripe',
  defaultRiskLevel: 'medium',
});
