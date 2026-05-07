import type { MiddlewareHandler } from 'hono';
import { UnauthorizedError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import { extractBearerToken } from '../lib/ws-auth.js';

/**
 * Authentication middleware supporting:
 * 1. Server-issued session tokens (from OAuth login)
 * 2. API key tokens (for programmatic access)
 */
export const authMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  c,
  next
) => {
  // Runner WebSocket connections authenticate via token validated by the DO itself
  const url = new URL(c.req.url);
  if (url.searchParams.get('role') === 'runner' && url.pathname.endsWith('/ws')) {
    return next();
  }

  // Extract bearer token from Authorization header, WebSocket subprotocol, or legacy ?token= query param
  const bearerToken = extractBearerToken(c.req.raw);

  if (bearerToken) {
    const tokenHash = await hashToken(bearerToken);

    // Try auth_sessions first (OAuth session tokens)
    const sessionUser = await validateAuthSession(tokenHash, c.env);
    if (sessionUser) {
      c.set('user', sessionUser);
      return next();
    }

    // Fall back to api_tokens (programmatic API keys)
    const apiKeyUser = await validateAPIKey(tokenHash, c.env);
    if (apiKeyUser) {
      c.set('user', apiKeyUser);
      return next();
    }
  }

  throw new UnauthorizedError('Missing or invalid authentication');
};

async function validateAuthSession(
  tokenHash: string,
  env: Env
): Promise<{ id: string; email: string; role: 'admin' | 'member' } | null> {
  try {
    const result = await env.DB.prepare(
      `SELECT u.id, u.email, u.role
       FROM auth_sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token_hash = ?
         AND s.expires_at > datetime('now')`
    )
      .bind(tokenHash)
      .first<{ id: string; email: string; role: string }>();

    if (result) {
      // Update last_used_at (fire-and-forget)
      env.DB.prepare("UPDATE auth_sessions SET last_used_at = datetime('now') WHERE token_hash = ?")
        .bind(tokenHash)
        .run()
        .catch(() => {});
    }

    return result ? { id: result.id, email: result.email, role: (result.role || 'member') as 'admin' | 'member' } : null;
  } catch {
    return null;
  }
}

async function validateAPIKey(
  tokenHash: string,
  env: Env
): Promise<{ id: string; email: string; role: 'admin' | 'member' } | null> {
  try {
    const result = await env.DB.prepare(
      `SELECT u.id, u.email, u.role
       FROM api_tokens t
       JOIN users u ON t.user_id = u.id
       WHERE t.token_hash = ?
         AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
         AND t.revoked_at IS NULL`
    )
      .bind(tokenHash)
      .first<{ id: string; email: string; role: string }>();

    if (result) {
      env.DB.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE token_hash = ?")
        .bind(tokenHash)
        .run()
        .catch(() => {});
    }

    return result ? { id: result.id, email: result.email, role: (result.role || 'member') as 'admin' | 'member' } : null;
  } catch {
    return null;
  }
}

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
