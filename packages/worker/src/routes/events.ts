import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';

export const eventsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/events/ws — Upgrade to WebSocket connection to the EventBus DO.
 * Proxies the upgrade to the singleton EventBusDO instance.
 */
eventsRouter.get('/ws', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, { status: 426 });
  }

  const user = c.get('user');
  const id = c.env.EVENT_BUS.idFromName('global');
  const stub = c.env.EVENT_BUS.get(id);

  // Forward the upgrade request with userId param
  const url = new URL(c.req.url);
  const doUrl = new URL('/ws', url.origin);
  doUrl.searchParams.set('userId', user.id);

  return stub.fetch(
    new Request(doUrl.toString(), {
      headers: c.req.raw.headers,
    })
  );
});
