import type { IntegrationPackage } from '@valet/sdk';
import { grafanaProvider } from './provider.js';
import { grafanaActions } from './actions.js';

export { grafanaProvider } from './provider.js';
export { grafanaActions } from './actions.js';

const grafanaPackage: IntegrationPackage = {
  name: '@valet/actions-grafana',
  version: '0.0.1',
  service: 'grafana',
  provider: grafanaProvider,
  actions: grafanaActions,
};

export default grafanaPackage;
