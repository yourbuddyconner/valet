import type { IntegrationPackage } from '@valet/sdk';
import { turnkeyDocsProvider } from './provider.js';
import { turnkeyDocsActions } from './actions.js';

export { turnkeyDocsProvider } from './provider.js';
export { turnkeyDocsActions } from './actions.js';

const turnkeyDocsPackage: IntegrationPackage = {
  name: '@valet/actions-turnkey-docs',
  version: '0.0.1',
  service: 'turnkey-docs',
  provider: turnkeyDocsProvider,
  actions: turnkeyDocsActions,
};

export default turnkeyDocsPackage;
