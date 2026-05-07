import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  loadGitHubAppMock,
  signJWTMock,
  verifyJWTMock,
  storeCredentialMock,
  finalizeIdentityLoginMock,
  reconcileUserInstallationsMock,
  findUserByEmailMock,
  deleteIdentityLinkByExternalIdMock,
  getUserIdentityLinksMock,
  createIdentityLinkMock,
  deleteIdentityLinkMock,
  ensureIntegrationMock,
  updateUserGitHubMock,
} = vi.hoisted(() => ({
  loadGitHubAppMock: vi.fn(),
  signJWTMock: vi.fn(),
  verifyJWTMock: vi.fn(),
  storeCredentialMock: vi.fn(),
  finalizeIdentityLoginMock: vi.fn(),
  reconcileUserInstallationsMock: vi.fn(),
  findUserByEmailMock: vi.fn(),
  deleteIdentityLinkByExternalIdMock: vi.fn(),
  getUserIdentityLinksMock: vi.fn(),
  createIdentityLinkMock: vi.fn(),
  deleteIdentityLinkMock: vi.fn(),
  ensureIntegrationMock: vi.fn(),
  updateUserGitHubMock: vi.fn(),
}));

vi.mock('../services/github-app.js', () => ({
  loadGitHubApp: loadGitHubAppMock,
}));

vi.mock('../lib/jwt.js', () => ({
  signJWT: signJWTMock,
  verifyJWT: verifyJWTMock,
}));

vi.mock('../services/credentials.js', () => ({
  storeCredential: storeCredentialMock,
}));

vi.mock('../services/oauth.js', () => ({
  finalizeIdentityLogin: finalizeIdentityLoginMock,
}));

vi.mock('../services/github-installations.js', () => ({
  reconcileUserInstallations: reconcileUserInstallationsMock,
}));

vi.mock('../lib/db.js', () => ({
  findUserByEmail: findUserByEmailMock,
  deleteIdentityLinkByExternalId: deleteIdentityLinkByExternalIdMock,
  getUserIdentityLinks: getUserIdentityLinksMock,
  createIdentityLink: createIdentityLinkMock,
  deleteIdentityLink: deleteIdentityLinkMock,
  ensureIntegration: ensureIntegrationMock,
  updateUserGitHub: updateUserGitHubMock,
}));

vi.mock('../lib/drizzle.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

// Must import after mocks
import { githubAuthRouter } from './github-auth.js';

const FRONTEND_URL = 'http://localhost:5173';

function buildApp() {
  const app = new Hono();
  app.route('/auth/github', githubAuthRouter);
  return app;
}

function buildEnv(overrides: Record<string, unknown> = {}) {
  return {
    FRONTEND_URL,
    ENCRYPTION_KEY: 'test-key',
    DB: {},
    ...overrides,
  };
}

describe('githubAuthRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET / (login initiation)', () => {
    it('redirects to GitHub authorize URL when App is configured', async () => {
      const mockUrl = 'https://github.com/login/oauth/authorize?client_id=test&state=jwt';
      loadGitHubAppMock.mockResolvedValue({
        oauth: {
          getWebFlowAuthorizationUrl: vi.fn().mockReturnValue({ url: mockUrl }),
        },
      });
      signJWTMock.mockResolvedValue('signed-state-jwt');

      const app = buildApp();
      const res = await app.request(
        'http://localhost/auth/github',
        { method: 'GET' },
        buildEnv(),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(mockUrl);
    });

    it('redirects to login error when App is not configured', async () => {
      loadGitHubAppMock.mockResolvedValue(null);

      const app = buildApp();
      const res = await app.request(
        'http://localhost/auth/github',
        { method: 'GET' },
        buildEnv(),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        `${FRONTEND_URL}/login?error=github_not_configured`,
      );
    });
  });

  describe('GET /callback', () => {
    it('rejects missing code/state params', async () => {
      const app = buildApp();
      const res = await app.request(
        'http://localhost/auth/github/callback',
        { method: 'GET' },
        buildEnv(),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        `${FRONTEND_URL}/login?error=missing_params`,
      );
    });

    it('rejects invalid state JWT', async () => {
      verifyJWTMock.mockResolvedValue(null);

      const app = buildApp();
      const res = await app.request(
        'http://localhost/auth/github/callback?code=test-code&state=bad-jwt',
        { method: 'GET' },
        buildEnv(),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        `${FRONTEND_URL}/login?error=invalid_state`,
      );
    });
  });
});
