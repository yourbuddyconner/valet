import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const stripeProvider: IntegrationProvider = {
  service: 'stripe',
  displayName: 'Stripe',
  authType: 'oauth2',
  supportedEntities: ['customers', 'payments', 'subscriptions', 'invoices', 'products'],
  oauthScopes: [],
  mcpServerUrl: 'https://mcp.stripe.com',

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!credentials.access_token;
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const res = await fetch('https://api.stripe.com/v1/account', {
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
