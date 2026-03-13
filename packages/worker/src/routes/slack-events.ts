import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { channelScopeKey } from '@valet/shared';
import type { ChannelTarget, ChannelContext } from '@valet/sdk';
import { verifySlackSignature } from '@valet/plugin-slack/channels';
import type { SlackTransport } from '@valet/plugin-slack/channels';
import { channelRegistry } from '../channels/registry.js';
import * as db from '../lib/db.js';
import { decryptString } from '../lib/crypto.js';
import { dispatchOrchestratorPrompt } from '../lib/workflow-runtime.js';
import { handleChannelCommand } from './channel-webhooks.js';
import { getSlackUserInfo, getSlackBotInfo } from '../services/slack.js';
import { buildThreadContext, buildDmContext } from '../services/slack-threads.js';
import { updateThreadCursor } from '../lib/db/channel-threads.js';

export const slackEventsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /channels/slack/events — Slack Events API handler
 *
 * Routing rules:
 * 1. DMs (channel_type === 'im') → always route
 * 2. @mention (event.type === 'app_mention') → route to mentioning user's orchestrator
 *    with thread context pulled from Slack API
 * 3. Everything else → ignore (200 OK)
 *
 * FUTURE (push model): Non-mention messages in tracked threads could be broadcast
 * to subscribed orchestrators for ambient awareness. See comments at routing decision
 * points for hook locations.
 *
 * Bot replies always thread on the invoking message.
 */
slackEventsRouter.post('/slack/events', async (c) => {
  // Slack retries events when it doesn't receive a 200 within ~3 seconds.
  // Our handler is slow (Slack API calls, DB lookups), so retries are common.
  // Skip retries to prevent duplicate message processing.
  const retryNum = c.req.header('x-slack-retry-num');
  if (retryNum) {
    console.log(`[Slack] Skipping retry #${retryNum} (reason: ${c.req.header('x-slack-retry-reason') || 'unknown'})`);
    return c.json({ ok: true });
  }

  const rawBody = await c.req.text();

  // Parse JSON body (needed for url_verification before signature check)
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  // Handle Slack URL verification challenge (no signature check needed)
  if (payload.type === 'url_verification') {
    return c.json({ challenge: payload.challenge });
  }

  // Extract team_id from payload
  const teamId = payload.team_id as string | undefined;
  if (!teamId) {
    return c.json({ error: 'Missing team_id' }, 400);
  }

  // Look up org-level Slack install (needed for signing secret + bot token)
  const install = await db.getOrgSlackInstall(c.get('db'), teamId);
  if (!install) {
    console.log(`[Slack] No org install found for team_id=${teamId}`);
    return c.json({ ok: true });
  }

  // Verify signature using signing secret from DB (fall back to env var)
  const rawHeaders: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    rawHeaders[key] = value;
  });

  const signingSecret = install.encryptedSigningSecret
    ? await decryptString(install.encryptedSigningSecret, c.env.ENCRYPTION_KEY)
    : c.env.SLACK_SIGNING_SECRET;

  if (signingSecret) {
    const valid = await verifySlackSignature(rawHeaders, rawBody, signingSecret);
    if (!valid) {
      return c.json({ error: 'Invalid signature' }, 401);
    }
  }

  // Decrypt bot token
  const botToken = await decryptString(install.encryptedBotToken, c.env.ENCRYPTION_KEY);

  // Get transport and parse inbound (before identity resolution so we have event metadata)
  const transport = channelRegistry.getTransport('slack');
  if (!transport) {
    return c.json({ error: 'Slack transport not registered' }, 500);
  }

  // Extract event-level fields for routing decisions before full parse
  const event = payload.event as Record<string, unknown> | undefined;
  const eventType = event?.type as string | undefined;

  // Assistant thread events store user_id inside event.assistant_thread, not event.user
  const isAssistantEvent = eventType === 'assistant_thread_started' || eventType === 'assistant_thread_context_changed';
  const assistantThread = event?.assistant_thread as Record<string, unknown> | undefined;
  const slackUserId = (event?.user as string) || (assistantThread?.user_id as string) || null;

  if (!slackUserId && !isAssistantEvent) {
    console.log(`[Slack] No user in event for team_id=${teamId}`);
    return c.json({ ok: true });
  }

  // Resolve Slack display names in parallel: sender + bot (for mention cleanup)
  // Skip user profile resolution for assistant events (no user interaction yet)
  const [slackUserProfile, botInfo] = await Promise.all([
    slackUserId ? getSlackUserInfo(botToken, slackUserId) : Promise.resolve(null),
    getSlackBotInfo(botToken), // discovers bot_id via auth.test, then calls bots.info
  ]);
  const resolvedSenderName = slackUserProfile?.displayName || slackUserProfile?.realName || undefined;

  // Build mention map for resolving <@USER_ID> in message text
  // bots.info returns the bot's U-prefixed userId and its display name
  const mentionMap: Record<string, string> = {};
  if (botInfo?.userId && botInfo.name) {
    mentionMap[botInfo.userId] = botInfo.name;
  } else if (install.botUserId && botInfo?.name) {
    // Fallback: use stored botUserId as key
    mentionMap[install.botUserId] = botInfo.name;
  }
  console.log(`[Slack] Mention map: botInfo=${botInfo ? JSON.stringify(botInfo) : 'null'} map=${JSON.stringify(mentionMap)}`);

  const message = await transport.parseInbound(rawHeaders, rawBody, {
    userId: '', // resolved after parsing for routing decisions
    botToken,
    senderName: resolvedSenderName,
    mentionMap,
  });

  if (!message) {
    return c.json({ ok: true });
  }

  // ─── Assistant thread events (Agents & AI Apps) ────────────────────────
  if (message.metadata?.slackEventType === 'assistant_thread_started') {
    const slackTransport = transport as SlackTransport;
    const threadTs = message.metadata.threadTs as string;
    if (slackTransport.setSuggestedPrompts && threadTs) {
      const target: ChannelTarget = { channelType: 'slack', channelId: message.channelId, threadId: threadTs };
      const ctx: ChannelContext = { token: botToken, userId: '' };
      await slackTransport.setSuggestedPrompts(target, [
        { title: 'Check session status', message: '/status' },
        { title: 'List active sessions', message: '/sessions' },
        { title: 'Start a new task', message: 'Start a new coding session' },
      ], ctx, 'How can I help?');
    }
    return c.json({ ok: true });
  }

  if (message.metadata?.slackEventType === 'assistant_thread_context_changed') {
    return c.json({ ok: true });
  }

  console.log(`[Slack] Parsed message: senderName=${message.senderName} senderId=${message.senderId} channelId=${message.channelId}`);

  // Extract routing metadata
  const slackEventType = message.metadata?.slackEventType as string | undefined;
  const slackChannelType = message.metadata?.slackChannelType as string | undefined;
  const threadTs = message.metadata?.threadTs as string | undefined;
  const messageId = message.messageId;

  // Compute threadId: ensures top-level mentions start a thread on themselves
  const threadId = threadTs || messageId;

  // ─── Routing decision ──────────────────────────────────────────────────
  const isDm = slackChannelType === 'im';
  const isMention = slackEventType === 'app_mention';

  let shouldRoute = false;

  if (isDm) {
    // DMs → always route
    shouldRoute = true;
  } else if (isMention) {
    // @mention in any channel → route to mentioning user's orchestrator
    shouldRoute = true;
  } else {
    // Regular channel message (no mention) → ignore
    // FUTURE: push-model hook — broadcast to subscribed orchestrators for ambient awareness
    console.log(`[Slack] Ignoring non-mention channel message: channel=${message.channelId}`);
    return c.json({ ok: true });
  }

  // ─── Identity resolution ───────────────────────────────────────────────
  // slackUserId is guaranteed non-null here: assistant events return early above,
  // and non-assistant events without a user are filtered out at line 99.
  const userId = await db.resolveUserByExternalId(c.get('db'), 'slack', slackUserId!);
  if (!userId) {
    console.log(`[Slack] No identity link for slack user=${slackUserId}`);
    // For @mentions and DMs, reply with account linking instructions
    if (isMention || isDm) {
      const ctx: ChannelContext = { token: botToken, userId: '' };
      const target: ChannelTarget = {
        channelType: 'slack',
        channelId: message.channelId,
        threadId: isDm ? undefined : threadId,
      };
      await transport.sendMessage(target, {
        markdown: `I don't recognize your Slack account yet. To get started, link your account in Valet:\n\n1. <${(c.env as Env).FRONTEND_URL || 'https://valet.bot'}|Log in to Valet>\n2. Go to **Integrations** in the sidebar\n3. Click **Link Account** on the Slack card\n4. Find your name and enter the verification code I'll DM you`,
      }, ctx);
    }
    return c.json({ ok: true });
  }

  // Build scope key and look up channel binding (DMs only — public channels use multi-orchestrator routing)
  let binding: Awaited<ReturnType<typeof db.getChannelBindingByScopeKey>> = null;
  if (isDm) {
    const parts = transport.scopeKeyParts(message, userId);
    const scopeKey = channelScopeKey(userId, parts.channelType, parts.channelId);
    binding = await db.getChannelBindingByScopeKey(c.get('db'), scopeKey);
  } else {
    console.log(`[Slack] Public channel mention — skipping binding lookup, using multi-orchestrator routing`);
  }

  // ─── Resolve orchestrator thread ──────────────────────────────────────
  // Map the external channel thread to an orchestrator thread (session_threads).
  // This is channel-agnostic: any channel with threading passes its thread ID.
  // Note: if the orchestrator session rotates, old mappings become stale and are
  // cleaned up via CASCADE when the old session is archived. A new mapping is
  // created automatically on the next message in that Slack thread.
  let orchestratorThreadId: string | undefined;
  if (threadId) {
    let targetSessionId: string | undefined;

    if (binding) {
      targetSessionId = binding.sessionId;
    } else {
      const orchSession = await db.getOrchestratorSession(c.env.DB, userId);
      targetSessionId = orchSession?.id;
    }

    if (targetSessionId) {
      try {
        orchestratorThreadId = await db.getOrCreateChannelThread(c.env.DB, {
          channelType: 'slack',
          channelId: message.channelId,
          externalThreadId: threadId,
          sessionId: targetSessionId,
          userId,
        });
        console.log(`[Slack] Resolved thread: external=${threadId} → orchestrator=${orchestratorThreadId} session=${targetSessionId}`);
      } catch (err) {
        // Thread resolution is best-effort — don't block message dispatch
        console.error(`[Slack] Failed to resolve thread mapping:`, err);
      }
    }
  }

  // Handle slash commands
  if (message.command) {
    const ctx: ChannelContext = { token: botToken, userId };
    const target: ChannelTarget = {
      channelType: 'slack',
      channelId: message.channelId,
      threadId,
    };
    await handleChannelCommand(c.env, transport, target, ctx, message, userId);
    return c.json({ ok: true });
  }

  // Encode thread_ts in channelId so the agent can reply in the correct thread.
  // With "Agents & AI Apps" enabled, DMs are also threaded (each message starts a thread).
  const dispatchChannelId = threadId ? `${message.channelId}:${threadId}` : message.channelId;

  if (binding) {
    console.log(`[Slack] Bound session dispatch: session=${binding.sessionId} channelId=${dispatchChannelId}`);
    const doId = c.env.SESSIONS.idFromName(binding.sessionId);
    const sessionDO = c.env.SESSIONS.get(doId);
    try {
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
            channelType: 'slack',
            channelId: dispatchChannelId,
            threadId: orchestratorThreadId,
            authorName: message.senderName,
          }),
        }),
      );
      console.log(`[Slack] Bound session response: status=${resp.status}`);
      if (resp.ok) {
        const slackTransport = transport as SlackTransport;
        if (slackTransport.setThreadStatus && threadId) {
          const statusTarget: ChannelTarget = { channelType: 'slack', channelId: message.channelId, threadId };
          const statusCtx: ChannelContext = { token: botToken, userId };
          c.executionCtx.waitUntil(
            slackTransport.setThreadStatus(statusTarget, 'is thinking...', statusCtx)
          );
        }
        return c.json({ ok: true });
      }
    } catch (err) {
      console.error(`[Slack] Failed to route to session ${binding.sessionId}:`, err);
    }
  } else if (isDm) {
    console.log(`[Slack] No binding for DM, falling through to orchestrator`);
  }

  // ─── Pull conversation context ─────────────────────────────────────────
  // For DMs: fetch recent channel history for DM rehydration
  // For channel threads: fetch thread replies (existing behavior)
  // FUTURE: push-model hook — in a push model, context would already be available
  // from real-time broadcast. This pull path fetches on-demand from Slack API.
  let threadContextPrefix: string | undefined;
  if (isDm) {
    try {
      // DM rehydration: fetch recent channel history
      // Use threadId as the external thread key (for Agents & AI Apps threaded DMs)
      // or fall back to channelId for unthreaded DMs
      const externalThreadKey = threadId || message.channelId;
      const existingMapping = await db.getChannelThreadMapping(
        c.env.DB, 'slack', message.channelId, externalThreadKey, userId
      );

      const context = await buildDmContext(
        botToken,
        message.channelId,
        existingMapping?.lastSeenTs || null,
        messageId || threadId || '',
      );

      if (context) {
        threadContextPrefix = context;
      }

      // Advance cursor to current message
      if (messageId) {
        await updateThreadCursor(c.env.DB, 'slack', message.channelId, externalThreadKey, userId, messageId);
      }
    } catch (err) {
      // DM context is best-effort — don't block message dispatch
      console.error(`[Slack] Failed to fetch DM context:`, err);
    }
  } else if (threadId) {
    try {
      // Look up existing cursor for this user's view of the thread
      const existingMapping = await db.getChannelThreadMapping(
        c.env.DB, 'slack', message.channelId, threadId, userId
      );

      const context = await buildThreadContext(
        botToken,
        message.channelId,
        threadId,
        existingMapping?.lastSeenTs || null,
        messageId || threadId,
      );

      if (context) {
        threadContextPrefix = context;
      }

      // Advance cursor to current message (works for both new and existing mappings
      // since getOrCreateChannelThread already created the row above)
      if (messageId) {
        await updateThreadCursor(c.env.DB, 'slack', message.channelId, threadId, userId, messageId);
      }
    } catch (err) {
      // Thread context is best-effort — don't block message dispatch
      console.error(`[Slack] Failed to fetch thread context:`, err);
    }
  }

  // Dispatch to orchestrator
  const attachments = message.attachments.map((a) => ({
    type: 'file' as const,
    mime: a.mimeType,
    url: a.url,
    filename: a.fileName,
  }));

  console.log(`[Slack] Orchestrator dispatch: userId=${userId} channelId=${dispatchChannelId}`);
  const result = await dispatchOrchestratorPrompt(c.env, {
    userId,
    content: message.text || '[Attachment]',
    contextPrefix: threadContextPrefix,
    channelType: 'slack',
    channelId: dispatchChannelId,
    threadId: orchestratorThreadId,
    authorName: message.senderName,
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  if (result.dispatched) {
    const slackTransport = transport as SlackTransport;
    if (slackTransport.setThreadStatus && threadId) {
      const statusTarget: ChannelTarget = { channelType: 'slack', channelId: message.channelId, threadId };
      const statusCtx: ChannelContext = { token: botToken, userId };
      c.executionCtx.waitUntil(
        slackTransport.setThreadStatus(statusTarget, 'is thinking...', statusCtx)
      );
    }
  }

  if (!result.dispatched) {
    const ctx: ChannelContext = { token: botToken, userId };
    const target: ChannelTarget = {
      channelType: 'slack',
      channelId: message.channelId,
      threadId,
    };
    await transport.sendMessage(target, {
      markdown: 'Your orchestrator is not running. Start it from the Valet dashboard.',
    }, ctx);
  }

  return c.json({ ok: true });
});
