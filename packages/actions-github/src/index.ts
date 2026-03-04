import type { IntegrationPackage } from '@valet/sdk';
import { githubProvider } from './provider.js';
import { githubActions } from './actions.js';
import { githubTriggers } from './triggers.js';

export { githubProvider } from './provider.js';
export { githubActions } from './actions.js';
export { githubTriggers } from './triggers.js';
export { githubFetch } from './api.js';

const githubPackage: IntegrationPackage = {
  name: '@valet/actions-github',
  version: '0.0.1',
  service: 'github',
  provider: githubProvider,
  actions: githubActions,
  triggers: githubTriggers,
};

export default githubPackage;
