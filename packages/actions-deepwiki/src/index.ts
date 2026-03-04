import type { IntegrationPackage } from '@valet/sdk';
import { deepwikiProvider } from './provider.js';
import { deepwikiActions } from './actions.js';

export { deepwikiProvider } from './provider.js';
export { deepwikiActions } from './actions.js';

const deepwikiPackage: IntegrationPackage = {
  name: '@valet/actions-deepwiki',
  version: '0.0.1',
  service: 'deepwiki',
  provider: deepwikiProvider,
  actions: deepwikiActions,
};

export default deepwikiPackage;
