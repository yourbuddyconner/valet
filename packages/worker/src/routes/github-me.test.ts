import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  verifyJWTMock,
  getGitHubConfigMock,
  storeCredentialMock,
  deleteIdentityLinkByExternalIdMock,
  getUserIdentityLinksMock,
  createIdentityLinkMock,
  updateUserGitHubMock,
  ensureIntegrationMock,
  getDbMock,
} = vi.hoisted(() => ({
  verifyJWTMock: vi.fn(),
  getGitHubConfigMock: vi.fn(),
  storeCredentialMock: vi.fn(),
  deleteIdentityLinkByExternalIdMock: vi.fn(),
  getUserIdentityLinksMock: vi.fn(),
  createIdentityLinkMock: vi.fn(),
  updateUserGitHubMock: vi.fn(),
  ensureIntegrationMock: vi.fn(),
  getDbMock: vi.fn(),
}));

vi.mock('../lib/jwt.js', () => ({
  signJWT: vi.fn(),
  verifyJWT: verifyJWTMock,
}));

vi.mock('./oauth.js', () => ({
  handleLoginOAuthCallback: vi.fn(),
}));

vi.mock('../services/github-config.js', () => ({
  getGitHubConfig: getGitHubConfigMock,
  getGitHubMetadata: vi.fn(),
}));

vi.mock('../services/credentials.js', () => ({
  storeCredential: storeCredentialMock,
}));

vi.mock('../lib/drizzle.js', () => ({
  getDb: getDbMock,
}));

vi.mock('../lib/db.js', () => ({
  deleteIdentityLinkByExternalId: deleteIdentityLinkByExternalIdMock,
  getUserIdentityLinks: getUserIdentityLinksMock,
  createIdentityLink: createIdentityLinkMock,
  updateUserGitHub: updateUserGitHubMock,
  ensureIntegration: ensureIntegrationMock,
}));

import { githubMeCallbackRouter } from './github-me.js';

function buildApp() {
  const app = new Hono();
  app.route('/auth/github', githubMeCallbackRouter);
  return app;
}

describe('githubMeCallbackRouter', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getDbMock.mockReturnValue({});
    verifyJWTMock.mockResolvedValue({
      sub: 'user-1',
      sid: 'repo read:user user:email',
      purpose: 'github-link',
    });
    getGitHubConfigMock.mockResolvedValue({
      oauthClientId: 'client-id',
      oauthClientSecret: 'client-secret',
    });
    getUserIdentityLinksMock.mockResolvedValue([]);

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({
          access_token: 'gho_test',
          scope: 'repo read:user user:email',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 123,
          login: 'yourbuddyconner',
          email: 'conner@example.com',
          name: 'Conner',
          avatar_url: 'https://avatars.example/conner.png',
        }),
      } as Response));
  });

  it('activates the github integration after a successful personal link callback', async () => {
    const app = buildApp();
    const res = await app.fetch(new Request('http://localhost/auth/github/callback?code=abc&state=signed-state'), {
      DB: {},
      ENCRYPTION_KEY: 'test-key',
      FRONTEND_URL: 'http://localhost:5173',
    } as any);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:5173/integrations?github=linked');
    expect(storeCredentialMock).toHaveBeenCalledWith(
      expect.anything(),
      'user',
      'user-1',
      'github',
      { access_token: 'gho_test' },
      expect.objectContaining({
        credentialType: 'oauth2',
        scopes: 'repo read:user user:email',
      }),
    );
    expect(ensureIntegrationMock).toHaveBeenCalledWith({}, 'user-1', 'github');
  });
});
