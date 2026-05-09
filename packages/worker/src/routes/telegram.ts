import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';
import * as telegramService from '../services/telegram.js';

// ─── API Router (authenticated — user calls this) ───────────────────────────

export const telegramApiRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /api/me/telegram — Set up Telegram bot
 * Body: { botToken: string }
 */
telegramApiRouter.post('/', async (c) => {
  const user = c.get('user');
  const { botToken } = await c.req.json<{ botToken: string }>();

  const workerUrl = new URL(c.req.url).origin;
  const result = await telegramService.setupTelegramBot(
    c.env, user.id, botToken, workerUrl,
  );

  if (!result.ok) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({ config: result.config, webhookUrl: result.webhookUrl });
});

/**
 * GET /api/me/telegram — Get current Telegram config
 */
telegramApiRouter.get('/', async (c) => {
  const user = c.get('user');
  const config = await db.getUserTelegramConfig(c.get('db'), user.id);
  return c.json({ config });
});

/**
 * DELETE /api/me/telegram — Disconnect Telegram bot
 */
telegramApiRouter.delete('/', async (c) => {
  const user = c.get('user');
  await telegramService.disconnectTelegramBot(c.env, user.id);
  return c.json({ success: true });
});

/**
 * PATCH /api/me/telegram — Update Telegram config
 * Body: { ownerTelegramUserId?: string }
 */
telegramApiRouter.patch('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ ownerTelegramUserId?: string }>();

  if (body.ownerTelegramUserId !== undefined) {
    if (typeof body.ownerTelegramUserId !== 'string' || body.ownerTelegramUserId.length > 64) {
      return c.json({ error: 'Invalid ownerTelegramUserId' }, 400);
    }
    await db.updateTelegramOwner(c.get('db'), user.id, body.ownerTelegramUserId);
  }

  const config = await db.getUserTelegramConfig(c.get('db'), user.id);
  return c.json({ config });
});
