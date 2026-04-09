import { getSlackBotToken } from '../../services/slack.js';
import type { CredentialResolver } from '../registry.js';

/**
 * Slack credential resolver.
 * Always uses the org-level bot token from org_slack_installs.
 */
export const slackCredentialResolver: CredentialResolver = async (
  service,
  env,
  _userId,
  _context,
) => {
  const botToken = await getSlackBotToken(env);
  if (botToken) {
    return {
      ok: true as const,
      credential: {
        accessToken: botToken,
        credentialType: 'bot_token',
        refreshed: false,
      },
    };
  }

  return {
    ok: false as const,
    error: {
      service,
      reason: 'not_found' as const,
      message: 'No Slack bot token found. Install Slack in Settings.',
    },
  };
};
