import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { webManualScopeKey } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';
import { dispatchOrchestratorPrompt } from '../lib/workflow-runtime.js';
import { channelRegistry } from '../channels/registry.js';
import { getSlackBotToken } from '../services/slack.js';
import { getCredential } from '../services/credentials.js';

export const channelsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

const promptSchema = z.object({
  content: z.string().min(1).max(100000),
  channelType: z.enum(['web', 'slack', 'github', 'api', 'telegram']).optional(),
  channelId: z.string().max(500).optional(),
  scopeKey: z.string().max(1000).optional(),
  queueMode: z.enum(['followup', 'collect', 'steer']).optional(),
  attachments: z
    .array(
      z.object({
        type: z.enum(['file', 'url']),
        name: z.string(),
        data: z.string(),
        mimeType: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * POST /api/prompt
 * Channel-agnostic prompt endpoint.
 * Routes to a bound session via scope key, or falls back to orchestrator.
 */
channelsRouter.post('/prompt', zValidator('json', promptSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  // Compute scope key
  let scopeKey = body.scopeKey;
  if (!scopeKey && body.channelType && body.channelId) {
    // For web channels, derive from user + channel ID
    if (body.channelType === 'web') {
      scopeKey = webManualScopeKey(user.id, body.channelId);
    } else {
      // Generic fallback: channelType:channelId
      scopeKey = `${body.channelType}:${body.channelId}`;
    }
  }

  // Lookup channel binding by scope key
  if (scopeKey) {
    const binding = await db.getChannelBindingByScopeKey(c.get('db'), scopeKey);
    if (binding) {
      // Route directly to bound session's DO
      const doId = c.env.SESSIONS.idFromName(binding.sessionId);
      const sessionDO = c.env.SESSIONS.get(doId);

      try {
        const resp = await sessionDO.fetch(
          new Request('http://do/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: body.content,
              queueMode: body.queueMode || binding.queueMode,
              attachments: body.attachments,
              channelType: body.channelType,
              channelId: body.channelId,
            }),
          }),
        );

        if (!resp.ok) {
          const errBody = await resp.text();
          return c.json({ error: 'Failed to route prompt to session', details: errBody }, 502);
        }

        return c.json({
          routed: true,
          sessionId: binding.sessionId,
          scopeKey,
          queueMode: body.queueMode || binding.queueMode,
        });
      } catch (err) {
        return c.json({
          error: 'Failed to route prompt to session',
          details: err instanceof Error ? err.message : String(err),
        }, 502);
      }
    }
  }

  // No binding found — dispatch to orchestrator
  const result = await dispatchOrchestratorPrompt(c.env, {
    userId: user.id,
    content: body.content,
  });

  return c.json({
    routed: result.dispatched,
    sessionId: result.sessionId,
    scopeKey: scopeKey || null,
    orchestratorFallback: true,
    reason: result.dispatched ? undefined : result.reason,
  });
});

/**
 * GET /api/channels/label?channelType=...&channelId=...
 * Resolve a composite channelId to a human-readable label via the channel transport.
 */
channelsRouter.get('/channels/label', async (c) => {
  const channelType = c.req.query('channelType');
  const channelId = c.req.query('channelId');
  if (!channelType || !channelId) {
    return c.json({ error: 'channelType and channelId are required' }, 400);
  }

  const transport = channelRegistry.getTransport(channelType);
  if (!transport?.resolveLabel) {
    console.log(`[ChannelLabel] No resolver for channelType=${channelType}`);
    return c.json({ label: null });
  }

  // Resolve token: Slack uses org-level bot token, others use per-user credentials
  const user = c.get('user');
  let token: string | undefined;
  if (channelType === 'slack') {
    token = await getSlackBotToken(c.env) ?? undefined;
  } else {
    const credResult = await getCredential(c.env, 'user', user.id, channelType);
    if (credResult.ok) token = credResult.credential.accessToken;
  }

  if (!token) {
    console.log(`[ChannelLabel] No token for channelType=${channelType}`);
    return c.json({ label: null });
  }

  try {
    const label = await transport.resolveLabel(channelId, { token, userId: user.id });
    return c.json({ label });
  } catch (err) {
    console.error(`[ChannelLabel] Failed to resolve: channelType=${channelType} channelId=${channelId}`, err);
    return c.json({ label: null });
  }
});
