import type { IntegrationPackage } from '@agent-ops/sdk';
import { stripeProvider } from './provider.js';
import { stripeActions } from './actions.js';

export { stripeProvider } from './provider.js';
export { stripeActions } from './actions.js';

const stripePackage: IntegrationPackage = {
  name: '@agent-ops/actions-stripe',
  version: '0.0.1',
  service: 'stripe',
  provider: stripeProvider,
  actions: stripeActions,
};

export default stripePackage;
