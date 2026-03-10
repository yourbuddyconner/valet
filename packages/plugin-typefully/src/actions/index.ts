import type { IntegrationPackage } from '@valet/sdk';
import { typefullyProvider } from './provider.js';
import { typefullyActions } from './actions.js';

export { typefullyProvider } from './provider.js';
export { typefullyActions } from './actions.js';

const typefullyPackage: IntegrationPackage = {
  name: '@valet/actions-typefully',
  version: '0.0.1',
  service: 'typefully',
  provider: typefullyProvider,
  actions: typefullyActions,
};

export default typefullyPackage;
