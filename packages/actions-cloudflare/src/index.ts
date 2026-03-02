import type { IntegrationPackage } from '@agent-ops/sdk';
import { cloudflareProvider } from './provider.js';
import { cloudflareActions } from './actions.js';

export { cloudflareProvider } from './provider.js';
export { cloudflareActions } from './actions.js';

const cloudflarePackage: IntegrationPackage = {
  name: '@agent-ops/actions-cloudflare',
  version: '0.0.1',
  service: 'cloudflare',
  provider: cloudflareProvider,
  actions: cloudflareActions,
};

export default cloudflarePackage;
