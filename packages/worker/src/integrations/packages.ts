import type { IntegrationPackage } from '@agent-ops/sdk';
import githubPackage from '@agent-ops/actions-github';
import gmailPackage from '@agent-ops/actions-gmail';
import googleCalendarPackage from '@agent-ops/actions-google-calendar';

/** All installed integration packages. Add new integrations here. */
export const installedIntegrations: IntegrationPackage[] = [
  githubPackage,
  gmailPackage,
  googleCalendarPackage,
];
