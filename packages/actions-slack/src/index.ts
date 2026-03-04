import type { IntegrationPackage } from '@valet/sdk';
import { slackProvider } from './provider.js';
import { slackActions } from './actions.js';

export { slackProvider } from './provider.js';
export { slackActions } from './actions.js';
export { slackFetch } from './api.js';

const slackPackage: IntegrationPackage = {
  name: '@valet/actions-slack',
  version: '0.0.1',
  service: 'slack',
  provider: slackProvider,
  actions: slackActions,
};

export default slackPackage;
