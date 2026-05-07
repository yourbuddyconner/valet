import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-utils/db.js';
import { githubInstallations } from '../lib/schema/github-installations.js';
import { encryptStringPBKDF2, decryptStringPBKDF2 } from '../lib/crypto.js';
import { upsertGithubInstallation } from '../lib/db/github-installations.js';

const mockRequest = vi.fn();

vi.mock('octokit', () => {
  return {
    App: vi.fn().mockImplementation(function (this: any, opts: any) {
      this.appId = opts.appId;
      this.octokit = { request: mockRequest };
    }),
  };
});

const ENCRYPTION_KEY = 'test-encryption-key-for-github-app';

describe('github-app service', () => {
  // ── createGitHubApp ────────────────────────────────────────────

  describe('createGitHubApp', () => {
    it('creates an App instance with the correct options', async () => {
      const { App } = await import('octokit');
      const { createGitHubApp } = await import('./github-app.js');

      const app = createGitHubApp({
        appId: '12345',
        privateKey: 'PEM_KEY',
        oauthClientId: 'Iv1.abc',
        oauthClientSecret: 'secret123',
        webhookSecret: 'whsec_test',
      });

      expect(App).toHaveBeenCalledWith({
        appId: '12345',
        privateKey: 'PEM_KEY',
        oauth: {
          clientId: 'Iv1.abc',
          clientSecret: 'secret123',
        },
        webhooks: {
          secret: 'whsec_test',
        },
      });

      expect((app as any).appId).toBe('12345');
    });
  });

  // ── mintInstallationToken ──────────────────────────────────────

  describe('mintInstallationToken', () => {
    it('calls the GitHub API and returns token + expiry', async () => {
      const { createGitHubApp, mintInstallationToken } = await import('./github-app.js');

      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      mockRequest.mockResolvedValueOnce({
        data: {
          token: 'ghs_fresh_token',
          expires_at: expiresAt,
        },
      });

      const app = createGitHubApp({
        appId: '99',
        privateKey: 'PEM',
        oauthClientId: 'cid',
        oauthClientSecret: 'csec',
        webhookSecret: 'wsec',
      });

      const result = await mintInstallationToken(app, '42');

      expect(mockRequest).toHaveBeenCalledWith(
        'POST /app/installations/{installation_id}/access_tokens',
        { installation_id: 42 },
      );
      expect(result.token).toBe('ghs_fresh_token');
      expect(result.expiresAt).toBe(new Date(expiresAt).getTime());
    });

    it('throws for non-numeric installation ID', async () => {
      const { createGitHubApp, mintInstallationToken } = await import('./github-app.js');

      const app = createGitHubApp({
        appId: '99',
        privateKey: 'PEM',
        oauthClientId: 'cid',
        oauthClientSecret: 'csec',
        webhookSecret: 'wsec',
      });

      await expect(mintInstallationToken(app, 'not-a-number')).rejects.toThrow(
        'Invalid installation ID',
      );
    });
  });

  // ── getOrMintInstallationToken ─────────────────────────────────

  describe('getOrMintInstallationToken', () => {
    let db: ReturnType<typeof createTestDb>['db'];

    beforeEach(() => {
      const testDb = createTestDb();
      db = testDb.db;
      mockRequest.mockReset();
    });

    async function seedInstallation(githubInstallationId = '42') {
      return upsertGithubInstallation(db as any, {
        githubInstallationId,
        accountLogin: 'my-org',
        accountId: 'acct-1',
        accountType: 'Organization',
        repositorySelection: 'all',
      });
    }

    it('mints fresh token on cache miss and writes back to D1', async () => {
      const { createGitHubApp, getOrMintInstallationToken } = await import('./github-app.js');

      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      mockRequest.mockResolvedValueOnce({
        data: {
          token: 'ghs_fresh',
          expires_at: expiresAt,
        },
      });

      const app = createGitHubApp({
        appId: '99',
        privateKey: 'PEM',
        oauthClientId: 'cid',
        oauthClientSecret: 'csec',
        webhookSecret: 'wsec',
      });

      const installation = await seedInstallation();

      const result = await getOrMintInstallationToken(app, db as any, ENCRYPTION_KEY, {
        id: installation.id,
        githubInstallationId: installation.githubInstallationId,
        cachedTokenEncrypted: null,
        cachedTokenExpiresAt: null,
      });

      expect(result.token).toBe('ghs_fresh');
      expect(result.expiresAt).toBe(new Date(expiresAt).getTime());
      expect(mockRequest).toHaveBeenCalledTimes(1);

      // Verify token was written back to D1
      const row = db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.id, installation.id))
        .get();

      expect(row!.cachedTokenEncrypted).toBeTruthy();
      expect(row!.cachedTokenExpiresAt).toBeTruthy();

      // Verify we can decrypt the cached token
      const decrypted = await decryptStringPBKDF2(row!.cachedTokenEncrypted!, ENCRYPTION_KEY);
      expect(decrypted).toBe('ghs_fresh');
    });

    it('returns cached token when still fresh (no API call)', async () => {
      const { createGitHubApp, getOrMintInstallationToken } = await import('./github-app.js');

      const app = createGitHubApp({
        appId: '99',
        privateKey: 'PEM',
        oauthClientId: 'cid',
        oauthClientSecret: 'csec',
        webhookSecret: 'wsec',
      });

      const installation = await seedInstallation();

      // Pre-populate cache with a token that expires in 30 minutes (well beyond 5min margin)
      const freshExpiry = new Date(Date.now() + 30 * 60_000).toISOString();
      const encryptedToken = await encryptStringPBKDF2('ghs_cached', ENCRYPTION_KEY);

      db.update(githubInstallations)
        .set({
          cachedTokenEncrypted: encryptedToken,
          cachedTokenExpiresAt: freshExpiry,
        })
        .where(eq(githubInstallations.id, installation.id))
        .run();

      const result = await getOrMintInstallationToken(app, db as any, ENCRYPTION_KEY, {
        id: installation.id,
        githubInstallationId: installation.githubInstallationId,
        cachedTokenEncrypted: encryptedToken,
        cachedTokenExpiresAt: freshExpiry,
      });

      expect(result.token).toBe('ghs_cached');
      expect(result.expiresAt).toBe(new Date(freshExpiry).getTime());
      // Should NOT have called the GitHub API
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('re-mints when cached token is within the 5-minute safety margin', async () => {
      const { createGitHubApp, getOrMintInstallationToken } = await import('./github-app.js');

      const newExpiresAt = new Date(Date.now() + 3600_000).toISOString();
      mockRequest.mockResolvedValueOnce({
        data: {
          token: 'ghs_reminted',
          expires_at: newExpiresAt,
        },
      });

      const app = createGitHubApp({
        appId: '99',
        privateKey: 'PEM',
        oauthClientId: 'cid',
        oauthClientSecret: 'csec',
        webhookSecret: 'wsec',
      });

      const installation = await seedInstallation();

      // Pre-populate cache with a token that expires in 3 minutes (within 5min margin)
      const nearExpiry = new Date(Date.now() + 3 * 60_000).toISOString();
      const encryptedToken = await encryptStringPBKDF2('ghs_stale', ENCRYPTION_KEY);

      db.update(githubInstallations)
        .set({
          cachedTokenEncrypted: encryptedToken,
          cachedTokenExpiresAt: nearExpiry,
        })
        .where(eq(githubInstallations.id, installation.id))
        .run();

      const result = await getOrMintInstallationToken(app, db as any, ENCRYPTION_KEY, {
        id: installation.id,
        githubInstallationId: installation.githubInstallationId,
        cachedTokenEncrypted: encryptedToken,
        cachedTokenExpiresAt: nearExpiry,
      });

      expect(result.token).toBe('ghs_reminted');
      expect(mockRequest).toHaveBeenCalledTimes(1);

      // Verify updated row
      const row = db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.id, installation.id))
        .get();

      const decrypted = await decryptStringPBKDF2(row!.cachedTokenEncrypted!, ENCRYPTION_KEY);
      expect(decrypted).toBe('ghs_reminted');
    });

    it('re-mints when cached token is fully expired', async () => {
      const { createGitHubApp, getOrMintInstallationToken } = await import('./github-app.js');

      const newExpiresAt = new Date(Date.now() + 3600_000).toISOString();
      mockRequest.mockResolvedValueOnce({
        data: {
          token: 'ghs_new',
          expires_at: newExpiresAt,
        },
      });

      const app = createGitHubApp({
        appId: '99',
        privateKey: 'PEM',
        oauthClientId: 'cid',
        oauthClientSecret: 'csec',
        webhookSecret: 'wsec',
      });

      const installation = await seedInstallation();

      // Pre-populate cache with a token that expired 10 minutes ago
      const pastExpiry = new Date(Date.now() - 10 * 60_000).toISOString();
      const encryptedToken = await encryptStringPBKDF2('ghs_expired', ENCRYPTION_KEY);

      db.update(githubInstallations)
        .set({
          cachedTokenEncrypted: encryptedToken,
          cachedTokenExpiresAt: pastExpiry,
        })
        .where(eq(githubInstallations.id, installation.id))
        .run();

      const result = await getOrMintInstallationToken(app, db as any, ENCRYPTION_KEY, {
        id: installation.id,
        githubInstallationId: installation.githubInstallationId,
        cachedTokenEncrypted: encryptedToken,
        cachedTokenExpiresAt: pastExpiry,
      });

      expect(result.token).toBe('ghs_new');
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('falls through on corrupt cache and mints fresh', async () => {
      const { createGitHubApp, getOrMintInstallationToken } = await import('./github-app.js');

      const newExpiresAt = new Date(Date.now() + 3600_000).toISOString();
      mockRequest.mockResolvedValueOnce({
        data: {
          token: 'ghs_recovered',
          expires_at: newExpiresAt,
        },
      });

      const app = createGitHubApp({
        appId: '99',
        privateKey: 'PEM',
        oauthClientId: 'cid',
        oauthClientSecret: 'csec',
        webhookSecret: 'wsec',
      });

      const installation = await seedInstallation();

      // Corrupt encrypted data (not valid ciphertext)
      const futureExpiry = new Date(Date.now() + 30 * 60_000).toISOString();

      const result = await getOrMintInstallationToken(app, db as any, ENCRYPTION_KEY, {
        id: installation.id,
        githubInstallationId: installation.githubInstallationId,
        cachedTokenEncrypted: 'not-valid-encrypted-data',
        cachedTokenExpiresAt: futureExpiry,
      });

      expect(result.token).toBe('ghs_recovered');
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });
  });
});
