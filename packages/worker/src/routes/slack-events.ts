import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { channelScopeKey } from '@valet/shared';
import type { ChannelTarget, ChannelContext } from '@valet/sdk';
import { verifySlackSignature } from '@valet/channel-slack';
import { channelRegistry } from '../channels/registry.js';
import * as db from '../lib/db.js';
import { decryptString } from '../lib/crypto.js';
import { dispatchOrchestratorPrompt } from '../lib/workflow-runtime.js';
import { handleChannelCommand } from './channel-webhooks.js';
import { getSlackUserInfo, getSlackBotInfo } from '../services/slack.js';

export const slackEventsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /channels/slack/events — Slack Events API handler
 *
 * Routing rules:
 * 1. DMs (channel_type === 'im') → always route
 * 2. @mention (event.type === 'app_mention') → route + track thread
 * 3. Reply in a tracked thread → route
 * 4. Everything else → ignore (200 OK)
 *
 * Bot replies always thread on the invoking message.
 */
slackEventsRouter.post('/slack/events', async (c) => {
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
  const slackUserId = (event?.user as string) || null;

  if (!slackUserId) {
    console.log(`[Slack] No user in event for team_id=${teamId}`);
    return c.json({ ok: true });
  }

  // Resolve Slack display names in parallel: sender + bot (for mention cleanup)
  const [slackUserProfile, botInfo] = await Promise.all([
    getSlackUserInfo(botToken, slackUserId),
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
  const isThreadReply = !!threadTs;

  let shouldRoute = false;

  if (isDm) {
    // DMs → always route
    shouldRoute = true;
  } else if (isMention) {
    // @mention → route + track thread for follow-ups
    shouldRoute = true;
  } else if (isThreadReply) {
    // Thread reply → only route if we've seen a mention in this thread
    shouldRoute = await db.isSlackBotThread(c.get('db'), teamId, message.channelId, threadTs);
    if (!shouldRoute) {
      console.log(`[Slack] Ignoring thread reply in untracked thread: channel=${message.channelId} thread=${threadTs}`);
      return c.json({ ok: true });
    }
  } else {
    // Regular channel message, no mention, not in a thread → ignore
    console.log(`[Slack] Ignoring non-mention channel message: channel=${message.channelId}`);
    return c.json({ ok: true });
  }

  // ─── Identity resolution ───────────────────────────────────────────────
  const userId = await db.resolveUserByExternalId(c.get('db'), 'slack', slackUserId);
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
        markdown: "I don't recognize your Slack account yet. To get started, link your account in Valet:\n\n1. Log in to Valet\n2. Go to **Integrations** in the sidebar\n3. Click **Link Account** on the Slack card\n4. Find your name and enter the verification code I'll DM you",
      }, ctx);
    }
    return c.json({ ok: true });
  }

  // ─── Track @mention threads ────────────────────────────────────────────
  if (isMention && threadId) {
    await db.trackSlackBotThread(c.get('db'), {
      id: crypto.randomUUID(),
      teamId,
      channelId: message.channelId,
      threadTs: threadId,
      userId,
    });
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

  // Encode thread_ts in channelId for non-DM channels so the agent can reply
  // in the correct thread. DMs don't need this — they're a single conversation.
  const dispatchChannelId = (!isDm && threadId) ? `${message.channelId}:${threadId}` : message.channelId;

  // Build scope key and look up channel binding
  const parts = transport.scopeKeyParts(message, userId);
  const scopeKey = channelScopeKey(userId, parts.channelType, parts.channelId);
  const binding = await db.getChannelBindingByScopeKey(c.get('db'), scopeKey);

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
            authorName: message.senderName,
          }),
        }),
      );
      console.log(`[Slack] Bound session response: status=${resp.status}`);
      if (resp.ok) return c.json({ ok: true });
    } catch (err) {
      console.error(`[Slack] Failed to route to session ${binding.sessionId}:`, err);
    }
  } else {
    console.log(`[Slack] No binding for scopeKey=${scopeKey}, falling through to orchestrator`);
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
    channelType: 'slack',
    channelId: dispatchChannelId,
    authorName: message.senderName,
    attachments: attachments.length > 0 ? attachments : undefined,
  });

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
