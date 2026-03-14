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

    // Parse raw body again for chat.type (not available on InboundMessage)
    let chatType: string | undefined;
    try {
      const update = JSON.parse(rawBody) as Record<string, unknown>;
      const msg = (update.message ?? update.edited_message) as Record<string, unknown> | undefined;
      const chat = msg?.chat as Record<string, unknown> | undefined;
      chatType = chat?.type as string | undefined;
    } catch { /* ignore */ }

    const isGroup = chatType === 'group' || chatType === 'supergroup';

    if (isGroup && !message.command) {
      // In groups without privacy mode bypass (bot is admin), we only get
      // commands and replies anyway. If privacy mode is off (bot is admin),
      // we also get regular messages — check for @bot mention.
      const botUsername = config.botUsername;
      const isMention = botUsername && message.text?.includes(`@${botUsername}`);
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
  const binding = await db.getChannelBindingByScopeKey(c.get('db'), scopeKey);

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

  if (binding) {
    console.log(`[Channel:${channelType}] Bound session dispatch: session=${binding.sessionId} channelId=${message.channelId}`);
    const doId = c.env.SESSIONS.idFromName(binding.sessionId);
    const sessionDO = c.env.SESSIONS.get(doId);
    try {
      // Convert InboundAttachments to the DO prompt format
      const attachments = message.attachments.map((a) => ({
        type: 'file' as const,
        mime: a.mimeType,
        url: a.url,
        filename: a.fileName,
      }));

      const resp = await sessionDO.fetch(
        new Request('http://do/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: message.text,
            attachments: attachments.length > 0 ? attachments : undefined,
            queueMode: binding.queueMode,
            channelType,
            channelId: message.channelId,
            threadId: orchestratorThreadId,
            authorName: message.senderName,
          }),
        }),
      );
      console.log(`[Channel:${channelType}] Bound session response: status=${resp.status}`);
      if (resp.ok) return c.json({ ok: true });
    } catch (err) {
      console.error(`[Channel:${channelType}] Failed to route to session ${binding.sessionId}:`, err);
    }
  } else {
    console.log(`[Channel:${channelType}] No binding for scopeKey=${scopeKey}, falling through to orchestrator`);
  }

  // Dispatch to orchestrator
  const attachments = message.attachments.map((a) => ({
    type: 'file' as const,
    mime: a.mimeType,
    url: a.url,
    filename: a.fileName,
  }));

  console.log(`[Channel:${channelType}] Orchestrator dispatch: userId=${userId} channelId=${message.channelId}`);
  const result = await dispatchOrchestratorPrompt(c.env, {
    userId,
    content: message.text || '[Attachment]',
    channelType,
    channelId: message.channelId,
    threadId: orchestratorThreadId,
    authorName: message.senderName,
    attachments: attachments.length > 0 ? attachments : undefined,
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
  const orchestratorSessionId = orchSession?.id ?? `orchestrator:${userId}`;

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
      try {
        const doId = env.SESSIONS.idFromName(orchestratorSessionId);
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
      try {
        const doId = env.SESSIONS.idFromName(orchestratorSessionId);
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
      try {
        const doId = env.SESSIONS.idFromName(orchestratorSessionId);
        const sessionDO = env.SESSIONS.get(doId);
        await sessionDO.fetch(new Request('http://do/clear-queue', { method: 'POST' }));
        await transport.sendMessage(target, { markdown: 'Prompt queue cleared.' }, ctx);
      } catch {
        await transport.sendMessage(target, { markdown: 'Could not clear queue — orchestrator may not be running.' }, ctx);
      }
      break;
    }

    case 'refresh': {
      try {
        const doId = env.SESSIONS.idFromName(orchestratorSessionId);
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
      try {
        const doId = env.SESSIONS.idFromName(orchestratorSessionId);
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
