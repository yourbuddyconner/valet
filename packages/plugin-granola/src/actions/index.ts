import type { IntegrationPackage } from '@valet/sdk';
import { granolaProvider } from './provider.js';
import { granolaActions } from './actions.js';

export { granolaProvider } from './provider.js';
export { granolaActions } from './actions.js';

const granolaPackage: IntegrationPackage = {
  name: '@valet/actions-granola',
  version: '0.0.1',
  service: 'granola',
  provider: granolaProvider,
  actions: granolaActions,
};

export default granolaPackage;
