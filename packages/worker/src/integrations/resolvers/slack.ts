import { getSlackBotToken } from '../../services/slack.js';
import { getCredential } from '../../services/credentials.js';
import type { CredentialResolver } from '../registry.js';

/**
 * Slack credential resolver.
 * Org-scoped: uses the org-level bot token from org_slack_installs.
 * User-scoped: falls back to per-user credentials (standard OAuth).
 */
export const slackCredentialResolver: CredentialResolver = async (
  service,
  env,
  userId,
  scope,
  options,
) => {
  // Always try org-level bot token first (from DB install or SLACK_BOT_TOKEN env var)
  const botToken = await getSlackBotToken(env);
  if (botToken) {
    return {
      ok: true,
      credential: {
        accessToken: botToken,
        credentialType: 'bot_token',
        refreshed: false,
      },
    };
  }

  // Fall back to per-user credentials (e.g. user-scoped OAuth)
  if (scope === 'user') {
    return getCredential(env, userId, service, options);
  }

  return {
    ok: false,
    error: {
      service,
      reason: 'not_found',
      message: 'No Slack bot token found. Set SLACK_BOT_TOKEN or install in Settings.',
    },
  };
};
