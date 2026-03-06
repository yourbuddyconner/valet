import type { IntegrationPackage } from '@valet/sdk';
import { linearProvider } from './provider.js';
import { linearActions } from './actions.js';

export { linearProvider } from './provider.js';
export { linearActions } from './actions.js';

const linearPackage: IntegrationPackage = {
  name: '@valet/actions-linear',
  version: '0.0.1',
  service: 'linear',
  provider: linearProvider,
  actions: linearActions,
};

export default linearPackage;
