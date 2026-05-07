import type { MiddlewareHandler } from 'hono';
import type { Env, Variables } from '../env.js';
import { getDb } from '../lib/drizzle.js';

/**
 * Creates a Drizzle instance per-request from the D1 binding
 * and stores it on the Hono context as `c.get('db')`.
 *
 * This lets routes pass `c.get('db')` (an AppDb) to db/ functions
 * instead of `c.env.DB` (a raw D1Database), decoupling the
 * business logic from the Cloudflare-specific binding.
 */
export const dbMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  c,
  next,
) => {
  c.set('db', getDb(c.env.DB));
  await next();
};
