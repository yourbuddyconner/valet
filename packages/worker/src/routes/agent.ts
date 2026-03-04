import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ForbiddenError, NotFoundError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';

export const agentRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Helper to proxy a request to the SessionAgentDO's /proxy/ endpoint.
 */
async function proxyToAgent(
  env: Env,
  sessionId: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const doId = env.SESSIONS.idFromName(sessionId);
  const sessionDO = env.SESSIONS.get(doId);
  return sessionDO.fetch(
    new Request(`http://do/proxy/${path}`, init),
  );
}

/**
 * GET /agent/:sessionId/health
 */
agentRouter.get('/:sessionId/health', async (c) => {
  const user = c.get('user');
  const { sessionId } = c.req.param();

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  const response = await proxyToAgent(c.env, sessionId, 'health');

  if (!response.ok) {
    return c.json({ status: 'unhealthy', error: 'Container not responding' }, 503);
  }

  const data = await response.json() as Record<string, unknown>;
  return c.json({ status: 'healthy', ...data });
});

/**
 * GET /agent/:sessionId/project
 */
agentRouter.get('/:sessionId/project', async (c) => {
  const user = c.get('user');
  const { sessionId } = c.req.param();

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  const response = await proxyToAgent(c.env, sessionId, 'project');

  if (!response.ok) {
    return c.json({ error: 'Failed to get project info' }, response.status as ContentfulStatusCode);
  }

  return c.json(await response.json());
});

/**
 * GET /agent/:sessionId/providers
 */
agentRouter.get('/:sessionId/providers', async (c) => {
  const user = c.get('user');
  const { sessionId } = c.req.param();

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  const response = await proxyToAgent(c.env, sessionId, 'provider');

  if (!response.ok) {
    return c.json({ providers: [] });
  }

  return c.json(await response.json());
});

/**
 * GET /agent/:sessionId/models
 */
agentRouter.get('/:sessionId/models', async (c) => {
  const user = c.get('user');
  const { sessionId } = c.req.param();

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  const response = await proxyToAgent(c.env, sessionId, 'model');

  if (!response.ok) {
    return c.json({ models: [] });
  }

  return c.json(await response.json());
});

/**
 * GET /agent/:sessionId/commands
 */
agentRouter.get('/:sessionId/commands', async (c) => {
  const user = c.get('user');
  const { sessionId } = c.req.param();

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  const response = await proxyToAgent(c.env, sessionId, 'command');

  if (!response.ok) {
    return c.json({ commands: [] });
  }

  return c.json(await response.json());
});

/**
 * POST /agent/:sessionId/commands/:name
 */
agentRouter.post('/:sessionId/commands/:name', async (c) => {
  const user = c.get('user');
  const { sessionId, name } = c.req.param();
  const body = await c.req.json().catch(() => ({}));

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  const response = await proxyToAgent(c.env, sessionId, `command/${name}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return c.json({ error: `Command failed: ${name}` }, response.status as ContentfulStatusCode);
  }

  return c.json(await response.json());
});

/**
 * POST /agent/:sessionId/share
 */
agentRouter.post('/:sessionId/share', async (c) => {
  const user = c.get('user');
  const { sessionId } = c.req.param();

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }
  if (session.isOrchestrator || session.purpose === 'workflow') {
    throw new ForbiddenError('This session type cannot be shared');
  }

  const response = await proxyToAgent(c.env, sessionId, 'session/share', {
    method: 'POST',
  });

  if (!response.ok) {
    return c.json({ error: 'Failed to share session' }, response.status as ContentfulStatusCode);
  }

  return c.json(await response.json());
});

/**
 * POST /agent/:sessionId/summarize
 */
agentRouter.post('/:sessionId/summarize', async (c) => {
  const user = c.get('user');
  const { sessionId } = c.req.param();

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  const response = await proxyToAgent(c.env, sessionId, 'session/summarize', {
    method: 'POST',
  });

  if (!response.ok) {
    return c.json({ error: 'Failed to summarize session' }, response.status as ContentfulStatusCode);
  }

  return c.json(await response.json());
});

/**
 * Catch-all proxy for other OpenCode endpoints
 */
agentRouter.all('/:sessionId/proxy/*', async (c) => {
  const user = c.get('user');
  const { sessionId } = c.req.param();
  const path = c.req.path.replace(`/agent/${sessionId}/proxy/`, '');

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  const url = new URL(c.req.url);
  const proxyPath = path + url.search;

  const response = await proxyToAgent(c.env, sessionId, proxyPath, {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
});
