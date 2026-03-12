import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDb } from '../../test-utils/db.js';
import { credentials } from '../schema/credentials.js';
import { sql } from 'drizzle-orm';

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
