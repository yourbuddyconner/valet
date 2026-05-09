import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { users } from '../schema/users.js';
import { orgServiceConfigs } from '../schema/service-configs.js';
import {
  getServiceConfig,
  setServiceConfig,
  getServiceMetadata,
  updateServiceMetadata,
  deleteServiceConfig,
} from './service-configs.js';

// Mock crypto so tests don't depend on Web Crypto API
vi.mock('../crypto.js', () => ({
  encryptString: vi.fn(async (plaintext: string, _key: string) => `enc:${plaintext}`),
  decryptString: vi.fn(async (ciphertext: string, _key: string) => ciphertext.replace(/^enc:/, '')),
}));

const TEST_USER_ID = 'user-svc-001';
const TEST_KEY = 'test-encryption-key';

describe('service-configs DB helpers', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;

    // Insert a user to satisfy FK constraint
    db.insert(users).values({
      id: TEST_USER_ID,
      email: 'test@example.com',
    }).run();
  });

  describe('getServiceConfig', () => {
    it('returns null when no config exists', async () => {
      const result = await getServiceConfig(db as any, TEST_KEY, 'github');
      expect(result).toBeNull();
    });

    it('returns decrypted config and parsed metadata after set', async () => {
      const config = { clientId: 'abc', clientSecret: 'xyz' };
      const metadata = { mode: 'oauth', repos: ['repo1'] };

      await setServiceConfig(db as any, TEST_KEY, 'github', config, metadata, TEST_USER_ID);
      const result = await getServiceConfig(db as any, TEST_KEY, 'github');

      expect(result).not.toBeNull();
      expect(result!.config).toEqual(config);
      expect(result!.metadata).toEqual(metadata);
      expect(result!.configuredBy).toBe(TEST_USER_ID);
      expect(result!.updatedAt).toBeDefined();
    });
  });

  describe('setServiceConfig', () => {
    it('inserts new config with encrypted data', async () => {
      const config = { token: 'secret123' };
      await setServiceConfig(db as any, TEST_KEY, 'slack', config, {}, TEST_USER_ID);

      // Verify the raw row has encrypted data
      const row = db.select().from(orgServiceConfigs).get();
      expect(row).toBeDefined();
      expect(row!.service).toBe('slack');
      expect(row!.encryptedConfig).toBe(`enc:${JSON.stringify(config)}`);
      expect(row!.configuredBy).toBe(TEST_USER_ID);
    });

    it('upserts existing config', async () => {
      await setServiceConfig(db as any, TEST_KEY, 'github', { v: 1 }, { version: 1 }, TEST_USER_ID);
      await setServiceConfig(db as any, TEST_KEY, 'github', { v: 2 }, { version: 2 }, TEST_USER_ID);

      const result = await getServiceConfig(db as any, TEST_KEY, 'github');
      expect(result).not.toBeNull();
      expect(result!.config).toEqual({ v: 2 });
      expect(result!.metadata).toEqual({ version: 2 });
    });
  });

  describe('getServiceMetadata', () => {
    it('returns parsed metadata without decrypting', async () => {
      await setServiceConfig(db as any, TEST_KEY, 'github', { secret: 'x' }, { mode: 'app' }, TEST_USER_ID);

      const meta = await getServiceMetadata(db as any, 'github');
      expect(meta).toEqual({ mode: 'app' });
    });

    it('returns null when no config exists', async () => {
      const meta = await getServiceMetadata(db as any, 'nonexistent');
      expect(meta).toBeNull();
    });
  });

  describe('updateServiceMetadata', () => {
    it('updates metadata without touching encrypted config', async () => {
      await setServiceConfig(db as any, TEST_KEY, 'github', { secret: 'x' }, { mode: 'app' }, TEST_USER_ID);

      await updateServiceMetadata(db as any, 'github', { mode: 'oauth', updated: true });

      const result = await getServiceConfig(db as any, TEST_KEY, 'github');
      expect(result!.config).toEqual({ secret: 'x' });
      expect(result!.metadata).toEqual({ mode: 'oauth', updated: true });
    });
  });

  describe('deleteServiceConfig', () => {
    it('deletes existing config', async () => {
      await setServiceConfig(db as any, TEST_KEY, 'github', { x: 1 }, {}, TEST_USER_ID);

      await deleteServiceConfig(db as any, 'github');

      const result = await getServiceConfig(db as any, TEST_KEY, 'github');
      expect(result).toBeNull();
    });

    it('returns false when not found', async () => {
      const deleted = await deleteServiceConfig(db as any, 'nonexistent');
      expect(deleted).toBe(false);
    });
  });
});
