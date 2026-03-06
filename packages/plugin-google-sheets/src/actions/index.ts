import type { IntegrationPackage } from '@valet/sdk';
import { googleSheetsProvider } from './provider.js';
import { googleSheetsActions } from './actions.js';

export { googleSheetsProvider } from './provider.js';
export { googleSheetsActions } from './actions.js';
export { sheetsFetch } from './api.js';

const googleSheetsPackage: IntegrationPackage = {
  name: '@valet/actions-google-sheets',
  version: '0.0.1',
  service: 'google_sheets',
  provider: googleSheetsProvider,
  actions: googleSheetsActions,
};

export default googleSheetsPackage;
