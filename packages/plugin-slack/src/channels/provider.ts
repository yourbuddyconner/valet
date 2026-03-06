import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const slackProvider: IntegrationProvider = {
  service: 'slack',
  displayName: 'Slack',
  authType: 'oauth2',
  supportedEntities: [],

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!(credentials.access_token || credentials.bot_token);
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const token = credentials.access_token || credentials.bot_token || '';
      const res = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false;
      const data = await res.json() as { ok: boolean };
      return data.ok;
    } catch {
      return false;
    }
  },
};
