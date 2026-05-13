import type { IntegrationPackage } from '@valet/sdk';
import { socketProvider } from './provider.js';
import { socketActions } from './actions.js';

export { socketProvider } from './provider.js';
export { socketActions } from './actions.js';

const socketPackage: IntegrationPackage = {
  name: '@valet/actions-socket',
  version: '0.0.1',
  service: 'socket',
  provider: socketProvider,
  actions: socketActions,
};

export default socketPackage;
