import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { githubInstallations } from '../lib/schema/github-installations.js';
import {
  upsertGithubInstallation,
  getGithubInstallationByLogin,
} from '../lib/db/github-installations.js';

// ── helpers ────────────────────────────────────────────────────────────────

function makeInstallation(overrides: {
  id: number;
  login: string;
  type: 'Organization' | 'User';
  accountId?: number;
}) {
  return {
    id: overrides.id,
    account: {
      login: overrides.login,
      id: overrides.accountId ?? overrides.id,
      type: overrides.type,
    },
    repository_selection: 'all' as const,
    permissions: { contents: 'read' },
  };
}

function makeApp(installs: ReturnType<typeof makeInstallation>[]) {
  return {
    octokit: {
      paginate: vi.fn().mockResolvedValue(installs),
    },
  } as any;
}

function makeUserOctokit(installs: ReturnType<typeof makeInstallation>[]) {
  return {
    paginate: vi.fn().mockResolvedValue(installs),
  } as any;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('github-installations service', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    vi.resetModules();
  });

  // ── refreshAllInstallations ──────────────────────────────────────────────

  describe('refreshAllInstallations', () => {
    it('upserts org and user installs from paginated response', async () => {
      const { refreshAllInstallations } = await import('./github-installations.js');

      const app = makeApp([
        makeInstallation({ id: 111, login: 'my-org', type: 'Organization' }),
        makeInstallation({ id: 222, login: 'some-user', type: 'User', accountId: 9001 }),
      ]);

      const result = await refreshAllInstallations(app, db as any);

      expect(result.count).toBe(2);
      expect(app.octokit.paginate).toHaveBeenCalledWith('GET /app/installations', expect.anything());

      const orgInstall = await getGithubInstallationByLogin(db as any, 'my-org');
      expect(orgInstall).toBeDefined();
      expect(orgInstall!.githubInstallationId).toBe('111');
      expect(orgInstall!.accountType).toBe('Organization');
      expect(orgInstall!.status).toBe('active');

      const userInstall = await getGithubInstallationByLogin(db as any, 'some-user');
      expect(userInstall).toBeDefined();
      expect(userInstall!.githubInstallationId).toBe('222');
      expect(userInstall!.accountType).toBe('User');
    });

    it('auto-links personal installs by matching account.id to users.githubId', async () => {
      const { refreshAllInstallations } = await import('./github-installations.js');

      // Seed a user whose githubId matches the install's account.id
      const userId = crypto.randomUUID();
      db.insert(users).values({
        id: userId,
        email: 'linked@example.com',
        githubId: '9999',
        githubUsername: 'linked-user',
      }).run();

      const app = makeApp([
        makeInstallation({ id: 333, login: 'linked-user', type: 'User', accountId: 9999 }),
      ]);

      const result = await refreshAllInstallations(app, db as any);

      expect(result.count).toBe(1);

      const install = await getGithubInstallationByLogin(db as any, 'linked-user');
      expect(install).toBeDefined();
      expect(install!.linkedUserId).toBe(userId);
    });
  });

  // ── reconcileUserInstallations ───────────────────────────────────────────

  describe('reconcileUserInstallations', () => {
    it('links orphaned personal install when account.id matches expectedGithubUserId', async () => {
      const { reconcileUserInstallations } = await import('./github-installations.js');

      // Seed an orphaned personal installation
      await upsertGithubInstallation(db as any, {
        githubInstallationId: '444',
        accountLogin: 'orphan-user',
        accountId: '5555',
        accountType: 'User',
        repositorySelection: 'all',
        linkedUserId: null,
      });

      // Seed the valet user
      const userId = crypto.randomUUID();
      db.insert(users).values({
        id: userId,
        email: 'orphan@example.com',
        githubId: '5555',
        githubUsername: 'orphan-user',
      }).run();

      const userOctokit = makeUserOctokit([
        makeInstallation({ id: 444, login: 'orphan-user', type: 'User', accountId: 5555 }),
      ]);

      const result = await reconcileUserInstallations(userOctokit, db as any, userId, '5555');

      expect(result.linked).toBe(1);

      const install = db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.githubInstallationId, '444'))
        .get();
      expect(install!.linkedUserId).toBe(userId);
    });

    it('does NOT link installs for a different GitHub account', async () => {
      const { reconcileUserInstallations } = await import('./github-installations.js');

      // Seed a personal install belonging to a different GitHub user
      await upsertGithubInstallation(db as any, {
        githubInstallationId: '555',
        accountLogin: 'other-user',
        accountId: '8888',
        accountType: 'User',
        repositorySelection: 'all',
        linkedUserId: null,
      });

      // Seed the valet user (different github id)
      const userId = crypto.randomUUID();
      db.insert(users).values({
        id: userId,
        email: 'me@example.com',
        githubId: '1234',
        githubUsername: 'me',
      }).run();

      // Paginate returns an install for a *different* account (8888)
      const userOctokit = makeUserOctokit([
        makeInstallation({ id: 555, login: 'other-user', type: 'User', accountId: 8888 }),
      ]);

      // We tell the reconciler our github user id is 1234
      const result = await reconcileUserInstallations(userOctokit, db as any, userId, '1234');

      expect(result.linked).toBe(0);

      const install = db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.githubInstallationId, '555'))
        .get();
      expect(install!.linkedUserId).toBeNull();
    });
  });

  // ── handleInstallationWebhook ────────────────────────────────────────────

  describe('handleInstallationWebhook', () => {
    it('creates a new installation on "created" event', async () => {
      const { handleInstallationWebhook } = await import('./github-installations.js');

      await handleInstallationWebhook(db as any, {
        action: 'created',
        installation: {
          id: 777,
          account: { login: 'new-org', id: 7070, type: 'Organization' },
          repository_selection: 'selected',
          permissions: { pull_requests: 'write' },
        },
      });

      const install = await getGithubInstallationByLogin(db as any, 'new-org');
      expect(install).toBeDefined();
      expect(install!.githubInstallationId).toBe('777');
      expect(install!.status).toBe('active');
      expect(install!.repositorySelection).toBe('selected');
    });

    it('marks installation as "removed" on "deleted" event', async () => {
      const { handleInstallationWebhook } = await import('./github-installations.js');

      // Seed the installation first
      await upsertGithubInstallation(db as any, {
        githubInstallationId: '888',
        accountLogin: 'to-be-removed',
        accountId: '8080',
        accountType: 'Organization',
        repositorySelection: 'all',
      });

      await handleInstallationWebhook(db as any, {
        action: 'deleted',
        installation: {
          id: 888,
          account: { login: 'to-be-removed', id: 8080, type: 'Organization' },
          repository_selection: 'all',
          permissions: {},
        },
      });

      const install = db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.githubInstallationId, '888'))
        .get();
      expect(install).toBeDefined();
      expect(install!.status).toBe('removed');
    });

    it('toggles status on suspend and unsuspend events', async () => {
      const { handleInstallationWebhook } = await import('./github-installations.js');

      // Seed the installation first
      await upsertGithubInstallation(db as any, {
        githubInstallationId: '999',
        accountLogin: 'suspendable',
        accountId: '9090',
        accountType: 'Organization',
        repositorySelection: 'all',
      });

      // Suspend
      await handleInstallationWebhook(db as any, {
        action: 'suspend',
        installation: {
          id: 999,
          account: { login: 'suspendable', id: 9090, type: 'Organization' },
          repository_selection: 'all',
          permissions: {},
        },
      });

      const suspended = db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.githubInstallationId, '999'))
        .get();
      expect(suspended!.status).toBe('suspended');

      // Unsuspend
      await handleInstallationWebhook(db as any, {
        action: 'unsuspend',
        installation: {
          id: 999,
          account: { login: 'suspendable', id: 9090, type: 'Organization' },
          repository_selection: 'all',
          permissions: {},
        },
      });

      const unsuspended = db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.githubInstallationId, '999'))
        .get();
      expect(unsuspended!.status).toBe('active');
    });

    it('auto-links personal install on "created" when matching user exists', async () => {
      const { handleInstallationWebhook } = await import('./github-installations.js');

      // Seed the user
      const userId = crypto.randomUUID();
      db.insert(users).values({
        id: userId,
        email: 'webhook-user@example.com',
        githubId: '4242',
        githubUsername: 'webhook-user',
      }).run();

      await handleInstallationWebhook(db as any, {
        action: 'created',
        installation: {
          id: 4200,
          account: { login: 'webhook-user', id: 4242, type: 'User' },
          repository_selection: 'all',
          permissions: {},
        },
      });

      const install = await getGithubInstallationByLogin(db as any, 'webhook-user');
      expect(install).toBeDefined();
      expect(install!.linkedUserId).toBe(userId);
    });
  });
});
