import type { IntegrationPackage } from '@agent-ops/sdk';
import { notionProvider } from './provider.js';
import { notionActions } from './actions.js';

export { notionProvider } from './provider.js';
export { notionActions } from './actions.js';

const notionPackage: IntegrationPackage = {
  name: '@agent-ops/actions-notion',
  version: '0.0.1',
  service: 'notion',
  provider: notionProvider,
  actions: notionActions,
};

export default notionPackage;
