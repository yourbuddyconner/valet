import type { IntegrationPackage } from '@valet/sdk';
import { sentryProvider } from './provider.js';
import { sentryActions } from './actions.js';

export { sentryProvider } from './provider.js';
export { sentryActions } from './actions.js';

const sentryPackage: IntegrationPackage = {
  name: '@valet/actions-sentry',
  version: '0.0.1',
  service: 'sentry',
  provider: sentryProvider,
  actions: sentryActions,
};

export default sentryPackage;
