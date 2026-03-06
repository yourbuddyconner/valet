import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const telegramProvider: IntegrationProvider = {
  service: 'telegram',
  displayName: 'Telegram',
  authType: 'bot_token',
  supportedEntities: [],

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!credentials.bot_token;
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${credentials.bot_token}/getMe`);
      return res.ok;
    } catch {
      return false;
    }
  },
};
