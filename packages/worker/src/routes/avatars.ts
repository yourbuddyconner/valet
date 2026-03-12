import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';

export const avatarsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /avatars/:userId/:key
 * Public route — serves avatar images from R2. No auth required so Slack/external
 * services can render them.
 */
avatarsRouter.get('/:userId/:key', async (c) => {
  const { userId, key } = c.req.param();
  const r2Key = `avatars/${userId}/${key}`;

  const object = await c.env.STORAGE.get(r2Key);
  if (!object) {
    return c.notFound();
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Access-Control-Allow-Origin', '*');
  // Override secureHeaders' default same-origin policy so cross-origin <img> loads work
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

  return new Response(object.body, { headers });
});
