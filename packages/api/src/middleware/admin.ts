import type { MiddlewareHandler } from 'hono';
import { ForbiddenError } from '@valet/shared';
import type { Env, Variables } from '../env.js';

export const adminMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  c,
  next
) => {
  const user = c.get('user');
  if (user.role !== 'admin') {
    throw new ForbiddenError('Admin access required');
  }
  return next();
};
