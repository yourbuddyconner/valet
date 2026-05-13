import type { IntegrationPackage } from '@valet/sdk';
import { pylonProvider } from './provider.js';
import { pylonActions } from './actions.js';

export { pylonProvider } from './provider.js';
export { pylonActions } from './actions.js';

const pylonPackage: IntegrationPackage = {
  name: '@valet/actions-pylon',
  version: '0.0.1',
  service: 'pylon',
  provider: pylonProvider,
  actions: pylonActions,
};

export default pylonPackage;
