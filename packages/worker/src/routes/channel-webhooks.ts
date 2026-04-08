import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { channelScopeKey, SLASH_COMMANDS } from '@valet/shared';
import type { ChannelTransport, ChannelTarget, ChannelContext, InboundMessage } from '@valet/sdk';
import { channelRegistry } from '../channels/registry.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { getCredential } from '../services/credentials.js';
import { dispatchOrchestratorPrompt } from '../lib/workflow-runtime.js';

export const channelWebhooksRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Map InboundAttachments to the DO prompt attachment format. */
function mapAttachments(message: InboundMessage) {
  return message.attachments.map((a) => ({
    type: 'file' as const,
    mime: a.mimeType,
    url: a.url,
    filename: a.fileName,
  }));
}

// ─── Universal Webhook Route ─────────────────────────────────────────────────

/**
 * POST /channels/:channelType/webhook/:userId
 * Universal webhook endpoint. Each channel transport handles parsing/verification.
 */
channelWebhooksRouter.post('/:channelType/webhook/:userId', async (c) => {
  const channelType = c.req.param('channelType');
  const userId = c.req.param('userId');

  const transport = channelRegistry.getTransport(channelType);
  if (!transport) {
    return c.json({ error: `Unknown channel type: ${channelType}` }, 404);
  }

  const [credResult, config] = await Promise.all([
    getCredential(c.env, 'user', userId, channelType),
    channelType === 'telegram' ? db.getUserTelegramConfig(c.get('db'), userId) : Promise.resolve(null),
  ]);
  if (!credResult.ok) {
    return c.json({ error: `No ${channelType} config` }, 404);
  }

  const botToken = credResult.credential.accessToken;
  const rawBody = await c.req.text();
  const rawHeaders: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    rawHeaders[key] = value;
  });

  // ─── Telegram: Parse update once, handle callback_query ────────────
  let telegramUpdate: Record<string, unknown> | undefined;
  if (channelType === 'telegram') {
    try {
      telegramUpdate = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return c.json({ ok: true });
    }

    const callbackQuery = telegramUpdate.callback_query as Record<string, unknown> | undefined;
    if (callbackQuery) {
      const callbackId = callbackQuery.id as string;
      const callbackData = callbackQuery.data as string | undefined;
      const from = callbackQuery.from as Record<string, unknown> | undefined;
      const fromId = from?.id ? String(from.id) : '';

      // Verify owner
      if (config?.ownerTelegramUserId && fromId !== config.ownerTelegramUserId) {
        await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: callbackId, text: 'Not authorized' }),
        });
        return c.json({ ok: true });
      }

      // Answer the callback query to dismiss loading spinner
      await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackId }),
      });

      // Parse callback_data: "actionId|promptId"
      if (callbackData) {
        const pipeIdx = callbackData.indexOf('|');
        if (pipeIdx > 0) {
          const actionId = callbackData.slice(0, pipeIdx);
          const promptId = callbackData.slice(pipeIdx + 1);

          if (promptId) {
            // Resolve session: try D1 invocation record (approvals), then orchestrator session (questions)
            c.executionCtx.waitUntil((async () => {
              try {
                let targetSessionId: string | undefined;

                // Approval prompts have a D1 action_invocations record
                const inv = await db.getInvocation(c.get('db'), promptId);
                if (inv) {
                  if (inv.status !== 'pending') {
                    console.log(`[Telegram callback_query] Invocation ${promptId} not pending (${inv.status})`);
                    return;
                  }
                  if (inv.userId !== userId) {
                    console.log(`[Telegram callback_query] User ${userId} not authorized for invocation ${promptId}`);
                    return;
                  }
                  targetSessionId = inv.sessionId;
                } else {
                  // Question prompts don't have D1 records — fall back to orchestrator session
                  const orchSession = await db.getOrchestratorSession(c.env.DB, userId);
                  targetSessionId = orchSession?.id;
                }

                if (!targetSessionId) {
                  console.log(`[Telegram callback_query] No session found for prompt ${promptId}`);
                  return;
                }

                // Verify session is still active before dispatching to the DO
                const targetSession = await db.getSession(c.get('db'), targetSessionId);
                if (!targetSession || ['terminated', 'archived', 'error'].includes(targetSession.status)) {
                  console.log(`[Telegram callback_query] Session ${targetSessionId} is not active (status=${targetSession?.status})`);
                  return;
                }

                const doId = c.env.SESSIONS.idFromName(targetSessionId);
                const stub = c.env.SESSIONS.get(doId);
                await stub.fetch(new Request('https://session/prompt-resolved', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    promptId,
                    actionId,
                    resolvedBy: userId,
                  }),
                }));
              } catch (err) {
                console.error('[Telegram callback_query] Failed to notify DO:', err);
              }
            })());
          }
        }
      }

      return c.json({ ok: true });
    }
  }

  // Parse inbound message
  const message = await transport.parseInbound(rawHeaders, rawBody, {
    userId,
    botToken,
    botInfo: config?.botInfo ? JSON.parse(config.botInfo) : undefined,
  });

  if (!message) {
    return c.json({ ok: true });
  }

  // ─── Telegram: Owner verification + group chat filtering ─────────────
  if (channelType === 'telegram' && config) {
    const ownerTelegramUserId = config.ownerTelegramUserId;

    // If owner is set, verify sender matches
    if (ownerTelegramUserId && message.senderId !== ownerTelegramUserId) {
      console.log(`[Channel:${channelType}] Ignoring non-owner message: sender=${message.senderId} owner=${ownerTelegramUserId}`);
      return c.json({ ok: true });
    }

    // Use already-parsed update for chat.type (not available on InboundMessage)
    const tgMsg = (telegramUpdate?.message ?? telegramUpdate?.edited_message) as Record<string, unknown> | undefined;
    const chat = tgMsg?.chat as Record<string, unknown> | undefined;
    const chatType = chat?.type as string | undefined;
    const isGroup = chatType === 'group' || chatType === 'supergroup';

    if (isGroup && !message.command) {
      // In groups without privacy mode bypass (bot is admin), we only get
      // commands and replies anyway. If privacy mode is off (bot is admin),
      // we also get regular messages — check for @bot mention via entities.
      const botUsername = config.botUsername;
      let isMention = false;
      if (botUsername) {
        // Use raw text from Telegram update — entity offsets reference the original text,
        // not the formatted text from parseInbound (which may add blockquote/attribution).
        const rawText = (tgMsg?.text as string) || '';
        const entities = (tgMsg?.entities ?? []) as Array<{ type: string; offset: number; length: number }>;
        isMention = entities.some((e) =>
          e.type === 'mention' && rawText.substring(e.offset, e.offset + e.length) === `@${botUsername}`,
        );
      }
      if (!isMention) {
        console.log(`[Channel:${channelType}] Ignoring non-mention group message`);
        return c.json({ ok: true });
      }
    }
  }

  // Handle slash commands
  if (message.command) {
    const ctx: ChannelContext = { token: botToken, userId };
    const target: ChannelTarget = { channelType, channelId: message.channelId };
    await handleChannelCommand(c.env, transport, target, ctx, message, userId);
    return c.json({ ok: true });
  }

  // Build scope key and look up channel binding
  const parts = transport.scopeKeyParts(message, userId);
  const scopeKey = channelScopeKey(userId, parts.channelType, parts.channelId);
  let binding = await db.getChannelBindingByScopeKey(c.get('db'), scopeKey);

  // Evict stale bindings that point to terminated/archived/error sessions
  if (binding) {
    const boundSession = await db.getSession(c.get('db'), binding.sessionId);
    if (boundSession && ['terminated', 'archived', 'error'].includes(boundSession.status)) {
      console.log(`[Channel:${channelType}] Evicting stale binding: session=${binding.sessionId} status=${boundSession.status}`);
      await db.deleteChannelBinding(c.get('db'), binding.id);
      binding = null;
    }
  }

  // ─── Resolve orchestrator thread (Telegram) ──────────────────────────
  let orchestratorThreadId: string | undefined;
  if (channelType === 'telegram') {
    let targetSessionId: string | undefined;

    if (binding) {
      targetSessionId = binding.sessionId;
    } else {
      const orchSession = await db.getOrchestratorSession(c.env.DB, userId);
      targetSessionId = orchSession?.id;
    }

    if (targetSessionId) {
      const THREAD_RESOLVE_RETRIES = 3;
      for (let attempt = 1; attempt <= THREAD_RESOLVE_RETRIES; attempt++) {
        try {
          orchestratorThreadId = await db.getOrCreateChannelThread(c.env.DB, {
            channelType: 'telegram',
            channelId: message.channelId,
            externalThreadId: message.channelId,
            sessionId: targetSessionId,
            userId,
          });
          console.log(`[Channel:${channelType}] Resolved thread: chat=${message.channelId} → orchestrator=${orchestratorThreadId}`);
          break;
        } catch (err) {
          console.error(`[Channel:${channelType}] Thread resolution attempt ${attempt}/${THREAD_RESOLVE_RETRIES} failed:`, err);
          if (attempt < THREAD_RESOLVE_RETRIES) {
            await new Promise((r) => setTimeout(r, 100 * attempt));
          }
        }
      }
    }
  }

  const attachments = mapAttachments(message);

  if (binding) {
    console.log(`[Channel:${channelType}] Bound session dispatch: session=${binding.sessionId} channelId=${message.channelId}`);
    const doId = c.env.SESSIONS.idFromName(binding.sessionId);
    const sessionDO = c.env.SESSIONS.get(doId);
    try {
      const resp = await sessionDO.fetch(
        new Request('http://do/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: message.text,
            attachments: attachments.length > 0 ? attachments : undefined,
            queueMode: binding.queueMode || 'steer',
            channelType,
            channelId: message.channelId,
            threadId: orchestratorThreadId,
            authorName: message.senderName,
            replyTo: { channelType, channelId: message.channelId },
          }),
        }),
      );
      console.log(`[Channel:${channelType}] Bound session response: status=${resp.status}`);
      if (resp.ok) return c.json({ ok: true });
      if (resp.status === 409) {
        // 409 = session terminated/archived. The DO rejected without processing.
        // Stale binding eviction (lines 214-222) usually catches this, but there's
        // a narrow race between D1 status and DO state. Safe to fall through to
        // orchestrator since the message was NOT processed by the bound session.
        console.warn(`[Channel:${channelType}] Bound session returned 409 (terminated), falling through to orchestrator`);
      } else {
        // Other non-OK (400, 500, etc.): the DO received the request and may have
        // partially processed it. Do NOT also dispatch to orchestrator — that causes
        // duplicate responses. Log and return.
        console.warn(`[Channel:${channelType}] Bound session rejected prompt (status=${resp.status}), not falling through to orchestrator`);
        return c.json({ ok: true });
      }
    } catch (err) {
      // Fetch-level failure (DO unreachable, network error). The message was NOT delivered.
      // Safe to fall through to orchestrator as a degraded path.
      console.error(`[Channel:${channelType}] Failed to route to session ${binding.sessionId}, falling through to orchestrator:`, err);
    }

    // Bound session failed with 409 or network error — re-resolve thread for the orchestrator session before fallthrough
    if (channelType === 'telegram' && orchestratorThreadId) {
      const orchSession = await db.getOrchestratorSession(c.env.DB, userId);
      if (orchSession && orchSession.id !== binding.sessionId) {
        try {
          orchestratorThreadId = await db.getOrCreateChannelThread(c.env.DB, {
            channelType: 'telegram',
            channelId: message.channelId,
            externalThreadId: message.channelId,
            sessionId: orchSession.id,
            userId,
          });
        } catch (err) {
          console.error(`[Channel:${channelType}] Thread re-resolution for orchestrator failed:`, err);
        }
      }
    }
  } else {
    console.log(`[Channel:${channelType}] No binding for scopeKey=${scopeKey}, falling through to orchestrator`);
  }

  // Dispatch to orchestrator

  console.log(`[Channel:${channelType}] Orchestrator dispatch: userId=${userId} channelId=${message.channelId}`);
  const result = await dispatchOrchestratorPrompt(c.env, {
    userId,
    content: message.text || '[Attachment]',
    channelType,
    channelId: message.channelId,
    threadId: orchestratorThreadId,
    authorName: message.senderName,
    attachments: attachments.length > 0 ? attachments : undefined,
    replyTo: { channelType, channelId: message.channelId },
  });

  if (!result.dispatched) {
    const ctx: ChannelContext = { token: botToken, userId };
    const target: ChannelTarget = { channelType, channelId: message.channelId };
    await transport.sendMessage(target, {
      markdown: 'Your orchestrator is not running. Start it from the Valet dashboard.',
    }, ctx);
  }

  return c.json({ ok: true });
});

// ─── Universal Slash Command Handler ─────────────────────────────────────────

export async function handleChannelCommand(
  env: Env,
  transport: ChannelTransport,
  target: ChannelTarget,
  ctx: ChannelContext,
  message: InboundMessage,
  userId: string,
): Promise<void> {
  const command = message.command!;

  // Resolve orchestrator session ID
  const orchSession = await db.getOrchestratorSession(env.DB, userId);

  switch (command) {
    case 'start': {
      // Capture owner's Telegram user ID on first /start
      if (message.senderId && target.channelType === 'telegram') {
        try {
          await db.updateTelegramOwner(getDb(env.DB), userId, message.senderId);
        } catch (err) {
          console.error(`[Channel:${target.channelType}] Failed to capture owner:`, err);
        }
      }
      await transport.sendMessage(target, {
        markdown: 'Connected to Valet! Send me a message and it will be routed to your orchestrator.',
      }, ctx);
      break;
    }

    case 'help': {
      const commands = SLASH_COMMANDS.filter((cmd) => cmd.availableIn.includes(transport.channelType as any));
      const text = commands.map((cmd) => `/${cmd.name} — ${cmd.description}`).join('\n');
      await transport.sendMessage(target, { markdown: `Available commands:\n${text}` }, ctx);
      break;
    }

    case 'status': {
      if (!orchSession || ['terminated', 'archived', 'error'].includes(orchSession.status)) {
        await transport.sendMessage(target, { markdown: 'Your orchestrator is not running. Start it from the Valet dashboard.' }, ctx);
        return;
      }
      try {
        const doId = env.SESSIONS.idFromName(orchSession.id);
        const sessionDO = env.SESSIONS.get(doId);
        const resp = await sessionDO.fetch(new Request('http://do/status'));
        if (!resp.ok) {
          await transport.sendMessage(target, { markdown: 'Could not get orchestrator status.' }, ctx);
          return;
        }
        const status = (await resp.json()) as Record<string, unknown>;
        let text = `*Orchestrator Status*\nStatus: ${status.status || 'unknown'}`;
        if (status.runnerConnected) text += '\nRunner: connected';
        if (status.promptsQueued) text += `\nQueued prompts: ${status.promptsQueued}`;
        await transport.sendMessage(target, { markdown: text }, ctx);
      } catch {
        await transport.sendMessage(target, { markdown: 'Orchestrator is not running.' }, ctx);
      }
      break;
    }

    case 'stop': {
      if (!orchSession || ['terminated', 'archived', 'error'].includes(orchSession.status)) {
        await transport.sendMessage(target, { markdown: 'Your orchestrator is not running.' }, ctx);
        return;
      }
      try {
        const doId = env.SESSIONS.idFromName(orchSession.id);
        const sessionDO = env.SESSIONS.get(doId);
        await sessionDO.fetch(new Request('http://do/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ interrupt: true, content: '' }),
        }));
        await sessionDO.fetch(new Request('http://do/clear-queue', { method: 'POST' }));
        await transport.sendMessage(target, { markdown: 'Stopped current work and cleared queue.' }, ctx);
      } catch {
        await transport.sendMessage(target, { markdown: 'Could not stop — orchestrator may not be running.' }, ctx);
      }
      break;
    }

    case 'clear': {
      if (!orchSession || ['terminated', 'archived', 'error'].includes(orchSession.status)) {
        await transport.sendMessage(target, { markdown: 'Your orchestrator is not running.' }, ctx);
        return;
      }
      try {
        const doId = env.SESSIONS.idFromName(orchSession.id);
        const sessionDO = env.SESSIONS.get(doId);
        await sessionDO.fetch(new Request('http://do/clear-queue', { method: 'POST' }));
        await transport.sendMessage(target, { markdown: 'Prompt queue cleared.' }, ctx);
      } catch {
        await transport.sendMessage(target, { markdown: 'Could not clear queue — orchestrator may not be running.' }, ctx);
      }
      break;
    }

    case 'refresh': {
      if (!orchSession || ['terminated', 'archived', 'error'].includes(orchSession.status)) {
        await transport.sendMessage(target, { markdown: 'Your orchestrator is not running.' }, ctx);
        return;
      }
      try {
        const doId = env.SESSIONS.idFromName(orchSession.id);
        const sessionDO = env.SESSIONS.get(doId);
        await sessionDO.fetch(new Request('http://do/stop', { method: 'POST' }));
        await sessionDO.fetch(new Request('http://do/start', { method: 'POST' }));
        await transport.sendMessage(target, { markdown: 'Orchestrator session refreshed.' }, ctx);
      } catch {
        await transport.sendMessage(target, { markdown: 'Could not refresh — orchestrator may not be running.' }, ctx);
      }
      break;
    }

    case 'sessions': {
      if (!orchSession || ['terminated', 'archived', 'error'].includes(orchSession.status)) {
        await transport.sendMessage(target, { markdown: 'Your orchestrator is not running.' }, ctx);
        return;
      }
      try {
        const doId = env.SESSIONS.idFromName(orchSession.id);
        const sessionDO = env.SESSIONS.get(doId);
        const resp = await sessionDO.fetch(new Request('http://do/children'));
        if (!resp.ok) {
          await transport.sendMessage(target, { markdown: 'Could not list sessions.' }, ctx);
          return;
        }
        const data = (await resp.json()) as {
          children?: Array<{ id: string; title?: string; status: string; workspace?: string }>;
        };
        const list = data.children || [];
        if (list.length === 0) {
          await transport.sendMessage(target, { markdown: 'No child sessions.' }, ctx);
          return;
        }
        const lines = list.map(
          (child) => `• ${child.title || child.workspace || child.id.slice(0, 8)} — ${child.status}`,
        );
        await transport.sendMessage(target, {
          markdown: `Child sessions (${list.length}):\n${lines.join('\n')}`,
        }, ctx);
      } catch {
        await transport.sendMessage(target, {
          markdown: 'Could not list sessions — orchestrator may not be running.',
        }, ctx);
      }
      break;
    }

    default: {
      await transport.sendMessage(target, {
        markdown: `Unknown command: /${command}. Try /help for available commands.`,
      }, ctx);
    }
  }
}
