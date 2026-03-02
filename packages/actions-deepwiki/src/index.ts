import type { IntegrationPackage } from '@agent-ops/sdk';
import { deepwikiProvider } from './provider.js';
import { deepwikiActions } from './actions.js';

export { deepwikiProvider } from './provider.js';
export { deepwikiActions } from './actions.js';

const deepwikiPackage: IntegrationPackage = {
  name: '@agent-ops/actions-deepwiki',
  version: '0.0.1',
  service: 'deepwiki',
  provider: deepwikiProvider,
  actions: deepwikiActions,
};

export default deepwikiPackage;
