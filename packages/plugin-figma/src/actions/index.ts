import type { IntegrationPackage } from '@valet/sdk';
import { figmaProvider } from './provider.js';
import { figmaActions } from './actions.js';

export { figmaProvider } from './provider.js';
export { figmaActions } from './actions.js';

const figmaPackage: IntegrationPackage = {
  name: '@valet/actions-figma',
  version: '0.0.1',
  service: 'figma',
  provider: figmaProvider,
  actions: figmaActions,
};

export default figmaPackage;
