import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDb } from '../../test-utils/db.js';
import { credentials } from '../schema/credentials.js';
import { orgServiceConfigs } from '../schema/service-configs.js';
import { users } from '../schema/users.js';
import { sql } from 'drizzle-orm';
import { resolveRepoCredential } from './credentials.js';

const TEST_OWNER_TYPE = 'user';
const TEST_OWNER_ID = 'user-test-001';

describe('credentials DB layer', () => {
  let db: ReturnType<typeof createTestDb>['db'];
  let sqlite: ReturnType<typeof createTestDb>['sqlite'];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
  });

  it('inserts and retrieves a credential row', () => {
    db.insert(credentials).values({
      id: 'cred-1',
      ownerType: TEST_OWNER_TYPE,
      ownerId: TEST_OWNER_ID,
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'enc-data-1',
      scopes: 'repo user',
    }).run();

    const row = db
      .select()
      .from(credentials)
      .where(and(eq(credentials.ownerId, TEST_OWNER_ID), eq(credentials.provider, 'github')))
      .get();

    expect(row).toBeDefined();
    expect(row!.id).toBe('cred-1');
    expect(row!.ownerType).toBe('user');
    expect(row!.ownerId).toBe(TEST_OWNER_ID);
    expect(row!.provider).toBe('github');
    expect(row!.credentialType).toBe('oauth2');
    expect(row!.encryptedData).toBe('enc-data-1');
    expect(row!.scopes).toBe('repo user');
    expect(row!.createdAt).toBeDefined();
    expect(row!.updatedAt).toBeDefined();
  });

  it('upserts on conflict (same owner+provider+credentialType)', () => {
    db.insert(credentials).values({
      id: 'cred-1',
      ownerType: TEST_OWNER_TYPE,
      ownerId: TEST_OWNER_ID,
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'original',
    }).run();

    db.insert(credentials).values({
      id: 'cred-2',
      ownerType: TEST_OWNER_TYPE,
      ownerId: TEST_OWNER_ID,
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'updated',
    }).onConflictDoUpdate({
      target: [credentials.ownerType, credentials.ownerId, credentials.provider, credentials.credentialType],
      set: {
        encryptedData: sql`excluded.encrypted_data`,
        updatedAt: sql`datetime('now')`,
      },
    }).run();

    const rows = db.select().from(credentials)
      .where(and(eq(credentials.ownerType, TEST_OWNER_TYPE), eq(credentials.ownerId, TEST_OWNER_ID)))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].encryptedData).toBe('updated');
  });

  it('deletes a credential', () => {
    db.insert(credentials).values({
      id: 'cred-1',
      ownerType: TEST_OWNER_TYPE,
      ownerId: TEST_OWNER_ID,
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'data',
    }).run();

    db.delete(credentials)
      .where(and(eq(credentials.ownerType, TEST_OWNER_TYPE), eq(credentials.ownerId, TEST_OWNER_ID), eq(credentials.provider, 'github')))
      .run();

    const row = db
      .select()
      .from(credentials)
      .where(and(eq(credentials.ownerId, TEST_OWNER_ID), eq(credentials.provider, 'github')))
      .get();

    expect(row).toBeUndefined();
  });

  it('lists credentials by owner', () => {
    db.insert(credentials).values([
      { id: 'cred-1', ownerType: TEST_OWNER_TYPE, ownerId: TEST_OWNER_ID, provider: 'github', credentialType: 'oauth2', encryptedData: 'a' },
      { id: 'cred-2', ownerType: TEST_OWNER_TYPE, ownerId: TEST_OWNER_ID, provider: 'google', credentialType: 'oauth2', encryptedData: 'b' },
    ]).run();

    const rows = db
      .select({
        provider: credentials.provider,
        credentialType: credentials.credentialType,
        scopes: credentials.scopes,
        expiresAt: credentials.expiresAt,
        createdAt: credentials.createdAt,
        updatedAt: credentials.updatedAt,
      })
      .from(credentials)
      .where(and(eq(credentials.ownerType, TEST_OWNER_TYPE), eq(credentials.ownerId, TEST_OWNER_ID)))
      .all();

    expect(rows).toHaveLength(2);
    const providers = rows.map((r) => r.provider).sort();
    expect(providers).toEqual(['github', 'google']);
  });

  it('hasCredential returns true when credential exists', () => {
    db.insert(credentials).values({
      id: 'cred-1',
      ownerType: TEST_OWNER_TYPE,
      ownerId: TEST_OWNER_ID,
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'data',
    }).run();

    const row = db
      .select({ id: credentials.id })
      .from(credentials)
      .where(and(eq(credentials.ownerType, TEST_OWNER_TYPE), eq(credentials.ownerId, TEST_OWNER_ID), eq(credentials.provider, 'github')))
      .get();

    expect(!!row).toBe(true);
  });

  it('hasCredential returns false when no credential exists', () => {
    const row = db
      .select({ id: credentials.id })
      .from(credentials)
      .where(and(eq(credentials.ownerType, TEST_OWNER_TYPE), eq(credentials.ownerId, TEST_OWNER_ID), eq(credentials.provider, 'nonexistent')))
      .get();

    expect(!!row).toBe(false);
  });

  it('enforces unique constraint on owner_type+owner_id+provider+credential_type', () => {
    db.insert(credentials).values({
      id: 'cred-1',
      ownerType: TEST_OWNER_TYPE,
      ownerId: TEST_OWNER_ID,
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'data-1',
    }).run();

    expect(() => {
      db.insert(credentials).values({
        id: 'cred-2',
        ownerType: TEST_OWNER_TYPE,
        ownerId: TEST_OWNER_ID,
        provider: 'github',
        credentialType: 'oauth2',
        encryptedData: 'data-2',
      }).run();
    }).toThrow();
  });

  it('allows same provider with different credential types', () => {
    db.insert(credentials).values({
      id: 'cred-1',
      ownerType: TEST_OWNER_TYPE,
      ownerId: TEST_OWNER_ID,
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'data-1',
    }).run();

    db.insert(credentials).values({
      id: 'cred-2',
      ownerType: TEST_OWNER_TYPE,
      ownerId: TEST_OWNER_ID,
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'data-2',
    }).run();

    const rows = db.select().from(credentials)
      .where(and(eq(credentials.ownerId, TEST_OWNER_ID), eq(credentials.provider, 'github')))
      .all();

    expect(rows).toHaveLength(2);
  });

  it('allows same provider for different owner types', () => {
    db.insert(credentials).values({
      id: 'cred-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'user-data',
    }).run();

    db.insert(credentials).values({
      id: 'cred-2',
      ownerType: 'org',
      ownerId: 'org-1',
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'org-data',
    }).run();

    const rows = db.select().from(credentials).all();
    expect(rows).toHaveLength(2);
  });
});

describe('resolveRepoCredential', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;

    // Insert a user row for foreign key constraints on orgServiceConfigs
    db.insert(users).values({
      id: 'admin',
      email: 'admin@test.com',
      role: 'admin',
    }).run();
  });

  it('returns user OAuth when available (highest priority)', async () => {
    db.insert(credentials).values({
      id: 'cred-oauth',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'oauth-data',
    }).run();
    db.insert(credentials).values({
      id: 'cred-app',
      ownerType: 'org',
      ownerId: 'org-1',
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'app-data',
    }).run();

    const result = await resolveRepoCredential(db as any, 'github', undefined, 'org-1', 'user-1');

    expect(result).not.toBeNull();
    expect(result!.credentialType).toBe('oauth2');
    expect(result!.credential.id).toBe('cred-oauth');
  });

  it('returns org App install when no user OAuth exists', async () => {
    db.insert(credentials).values({
      id: 'cred-app',
      ownerType: 'org',
      ownerId: 'org-1',
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'app-data',
    }).run();

    const result = await resolveRepoCredential(db as any, 'github', undefined, 'org-1', 'user-1');

    expect(result).not.toBeNull();
    expect(result!.credentialType).toBe('app_install');
    expect(result!.credential.id).toBe('cred-app');
  });

  it('returns null when only user-level app_install exists (no user OAuth or org install)', async () => {
    db.insert(credentials).values({
      id: 'cred-user-app',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'user-app-data',
    }).run();

    const result = await resolveRepoCredential(db as any, 'github', undefined, 'org-1', 'user-1');

    expect(result).toBeNull();
  });

  it('returns null when no credentials exist', async () => {
    const result = await resolveRepoCredential(db as any, 'github', undefined, 'org-1', 'user-1');
    expect(result).toBeNull();
  });

  it('returns null when no orgId provided and only app_install credentials exist', async () => {
    db.insert(credentials).values({
      id: 'cred-org-app',
      ownerType: 'org',
      ownerId: 'org-1',
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'org-data',
    }).run();
    db.insert(credentials).values({
      id: 'cred-user-app',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'user-data',
    }).run();

    // No orgId → skip org lookup, user app_install no longer consulted
    const result = await resolveRepoCredential(db as any, 'github', undefined, undefined, 'user-1');

    expect(result).toBeNull();
  });

  it('prefers user OAuth over org App install even when both exist', async () => {
    db.insert(credentials).values({
      id: 'cred-oauth',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'oauth-data',
    }).run();
    db.insert(credentials).values({
      id: 'cred-org-app',
      ownerType: 'org',
      ownerId: 'org-1',
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'app-data',
    }).run();
    db.insert(credentials).values({
      id: 'cred-user-app',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'user-app-data',
    }).run();

    const result = await resolveRepoCredential(db as any, 'github', undefined, 'org-1', 'user-1');

    expect(result!.credentialType).toBe('oauth2');
    expect(result!.credential.id).toBe('cred-oauth');
  });

  it('uses org App when repoOwner matches org App accessibleOwners', async () => {
    db.insert(credentials).values({
      id: 'cred-org-app',
      ownerType: 'org',
      ownerId: 'org-1',
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'org-app-data',
    }).run();

    // Insert org service config with accessibleOwners metadata
    db.insert(orgServiceConfigs).values({
      service: 'github',
      encryptedConfig: 'encrypted',
      metadata: JSON.stringify({ accessibleOwners: ['my-org', 'other-org'] }),
      configuredBy: 'admin',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    const result = await resolveRepoCredential(db as any, 'github', 'my-org', 'org-1', 'user-1');

    expect(result).not.toBeNull();
    expect(result!.credentialType).toBe('app_install');
    expect(result!.credential.id).toBe('cred-org-app');
  });

  it('returns null when repoOwner does not match any installation accessibleOwners', async () => {
    db.insert(credentials).values({
      id: 'cred-org-app',
      ownerType: 'org',
      ownerId: 'org-1',
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'org-app-data',
    }).run();

    db.insert(orgServiceConfigs).values({
      service: 'github',
      encryptedConfig: 'encrypted',
      metadata: JSON.stringify({ accessibleOwners: ['other-org'] }),
      configuredBy: 'admin',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    db.insert(credentials).values({
      id: 'cred-user-app',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'user-app-data',
      metadata: JSON.stringify({ accessibleOwners: ['user-personal-org'] }),
    }).run();

    const result = await resolveRepoCredential(db as any, 'github', 'unknown-org', 'org-1', 'user-1');

    expect(result).toBeNull();
  });

  it('returns null when only user-level app_install covers repoOwner (no org install)', async () => {
    db.insert(credentials).values({
      id: 'cred-user-app',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'user-app-data',
      metadata: JSON.stringify({ accessibleOwners: ['user-personal-org'] }),
    }).run();

    const result = await resolveRepoCredential(db as any, 'github', 'user-personal-org', undefined, 'user-1');

    expect(result).toBeNull();
  });

  it('OAuth token wins regardless of repoOwner', async () => {
    db.insert(credentials).values({
      id: 'cred-oauth',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'oauth-data',
    }).run();

    db.insert(credentials).values({
      id: 'cred-org-app',
      ownerType: 'org',
      ownerId: 'org-1',
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'org-app-data',
    }).run();

    db.insert(orgServiceConfigs).values({
      service: 'github',
      encryptedConfig: 'encrypted',
      metadata: JSON.stringify({ accessibleOwners: ['my-org'] }),
      configuredBy: 'admin',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    const result = await resolveRepoCredential(db as any, 'github', 'my-org', 'org-1', 'user-1');

    expect(result!.credentialType).toBe('oauth2');
    expect(result!.credential.id).toBe('cred-oauth');
  });

  it('falls back to old behavior when repoOwner is undefined', async () => {
    db.insert(credentials).values({
      id: 'cred-org-app',
      ownerType: 'org',
      ownerId: 'org-1',
      provider: 'github',
      credentialType: 'app_install',
      encryptedData: 'org-app-data',
    }).run();

    // No service config needed — repoOwner is undefined, so old behavior applies
    const result = await resolveRepoCredential(db as any, 'github', undefined, 'org-1', 'user-1');

    expect(result).not.toBeNull();
    expect(result!.credentialType).toBe('app_install');
    expect(result!.credential.id).toBe('cred-org-app');
  });
});
