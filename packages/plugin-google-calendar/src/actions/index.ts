import type { IntegrationPackage } from '@valet/sdk';
import { googleCalendarProvider } from './provider.js';
import { googleCalendarActions } from './actions.js';

export { googleCalendarProvider } from './provider.js';
export { googleCalendarActions } from './actions.js';
export { calendarFetch } from './api.js';

const googleCalendarPackage: IntegrationPackage = {
  name: '@valet/actions-google-calendar',
  version: '0.0.1',
  service: 'google_calendar',
  provider: googleCalendarProvider,
  actions: googleCalendarActions,
};

export default googleCalendarPackage;
