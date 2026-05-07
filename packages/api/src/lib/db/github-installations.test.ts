import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { githubInstallations } from '../schema/github-installations.js';
import { users } from '../schema/users.js';
import {
  upsertGithubInstallation,
  getGithubInstallationByLogin,
  getGithubInstallationById,
  getGithubInstallationByAccountId,
  listGithubInstallationsByAccountType,
  listGithubInstallationsByUser,
  listAllActiveInstallations,
  updateGithubInstallationStatus,
  updateGithubInstallationAccountLogin,
  linkGithubInstallationToUser,
  deleteGithubInstallationsForAccount,
} from './github-installations.js';

describe('github-installations DB helpers', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
  });

  function seedUser(id = 'user-1', email = 'test@example.com') {
    db.insert(users).values({ id, email, role: 'member' }).run();
  }

  // ── upsertGithubInstallation ──────────────────────────────────────

  it('upsert inserts a new installation', async () => {
    const result = await upsertGithubInstallation(db as any, {
      githubInstallationId: '12345',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    expect(result).toBeDefined();
    expect(result.id).toBeTruthy();
    expect(result.githubInstallationId).toBe('12345');
    expect(result.accountLogin).toBe('my-org');
    expect(result.accountId).toBe('acct-1');
    expect(result.accountType).toBe('Organization');
    expect(result.repositorySelection).toBe('all');
    expect(result.status).toBe('active');
    expect(result.linkedUserId).toBeNull();
  });

  it('upsert existing preserves id and updates fields', async () => {
    const first = await upsertGithubInstallation(db as any, {
      githubInstallationId: '12345',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    const second = await upsertGithubInstallation(db as any, {
      githubInstallationId: '12345',
      accountLogin: 'my-org-renamed',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'selected',
    });

    expect(second.id).toBe(first.id);
    expect(second.accountLogin).toBe('my-org-renamed');
    expect(second.repositorySelection).toBe('selected');

    // Only one row should exist
    const all = db.select().from(githubInstallations).all();
    expect(all).toHaveLength(1);
  });

  it('upsert reinstall sets removed status back to active', async () => {
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '12345',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    // Simulate removal
    await updateGithubInstallationStatus(db as any, '12345', 'removed');

    const removed = await getGithubInstallationById(db as any, '12345');
    expect(removed!.status).toBe('removed');

    // Reinstall
    const reinstalled = await upsertGithubInstallation(db as any, {
      githubInstallationId: '12345',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    expect(reinstalled.status).toBe('active');
  });

  it('upsert preserves existing linkedUserId when input does not provide one', async () => {
    seedUser();

    await upsertGithubInstallation(db as any, {
      githubInstallationId: '12345',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
      linkedUserId: 'user-1',
    });

    // Upsert without linkedUserId
    const updated = await upsertGithubInstallation(db as any, {
      githubInstallationId: '12345',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'selected',
    });

    expect(updated.linkedUserId).toBe('user-1');
  });

  it('upsert stores permissions as JSON string', async () => {
    const perms = { contents: 'write', issues: 'read' };
    const result = await upsertGithubInstallation(db as any, {
      githubInstallationId: '12345',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
      permissions: perms,
    });

    expect(result.permissions).toBe(JSON.stringify(perms));
  });

  // ── getGithubInstallationByLogin ──────────────────────────────────

  it('getByLogin returns only active installations', async () => {
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '12345',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    const active = await getGithubInstallationByLogin(db as any, 'my-org');
    expect(active).toBeDefined();
    expect(active!.accountLogin).toBe('my-org');

    // Mark as removed
    await updateGithubInstallationStatus(db as any, '12345', 'removed');

    const removed = await getGithubInstallationByLogin(db as any, 'my-org');
    expect(removed).toBeUndefined();
  });

  it('getByLogin returns undefined for non-existent login', async () => {
    const result = await getGithubInstallationByLogin(db as any, 'no-such-org');
    expect(result).toBeUndefined();
  });

  // ── getGithubInstallationById ─────────────────────────────────────

  it('getById returns any status (for webhook lookups)', async () => {
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '12345',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    await updateGithubInstallationStatus(db as any, '12345', 'removed');

    const result = await getGithubInstallationById(db as any, '12345');
    expect(result).toBeDefined();
    expect(result!.status).toBe('removed');
  });

  it('getById returns undefined for non-existent id', async () => {
    const result = await getGithubInstallationById(db as any, '99999');
    expect(result).toBeUndefined();
  });

  // ── getGithubInstallationByAccountId ──────────────────────────────

  it('getByAccountId returns matching installation', async () => {
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '12345',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    const result = await getGithubInstallationByAccountId(db as any, 'acct-1');
    expect(result).toBeDefined();
    expect(result!.accountId).toBe('acct-1');
  });

  // ── listGithubInstallationsByAccountType ──────────────────────────

  it('listByAccountType filters correctly', async () => {
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '100',
      accountLogin: 'org-a',
      accountId: 'acct-org-a',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    await upsertGithubInstallation(db as any, {
      githubInstallationId: '200',
      accountLogin: 'user-b',
      accountId: 'acct-user-b',
      accountType: 'User',
      repositorySelection: 'all',
    });

    await upsertGithubInstallation(db as any, {
      githubInstallationId: '300',
      accountLogin: 'org-c',
      accountId: 'acct-org-c',
      accountType: 'Organization',
      repositorySelection: 'selected',
    });

    const orgs = await listGithubInstallationsByAccountType(db as any, 'Organization');
    expect(orgs).toHaveLength(2);
    expect(orgs.map((i) => i.accountLogin).sort()).toEqual(['org-a', 'org-c']);

    const usersResult = await listGithubInstallationsByAccountType(db as any, 'User');
    expect(usersResult).toHaveLength(1);
    expect(usersResult[0].accountLogin).toBe('user-b');
  });

  it('listByAccountType with orphanedOnly filters by null linkedUserId', async () => {
    seedUser();

    await upsertGithubInstallation(db as any, {
      githubInstallationId: '100',
      accountLogin: 'org-a',
      accountId: 'acct-org-a',
      accountType: 'Organization',
      repositorySelection: 'all',
      linkedUserId: 'user-1',
    });

    await upsertGithubInstallation(db as any, {
      githubInstallationId: '200',
      accountLogin: 'org-b',
      accountId: 'acct-org-b',
      accountType: 'Organization',
      repositorySelection: 'all',
      // no linkedUserId — orphaned
    });

    const orphaned = await listGithubInstallationsByAccountType(db as any, 'Organization', { orphanedOnly: true });
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].accountLogin).toBe('org-b');
  });

  // ── listGithubInstallationsByUser ─────────────────────────────────

  it('listByUser returns linked installations', async () => {
    seedUser();

    await upsertGithubInstallation(db as any, {
      githubInstallationId: '100',
      accountLogin: 'org-a',
      accountId: 'acct-org-a',
      accountType: 'Organization',
      repositorySelection: 'all',
      linkedUserId: 'user-1',
    });

    await upsertGithubInstallation(db as any, {
      githubInstallationId: '200',
      accountLogin: 'org-b',
      accountId: 'acct-org-b',
      accountType: 'Organization',
      repositorySelection: 'all',
      // not linked
    });

    const linked = await listGithubInstallationsByUser(db as any, 'user-1');
    expect(linked).toHaveLength(1);
    expect(linked[0].githubInstallationId).toBe('100');
  });

  it('listByUser returns empty array when no linked installations', async () => {
    seedUser();
    const result = await listGithubInstallationsByUser(db as any, 'user-1');
    expect(result).toEqual([]);
  });

  // ── listAllActiveInstallations ────────────────────────────────────

  it('listAllActive returns only active installations', async () => {
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '100',
      accountLogin: 'org-a',
      accountId: 'acct-org-a',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    await upsertGithubInstallation(db as any, {
      githubInstallationId: '200',
      accountLogin: 'org-b',
      accountId: 'acct-org-b',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    await updateGithubInstallationStatus(db as any, '200', 'removed');

    const active = await listAllActiveInstallations(db as any);
    expect(active).toHaveLength(1);
    expect(active[0].githubInstallationId).toBe('100');
  });

  // ── updateGithubInstallationStatus ────────────────────────────────

  it('updateStatus soft-deletes an installation', async () => {
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '12345',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    await updateGithubInstallationStatus(db as any, '12345', 'removed');

    const row = await getGithubInstallationById(db as any, '12345');
    expect(row!.status).toBe('removed');
  });

  // ── updateGithubInstallationAccountLogin ──────────────────────────

  it('updateAccountLogin renames the account login', async () => {
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '12345',
      accountLogin: 'old-name',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    await updateGithubInstallationAccountLogin(db as any, '12345', 'new-name');

    const row = await getGithubInstallationById(db as any, '12345');
    expect(row!.accountLogin).toBe('new-name');
  });

  // ── linkGithubInstallationToUser ──────────────────────────────────

  it('linkToUser sets linkedUserId', async () => {
    seedUser();

    await upsertGithubInstallation(db as any, {
      githubInstallationId: '12345',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    await linkGithubInstallationToUser(db as any, '12345', 'user-1');

    const row = await getGithubInstallationById(db as any, '12345');
    expect(row!.linkedUserId).toBe('user-1');
  });

  // ── deleteGithubInstallationsForAccount ───────────────────────────

  it('deleteForAccount removes all installations for an account', async () => {
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '100',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    await upsertGithubInstallation(db as any, {
      githubInstallationId: '200',
      accountLogin: 'other-org',
      accountId: 'acct-2',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    await deleteGithubInstallationsForAccount(db as any, 'acct-1');

    const all = db.select().from(githubInstallations).all();
    expect(all).toHaveLength(1);
    expect(all[0].accountId).toBe('acct-2');
  });
});
