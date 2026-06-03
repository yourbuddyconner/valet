import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { extractBearerToken } from '../lib/ws-auth';
import { errorHandler } from './error-handler.js';
import { authMiddleware } from './auth.js';

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-test');
    await next();
  });
  app.use('/api/*', authMiddleware);
  app.get('/api/sessions/:id/runner-attachment', (c) => c.text('ok'));
  return app;
}

describe('extractBearerToken', () => {
  it('reads Authorization bearer token', () => {
    const req = new Request('https://example.com/api/sessions/1/ws?role=client', {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(extractBearerToken(req)).toBe('secret-token');
  });

  it('reads websocket token from Sec-WebSocket-Protocol', () => {
    const req = new Request('https://example.com/api/sessions/1/ws?role=client', {
      headers: { 'Sec-WebSocket-Protocol': 'valet, bearer.ws-token-123' },
    });
    expect(extractBearerToken(req)).toBe('ws-token-123');
  });

  it('ignores token in query params', () => {
    const req = new Request('https://example.com/api/sessions/1/ws?role=client&token=legacy-token');
    expect(extractBearerToken(req)).toBeNull();
  });
});

describe('authMiddleware', () => {
  it('lets runner attachment fetches reach the DO for token validation', async () => {
    const app = buildApp();

    const res = await app.fetch(
      new Request('http://localhost/api/sessions/session-1/runner-attachment?messageId=msg-1&index=0&token=runner-token'),
      { DB: { prepare: () => ({ bind: () => ({ first: () => null }) }) } } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('still requires user authentication for ordinary session APIs', async () => {
    const app = buildApp();

    const res = await app.fetch(
      new Request('http://localhost/api/sessions/session-1/messages'),
      { DB: { prepare: () => ({ bind: () => ({ first: () => null }) }) } } as any,
    );

    expect(res.status).toBe(401);
  });
});
