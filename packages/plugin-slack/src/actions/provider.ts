import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';
import { slackFetch } from './api.js';

export const slackProvider: IntegrationProvider = {
  service: 'slack',
  displayName: 'Slack',
  authType: 'bot_token',
  supportedEntities: ['channels', 'messages', 'users'],

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!credentials.bot_token;
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const token = credentials.bot_token || '';
      const res = await slackFetch('auth.test', token);
      if (!res.ok) return false;
      const data = (await res.json()) as { ok: boolean };
      return data.ok;
    } catch {
      return false;
    }
  },
};
