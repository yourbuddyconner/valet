import type { IntegrationPackage } from '@valet/sdk';
import { gmailProvider } from './provider.js';
import { gmailActions } from './actions.js';

export { gmailProvider } from './provider.js';
export { gmailActions } from './actions.js';
export { gmailFetch, decodeBase64Url, encodeBase64Url } from './api.js';

const gmailPackage: IntegrationPackage = {
  name: '@valet/actions-gmail',
  version: '0.0.1',
  service: 'gmail',
  provider: gmailProvider,
  actions: gmailActions,
};

export default gmailPackage;
