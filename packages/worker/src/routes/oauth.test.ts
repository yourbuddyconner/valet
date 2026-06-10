import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { signJWTMock, verifyJWTMock, getOrgSettingsMock } = vi.hoisted(() => ({
  signJWTMock: vi.fn(),
  verifyJWTMock: vi.fn(),
  getOrgSettingsMock: vi.fn(),
}));

vi.mock('../lib/jwt.js', () => ({
  signJWT: signJWTMock,
  verifyJWT: verifyJWTMock,
}));

vi.mock('../lib/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/db.js')>()),
  getOrgSettings: getOrgSettingsMock,
}));

vi.mock('../lib/drizzle.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

import { oauthRouter } from './oauth.js';
import type { Env } from '../env.js';

function buildApp() {
  const app = new Hono();
  app.route('/auth', oauthRouter);
  return app;
}

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    FRONTEND_URL: 'https://dev-valet-client.pages.dev',
    FRONTEND_PREVIEW_ORIGIN_SUFFIX: 'dev-valet-client.pages.dev',
    ENCRYPTION_KEY: 'test-key',
    DB: {} as Env['DB'],
    STORAGE: {} as Env['STORAGE'],
    SESSIONS: {} as Env['SESSIONS'],
    EVENT_BUS: {} as Env['EVENT_BUS'],
    WORKFLOW_EXECUTOR: {} as Env['WORKFLOW_EXECUTOR'],
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    MODAL_BACKEND_URL: 'https://modal.example.com/{label}',
    ...overrides,
  };
}

describe('oauthRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signJWTMock.mockResolvedValue('signed-state');
    verifyJWTMock.mockResolvedValue(null);
    getOrgSettingsMock.mockResolvedValue({});
  });

  describe('GET /:provider', () => {
    it('stores valid preview return origins in OAuth state', async () => {
      const app = buildApp();
      const res = await app.request(
        'http://localhost/auth/google?return_to_origin=https%3A%2F%2Fpr-123.dev-valet-client.pages.dev',
        { method: 'GET' },
        buildEnv(),
      );

      expect(res.status).toBe(302);
      expect(signJWTMock).toHaveBeenCalledWith(
        expect.objectContaining({
          return_to_origin: 'https://pr-123.dev-valet-client.pages.dev',
        }),
        'test-key',
      );
    });

    it('omits invalid preview return origins from OAuth state', async () => {
      const app = buildApp();
      const res = await app.request(
        'http://localhost/auth/google?return_to_origin=https%3A%2F%2Fevil.example.com',
        { method: 'GET' },
        buildEnv(),
      );

      expect(res.status).toBe(302);
      expect(signJWTMock).toHaveBeenCalledWith(
        expect.not.objectContaining({
          return_to_origin: expect.any(String),
        }),
        'test-key',
      );
    });
  });
});
