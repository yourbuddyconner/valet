import type { IntegrationPackage } from '@valet/sdk';
import { workflowsProvider } from './provider.js';
import { workflowsActions } from './actions.js';

const workflowsPackage: IntegrationPackage = {
  name: '@valet/internal-workflows',
  version: '0.0.1',
  service: 'workflows',
  provider: workflowsProvider,
  actions: workflowsActions,
};

export default workflowsPackage;
