import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { NotFoundError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';

export const apiKeysRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

interface APIKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

interface APIKeyWithToken extends APIKey {
  token: string;
}

/**
 * Generate a cryptographically secure API token
 */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sk_${token}`;
}

/**
 * Hash a token using SHA-256
 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * GET /api/api-keys
 * List user's API keys (metadata only, no secrets)
 */
apiKeysRouter.get('/', async (c) => {
  const user = c.get('user');
  const keys = await db.listApiTokens(c.get('db'), user.id);
  return c.json({ keys });
});

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  expiresInDays: z.number().optional(),
});

/**
 * POST /api/api-keys
 * Create a new API key
 * Returns the plain text token ONLY on creation
 */
apiKeysRouter.post('/', zValidator('json', createKeySchema), async (c) => {
  const user = c.get('user');
  const { name, expiresInDays } = c.req.valid('json');

  const id = crypto.randomUUID();
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const prefix = token.slice(0, 7) + '...' + token.slice(-4);

  let expiresAt: string | null = null;
  if (expiresInDays) {
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + expiresInDays);
    expiresAt = expDate.toISOString();
  }

  await db.insertApiToken(c.get('db'), { id, userId: user.id, name, tokenHash, prefix, expiresAt });

  const key: APIKeyWithToken = {
    id,
    name,
    prefix,
    token, // Plain token returned only once
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    expiresAt,
  };

  return c.json(key, 201);
});

/**
 * DELETE /api/api-keys/:id
 * Revoke an API key
 */
apiKeysRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const revoked = await db.revokeApiToken(c.get('db'), id, user.id);
  if (!revoked) {
    throw new NotFoundError('API key not found');
  }

  return c.json({ success: true });
});
