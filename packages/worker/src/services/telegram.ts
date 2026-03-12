import { SLASH_COMMANDS } from '@valet/shared';
import type { UserTelegramConfig } from '@valet/shared';
import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { storeCredential, getCredential, revokeCredential } from '../services/credentials.js';

const TG_API = 'https://api.telegram.org';

function botUrl(token: string, method: string): string {
  return `${TG_API}/bot${token}/${method}`;
}

// ─── Setup Telegram Bot ─────────────────────────────────────────────────────

export type SetupTelegramResult =
  | { ok: true; config: UserTelegramConfig & { webhookActive: boolean }; webhookUrl: string }
  | { ok: false; error: string };

export async function setupTelegramBot(
  env: Env,
  userId: string,
  botToken: string,
  workerUrl: string,
): Promise<SetupTelegramResult> {
  if (!botToken || typeof botToken !== 'string' || !botToken.trim()) {
    return { ok: false, error: 'botToken is required' };
  }

  const trimmedToken = botToken.trim();

  // Validate token by calling getMe()
  let botInfo: Record<string, unknown>;
  try {
    const resp = await fetch(botUrl(trimmedToken, 'getMe'));
    if (!resp.ok) {
      return { ok: false, error: 'Invalid bot token — could not reach Telegram API' };
    }
    const data = (await resp.json()) as { ok: boolean; result?: Record<string, unknown> };
    if (!data.ok || !data.result) {
      return { ok: false, error: 'Invalid bot token — could not reach Telegram API' };
    }
    botInfo = data.result;
  } catch {
    return { ok: false, error: 'Invalid bot token — could not reach Telegram API' };
  }

  // Store bot token in unified credentials table
  await storeCredential(env, 'user', userId, 'telegram', { bot_token: trimmedToken }, {
    credentialType: 'bot_token',
  });

  const appDb = getDb(env.DB);
  // Save metadata (token is in credentials table, not here)
  const config = await db.saveUserTelegramConfig(appDb, {
    id: crypto.randomUUID(),
    userId,
    botUsername: (botInfo.username as string) || (botInfo.first_name as string) || '',
    botInfo: JSON.stringify(botInfo),
  });

  // Register webhook with Telegram (new channel-based URL)
  const webhookUrl = `${workerUrl}/channels/telegram/webhook/${userId}`;
  const webhookResp = await fetch(botUrl(trimmedToken, 'setWebhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  });
  if (!webhookResp.ok) {
    console.error('Failed to set Telegram webhook:', await webhookResp.text().catch(() => ''));
  }

  // Register bot commands
  const tgCommands = SLASH_COMMANDS
    .filter((cmd) => cmd.availableIn.includes('telegram'))
    .map((cmd) => ({ command: cmd.name, description: cmd.description }));
  await fetch(botUrl(trimmedToken, 'setMyCommands'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: tgCommands }),
  }).catch(() => {
    // Best effort
  });

  // Update webhook status
  await db.updateTelegramWebhookStatus(appDb, userId, webhookUrl, true);

  return { ok: true, config: { ...config, webhookActive: true } as any, webhookUrl };
}

// ─── Disconnect Telegram Bot ────────────────────────────────────────────────

export async function disconnectTelegramBot(
  env: Env,
  userId: string,
): Promise<void> {
  const credResult = await getCredential(env, 'user', userId, 'telegram');
  if (credResult.ok) {
    try {
      await fetch(botUrl(credResult.credential.accessToken, 'deleteWebhook'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {
      // Best effort — token may be revoked
    }
  }

  // Remove credential and metadata
  await revokeCredential(env, 'user', userId, 'telegram');
  const appDb = getDb(env.DB);
  await db.deleteUserTelegramConfig(appDb, userId);
}
