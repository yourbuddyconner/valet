import { McpActionSource } from '@valet/sdk';

export const stripeActions = new McpActionSource({
  mcpUrl: 'https://mcp.stripe.com/mcp',
  serviceName: 'stripe',
  defaultRiskLevel: 'medium',
});
