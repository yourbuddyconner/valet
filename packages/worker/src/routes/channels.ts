import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { webManualScopeKey } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';
import { dispatchOrchestratorPrompt } from '../lib/workflow-runtime.js';

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
